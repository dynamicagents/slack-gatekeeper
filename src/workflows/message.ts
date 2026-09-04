import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { MessageWorkflowParams } from "@/slack/types";
import { buildDispatchId } from "@/agents/dispatch";
import { postReply } from "@/wrappers/slack";
import {
  createAgentTask,
  updateAgentTaskTaskId,
  deleteAgentTask,
  isCancelRequested
} from "@/db/models/agent-tasks";
import {
  type AgentPlan,
  type TaskOutcome,
  replyThreadTs,
  resolveMessage,
  dispatchMessage,
  collectIfEventDrained,
  cancelAndReconcile,
  cancelNotHonoredText,
  handleUnreachable
} from "@/workflows/message-helpers";

/**
 * Dispatch one plan (local built-in or remote custom) and handle its task
 * acceptance. Both kinds accept a Task and deliver their reply asynchronously —
 * built-ins through the trusted in-process push sender, remotes through the
 * authenticated `/a2a/notifications` callback. Routing by `agent.kind` lives
 * entirely in `dispatchToAgent`, so this path is identical for both.
 *
 * The correlation rows are written by a single `record-tasks` step *before* any
 * dispatch (see {@link MessageWorkflow.run}), so a status update can never outrun
 * the record that routes it — and a fast terminal callback can never see an
 * incomplete sibling set and clear the 🛑 early. `token` is that pre-written row.
 *
 * Two checkpoints honor a 🛑 that arrives while this dispatch is in flight:
 *   1. pre-dispatch guard — if a stop was already recorded, skip the send
 *      entirely (never wake the agent);
 *   2. post-accept honor — if a stop landed during the send, `tasks/cancel` the
 *      now-known taskId (the atomic `updateAgentTaskTaskId` reports it). The row
 *      goes terminal either way: an agent that can't be canceled may run on, but
 *      its reply is dropped at the notification boundary rather than posted.
 */
