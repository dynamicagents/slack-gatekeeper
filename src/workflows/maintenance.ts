import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { sweepStaleAgentTasks } from "@/db/models/agent-tasks";
import {
  expireStaleHitlRequests,
  sweepStaleHitlRequests
} from "@/db/models/hitl-requests";
import { markHitlPromptResolved } from "@/a2a/notifications/hitl";
import { timeoutAgentTask } from "@/a2a/dispatch";

type MaintenanceWorkflowPayload = Record<string, never>;

/**
 * Expire human-in-the-loop prompts past their TTL: flip each open row to
 * `expired`, update its Slack prompt to an expired state, and signal a timeout
 * back onto its A2A task so the agent can finalize. Per-row failures are caught
 * so one bad row never aborts the batch (the flip already happened, so a retry
 * would skip the rest). Old resolved rows are then swept to bound the table.
 */
async function expireHitlRequests(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expired = await expireStaleHitlRequests(now);
  for (const row of expired) {
    try {
      await markHitlPromptResolved(
        row,
        "⏳ This prompt expired — no response was received."
      );
      await timeoutAgentTask(row);
    } catch (err) {
      console.error("[maintenance] failed to finalize expired HITL prompt", {
        requestId: row.requestId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  await sweepStaleHitlRequests();
}

export class MaintenanceWorkflow extends WorkflowEntrypoint<
  Env,
  MaintenanceWorkflowPayload
> {
  async run(
    event: WorkflowEvent<MaintenanceWorkflowPayload>,
    step: WorkflowStep
  ) {
    try {
      // Drop stale remote-agent task rows. The reaction backstop already clears
      // the 🛑 for tasks that never called back, so these rows are pure
      // correlation records — sweep old ones so the table stays bounded.
      await step.do("sweep-agent-tasks", () => sweepStaleAgentTasks());

      // Expire human-in-the-loop prompts past their 7-day TTL (update Slack +
      // signal the task), then sweep old resolved rows.
      await step.do("expire-hitl-requests", () => expireHitlRequests());
    } catch (err) {
      console.error("[maintenance] workflow run failed", {
        instanceId: event.instanceId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      throw err;
    }
  }
}
