import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { MessageWorkflowParams } from "@/slack/types";
import { buildDispatchId, type JoinOutcome } from "@/a2a/dispatch";
import { postReply } from "@/wrappers/slack";
import {
  createAgentTask,
  updateAgentTaskTaskId,
  deleteAgentTask,
  isCancelRequested,
  type AgentTaskRow
} from "@/db/models/agent-tasks";
import { parkTask, wakeTask } from "@/workflows/reaction-helpers";
import {
  type AgentPlan,
  type TaskOutcome,
  replyThreadTs,
  startedBy,
  resolveMessage,
  dispatchMessage,
  collectIfEventDrained,
  cancelAndReconcile,
  cancelNotHonoredText,
  ensureStopReaction,
  handleUnreachable,
  joinMessage,
  openTasksFor
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
        cancelAndReconcile(plan.agent, result.taskId, token, p.channelId)
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
 * Send a message onto an agent's open task. A parked task is woken first, so
 * the turn's first callbacks find it working, and parked again if the message
 * is not taken. One whose retries ran out may have been taken or not: the
 * thread is told the agent could not be reached, and no task is started with
 * it, which could run it twice.
 */
async function joinTask(
  step: WorkflowStep,
  p: MessageWorkflowParams,
  plan: AgentPlan,
  row: Pick<AgentTaskRow, "token" | "taskId" | "eventId">
): Promise<JoinOutcome | "undelivered"> {
  const name = plan.agent.name;
  const woke = await step.do(`wake:${name}`, () => wakeTask(row.token));
  let outcome: JoinOutcome | "undelivered";
  try {
    outcome = await step.do(`join:${name}`, () => joinMessage(p, plan, row));
  } catch (err) {
    outcome = "undelivered";
    await handleUnreachable(
      step,
      p,
      replyThreadTs(p),
      name,
      err instanceof Error ? err.message : String(err)
    );
  }
  if (outcome !== "joined" && woke) {
    await step.do(`repark:${name}`, () => parkTask(row.token, row.eventId));
  }
  return outcome;
}

/**
 * Durable workflow for Slack messages dispatched to agents. One instance per
 * Slack `event_id`, handling every woken agent (local built-in and remote
 * custom) for that event.
 *
 * An agent that already has a task open in the message's thread is sent the
 * message onto that task: it joins the conversation the task is having, and
 * gets no row, no 🛑 and no budget of its own. Only an agent with none, or one
 * that refuses the join, starts a task here.
 *
 * All agents accept the turn and deliver status snapshots asynchronously:
 * built-ins through a trusted in-process push sender, remotes through the
 * authenticated `/a2a/notifications` callback. The 🛑 reaction lingers until the
 * *last* pending task of the fan-out is terminal — `collectIfEventDrained` at the
 * end here (and in every terminal delivery) clears it only when nothing is left.
 * If an agent never delivers, the ReactionWorkflow cancels it once its processing
 * budget (its agent's `task_deadline_seconds`, which defaults to
 * `DEFAULT_TASK_DEADLINE_SECONDS`) runs out, so the 🛑 always drains eventually.
 *
 * Steps: `resolve` → `route` → per joining agent `wake` + `join` (+ `repark`)
 * → (`ensure-reaction` when the handler gave no 🛑) → one `record-tasks`
 * (every row up front, before any dispatch) → per opening agent
 * `guard-cancel` + `dispatch` + `update-task` (+ `honor-cancel`) →
 * `collect-reaction`.
 */
export class MessageWorkflow extends WorkflowEntrypoint<
  Env,
  MessageWorkflowParams
> {
  async run(event: WorkflowEvent<MessageWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    const threadTs = replyThreadTs(p);

    try {
      const resolved = await step.do("resolve", () => resolveMessage(p));

      // Joins go first, all of them, so a join refused still opens its task
      // before any dispatch: every row is recorded up front either way.
      const open = await step.do("route", () => openTasksFor(p, resolved));
      const plans: AgentPlan[] = [];
      for (const [i, plan] of resolved.entries()) {
        const row = open[i];
        if (!row || (await joinTask(step, p, plan, row)) === "refused") {
          plans.push(plan);
        }
      }

      // The handler gave the 🛑 on what it saw a moment earlier: a task can
      // open or close in between, and a join can be refused.
      if (plans.length === 0) {
        if (p.stopped) {
          await step.do("collect-reaction", () =>
            collectIfEventDrained(p.eventId)
          );
        }
        return;
      }
      if (!p.stopped) {
        try {
          await step.do("ensure-reaction", () => ensureStopReaction(p));
        } catch (err) {
          // Its retries ran out. The tasks start without a deadline rather
          // than not at all.
          console.error("[message] could not give the message its 🛑", {
            eventId: p.eventId,
            err: err instanceof Error ? err.message : String(err)
          });
        }
      }

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
            eventId: p.eventId,
            // Who an approval this task later raises should mention, if anyone.
            startedBy: startedBy(p)
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