async function runAgentTask(
  step: WorkflowStep,
  p: MessageWorkflowParams,
  plan: AgentPlan,
  threadTs: string | null,
  token: string
): Promise<TaskOutcome> {
  // Pre-dispatch guard: a 🛑 already flagged this task → never contact the agent.
  const guardCanceled = await step.do(`guard-cancel:${plan.agent.name}`, () =>
    isCancelRequested(token)
  );
  if (guardCanceled) {
    await step.do(`skip-canceled:${plan.agent.name}`, () =>
      deleteAgentTask(token)
    );
    return { kind: "done" };
  }

  let result;
  try {
    result = await step.do(`dispatch:${plan.agent.name}`, () =>
      dispatchMessage(p, plan)
    );
  } catch (err) {
    await step.do(`unrecord-task:${plan.agent.name}`, () =>
      deleteAgentTask(token)
    );
    return {
      kind: "unreachable",
      error: err instanceof Error ? err.message : String(err)
    };
  }

  if (result.kind === "accepted") {
    // Backfill the taskId and atomically learn whether a 🛑 landed mid-send.
    const cancelRequested = await step.do(
      `update-task:${plan.agent.name}`,
      () => updateAgentTaskTaskId(token, result.taskId)
    );
    if (cancelRequested) {
      const stop = await step.do(`honor-cancel:${plan.agent.name}`, () =>
        cancelAndReconcile(plan.agent, result.taskId, token)
      );
      if (stop === "stopped") return { kind: "done" };

      // The agent won't (or couldn't be asked to) stop, so it may run on — but its
      // row is already terminal and its callback will be dropped. Say so: the
      // CancelWorkflow raced ahead of the taskId and already reported the intent as
      // stopped, so this notice is the only correction the user gets.
      await step.do(`cancel-not-honored:${plan.agent.name}`, () =>
        postReply(
          p.channelId,
          threadTs,
          cancelNotHonoredText(plan.agent.name),
          null,
          null
        )
      );
      // `done`, not `accepted`: nothing is still owed to this thread, so the 🛑
      // should drain now rather than linger waiting for a reply we'd discard.
      return { kind: "done" };
    }
    return { kind: "accepted" };
  }

  // A non-accepted dispatch cannot emit task updates, so remove the prewritten
  // correlation row before surfacing its gatekeeper-controlled error to the user.
  await step.do(`unrecord-task:${plan.agent.name}`, () =>
    deleteAgentTask(token)
  );

  // The only non-accepted outcome is a gatekeeper-controlled error reply: an agent
  // that failed to acknowledge the task, an endpoint rejected by policy, or a
  // deterministic A2A protocol refusal (the agent answered with a JSON-RPC error
  // naming what it won't do). All three are verdicts rather than faults, so they
  // arrive as a returned result instead of a throw and never reach the retry
  // path above. Post it so the user isn't left in silence.
  try {
    if (result.text.trim()) {
      await step.do(`error-reply:${plan.agent.name}`, () =>
        postReply(p.channelId, threadTs, result.text, null, null)
      );
    }
    return { kind: "done" };
  } catch (err) {
    return {
      kind: "internal_error",
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Durable workflow for Slack messages dispatched to agents. One instance per
 * Slack `event_id`, handling every woken agent (local built-in and remote
 * custom) for that event.
 *
 * All agents accept the turn and deliver status snapshots asynchronously:
 * built-ins through a trusted in-process push sender, remotes through the
 * authenticated `/a2a/notifications` callback. The 🛑 reaction lingers until the
 * *last* pending task of the fan-out is terminal — `collectIfEventDrained` at the
 * end here (and in every terminal delivery) clears it only when nothing is left.
 * If an agent never delivers, the ReactionWorkflow cancels it once its processing
 * budget (`TASK_DEADLINE_SECONDS`) runs out, so the 🛑 always drains eventually.
 *
 * Steps: `resolve` → one `record-tasks` (all rows up front) → per agent
 * `guard-cancel` + `dispatch` + `update-task` (+ `honor-cancel`) → `collect`.
 */
export class MessageWorkflow extends WorkflowEntrypoint<
  Env,
  MessageWorkflowParams
> {
  async run(event: WorkflowEvent<MessageWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    const threadTs = replyThreadTs(p);

    try {
      const plans = await step.do("resolve", () => resolveMessage(p));

      // Record every fan-out row up front (before any dispatch) so a fast
      // terminal callback can't observe an incomplete sibling set and drain the
      // 🛑 early. Deterministic tokens keep this idempotent under step retries.
      const tokens = await step.do("record-tasks", async () => {
        const out: string[] = [];
        for (const plan of plans) {
          const token = await buildDispatchId(p.eventId, plan.agent);
          await createAgentTask({
            token,
            taskId: null,
            agentName: plan.agent.name,
            channelId: p.channelId,
            messageTs: p.ts,
            replyThreadTs: threadTs,
            eventId: p.eventId
          });
          out.push(token);
        }
        return out;
      });

      const results = await Promise.allSettled(
        plans.map((plan, i) => runAgentTask(step, p, plan, threadTs, tokens[i]))
      );

      for (const [i, r] of results.entries()) {
        const plan = plans[i];
        if (r.status === "rejected") {
          console.error("[message] agent task threw unexpectedly", {
            agent: plan.agent.name,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason)
          });
          continue;
        }

        const outcome = r.value;
        if (outcome.kind === "unreachable") {
          await handleUnreachable(
            step,
            p,
            threadTs,
            plan.agent.name,
            outcome.error
          );
        } else if (outcome.kind === "internal_error") {
          console.error("[message] agent reply step failed", {
            agent: plan.agent.name,
            error: outcome.error
          });
        }
      }

      // Clear the 🛑 only when no agent is still working. A pending accepted task
      // keeps it alive until its push-notification delivery (or the
      // ReactionWorkflow backstop) drains the fan-out and removes it.
      await step.do("collect-reaction", () => collectIfEventDrained(p.eventId));
    } catch (err) {
      console.error("[message] workflow run failed", {
        instanceId: event.instanceId,
        eventId: p.eventId,
        channelId: p.channelId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      throw err;
    }
  }
}
