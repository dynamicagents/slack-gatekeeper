import { TaskState } from "@a2a-js/sdk";
import { agentRenderIdentity, type AgentRow } from "@/db/models/agents";
import {
  completeAgentTask,
  recordReceivedMessageId,
  type AgentTaskRow
} from "@/db/models/agent-tasks";
import { isTerminalTaskState, taskStateLabel } from "@/a2a/parts";
import { snapshotText, type TaskSnapshot } from "@/a2a/snapshot";
import { sanitizeAgentReply } from "@/a2a/client";
import { parseHitlRequest } from "@/a2a/hitl";
import { deliverHitlRequest } from "@/a2a/notifications/hitl";
import { postReply } from "@/wrappers/slack";
import { collectIfEventDrained } from "@/workflows/message-helpers";

/** A malformed task snapshot that is safe to report to a task's owner. */
export class TaskDeliveryValidationError extends Error {}

/**
 * What the user sees when an agent ends a turn in a failure state (`failed` or
 * `rejected`). The marker is gatekeeper-authored and prefixed; `text`, when present,
 * is the agent's own already-sanitized message.
 *
 * A2A v1.0 has no structured task-level error — `TaskStatus` is only
 * `{state, message, timestamp}` — so a failing agent's sole way to explain itself
 * is prose in `status.message`, which is byte-identical in shape to a successful
 * reply. Without this marker a failure reads as a normal answer, which is exactly
 * how a well-behaved agent's `failed` task used to render.
 */
function terminalFailureText(
  agentName: string,
  state: string,
  text: string
): string {
  return text
    ? `⚠️ *Agent ${agentName}* (${state}):\n${text}`
    : `*Agent ${agentName}* ended without a reply (state: ${state}). If you were expecting an answer, please contact the agent developer.`;
}

/**
 * Deliver one trusted task snapshot through the durable task ledger. Each
 * notification boundary authenticates and validates its caller before invoking
 * this function, and normalizes whatever `StreamResponse` shape it received
 * into a {@link TaskSnapshot} first; the agent's text is sanitized here
 * regardless of boundary, since even a built-in agent relays untrusted model
 * output.
 */
export async function deliverTaskToSlack(
  token: string,
  row: AgentTaskRow,
  agent: AgentRow,
  snapshot: TaskSnapshot
): Promise<void> {
  const state = snapshot.state;
  const text = sanitizeAgentReply(snapshotText(snapshot));
  // Resolved per delivery rather than carried from dispatch, so a rename or a
  // regenerated avatar mid-turn takes effect on the reply it produced. Deferred
  // until we know we are posting: most status updates are deduplicated or empty,
  // and for the admin agent this resolution costs extra config reads.
  const renderIdentity = () => agentRenderIdentity(agent, row.channelId);

  // Human-in-the-loop: an `input-required` update carrying a HITL request
  // DataPart is rendered as an interactive Slack prompt and the task is parked
  // awaiting a human answer (see deliverHitlRequest). An `input-required` update
  // *without* a HITL request falls through to the plain-text path below (posted
  // as a normal reply, row stays pending) — same as any other non-terminal state.
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
    const hitl = parseHitlRequest(snapshot.statusMessage);
    if (hitl) {
      await deliverHitlRequest(token, row, agent, snapshot, hitl);
      return;
    }
  }

  if (!isTerminalTaskState(state)) {
    const updateId = snapshot.statusMessage?.messageId;
    if (!updateId) {
      throw new TaskDeliveryValidationError(
        "non-terminal task updates must include a status.message.messageId; the gatekeeper uses this to deduplicate at-least-once delivery"
      );
    }

    const isNew = await recordReceivedMessageId(token, updateId);
    if (isNew && text) {
      const { displayName, iconUrl } = await renderIdentity();
      await postReply(
        row.channelId,
        row.replyThreadTs,
        text,
        displayName,
        iconUrl
      );
    }
    return;
  }

  // A stop is an outcome the user chose, not a failure to explain — and the
  // cancel workflow already posted "🛑 Stopped." Treat `canceled` like
  // `completed` and stay silent; only real failures get the notice.
  const isChosenOutcome =
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_CANCELED;

  // Post before completion so a delivery failure leaves the row pending for a
  // retry. A replay after completion becomes a no-op at the boundary.
  if (text || !isChosenOutcome) {
    const { displayName, iconUrl } = await renderIdentity();
    await postReply(
      row.channelId,
      row.replyThreadTs,
      isChosenOutcome
        ? text
        : terminalFailureText(displayName, taskStateLabel(state), text),
      displayName,
      iconUrl
    );
  }

  // Clear the 🛑 only when this was the last pending task of the fan-out; other
  // agents woken by the same trigger message may still be working.
  if (await completeAgentTask(token)) {
    await collectIfEventDrained(row.eventId);
  }
}
