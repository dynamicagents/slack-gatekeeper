import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { CancelWorkflowParams } from "@/slack/types";
import { getPendingAgentTasksByChannelAndTs } from "@/db/models/agent-tasks";
import { postReply } from "@/wrappers/slack";
import {
  cancelTaskRow,
  cancelNotHonoredText,
  collectIfEventDrained,
  type CancelRowResult
} from "@/workflows/message-helpers";

/**
 * Durable workflow for a 🛑 stop reaction. One instance per reaction `event_id`.
 * Looks up every non-terminal task the reacted trigger message woke (the fan-out)
 * and cancels them all via A2A `tasks/cancel`, then drains the 🛑 reaction and posts
 * a short confirmation. Idempotent: the row terminalization and the reaction collect
 * are both no-ops on replay.
 *
 * The cancelling itself lives in `cancelTaskRow`, shared with the ReactionWorkflow's
 * processing-deadline cancel — this workflow is just the human-triggered entry point,
 * which is why it passes the reactor's user id as the origin.
 */
export class CancelWorkflow extends WorkflowEntrypoint<
  Env,
  CancelWorkflowParams
> {
  async run(event: WorkflowEvent<CancelWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    try {
      const rows = await step.do("resolve-tasks", () =>
        getPendingAgentTasksByChannelAndTs(p.channelId, p.ts)
      );
      if (rows.length === 0) return; // nothing in flight for this message

      const results: CancelRowResult[] = [];
      for (const row of rows) {
        results.push(
          await step.do(`cancel:${row.token}`, () =>
            cancelTaskRow(row, { reason: "user", actorUserId: p.userId })
          )
        );
      }

      await step.do("finalize", async () => {
        const threadTs = rows[0].replyThreadTs;
        const stopped = results.filter((r) => r.kind === "stopped");
        // `unsupported` and `error` both mean the agent may run on to completion,
        // so the user hears the same thing for either — its reply is discarded
        // regardless, since the row is already terminal.
        const notHonored = results.filter((r) => r.kind !== "stopped");

        // App-branded gatekeeper notices (null username), never an agent reply.
        if (stopped.length > 0) {
          await postReply(p.channelId, threadTs, "🛑 Stopped.", null, null);
        }
        for (const r of notHonored) {
          await postReply(
            p.channelId,
            threadTs,
            cancelNotHonoredText(r.agentName),
            null,
            null
          );
        }

        // Clear the 🛑 for each affected trigger event once its fan-out drained.
        // (Rows share the trigger event_id; dedupe defensively.)
        for (const eid of [...new Set(rows.map((r) => r.eventId))]) {
          await collectIfEventDrained(eid);
        }
      });
    } catch (err) {
      console.error("[cancel] workflow run failed", {
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
