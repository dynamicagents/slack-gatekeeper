import { inputRequestToSlackBlocks } from "@chat-adapter/slack/blocks";
import { HITL_REQUEST_TTL_SECONDS } from "@/config";
import { agentRenderIdentity, type AgentRow } from "@/db/models/agents";
import { suspendForInput, type AgentTaskRow } from "@/db/models/agent-tasks";
import {
  createHitlRequest,
  getHitlRequest,
  setHitlSlackMessageTs,
  type HitlRequestRow
} from "@/db/models/hitl-requests";
import { sanitizeAgentReply } from "@/a2a/client";
import {
  toSlackInputRequest,
  type HitlRequest,
  type HitlOption
} from "@/a2a/hitl";
import type { TaskSnapshot } from "@/a2a/snapshot";
import { postBlocks, postReply, updateBlocks } from "@/wrappers/slack";

/** Sanitize an agent-authored option (label/description are untrusted output). */
function sanitizeOption(option: HitlOption): HitlOption {
  return {
    ...option,
    label: sanitizeAgentReply(option.label),
    description: option.description
      ? sanitizeAgentReply(option.description)
      : undefined
  };
}

/**
 * Render a human-in-the-loop prompt to Slack and park the task.
 *
 * Called from the delivery boundary when an `input-required` snapshot carries a
 * HITL request data part. Sanitizes the agent's prompt/options (Block Kit text never
 * passes through slackifyMarkdown), persists the request keyed by `requestId`
 * (idempotent — a redelivered push does not double-post), suspends the paired
 * `agent_tasks` row (so the fan-out stays undrained and stray callbacks no-op),
 * then posts the interactive message and records its ts for later updates.
 */
export async function deliverHitlRequest(
  token: string,
  row: AgentTaskRow,
  agent: AgentRow,
  snapshot: TaskSnapshot,
  req: HitlRequest
): Promise<void> {
  const sanitized: HitlRequest = {
    ...req,
    prompt: sanitizeAgentReply(req.prompt),
    options: req.options?.map(sanitizeOption)
  };
  const slackReq = toSlackInputRequest(sanitized);
  const optionsJson = JSON.stringify(slackReq.options ?? []);

  // Idempotent create is the dedup guard: an at-least-once push redelivery of the
  // same input-required update returns `created: false` and skips re-posting.
  const created = await createHitlRequest({
    requestId: req.requestId,
    token,
    taskId: snapshot.taskId,
    contextId: snapshot.contextId,
    agentName: row.agentName,
    channelId: row.channelId,
    threadTs: row.replyThreadTs,
    requestKind: sanitized.requestKind,
    promptText: sanitized.prompt,
    optionsJson,
    allowFreeform: sanitized.allowFreeform ?? false,
    deadlineAt: Math.floor(Date.now() / 1000) + HITL_REQUEST_TTL_SECONDS
  });

  if (!created) {
    // A duplicate — unless a prior attempt created the row but crashed before it
    // could post (no ts recorded). Recover that one case; otherwise it is a true
    // redelivery of an already-shown prompt.
    const existing = await getHitlRequest(req.requestId);
    if (
      !existing ||
      existing.status !== "awaiting" ||
      existing.slackMessageTs
    ) {
      return;
    }
  }

  // Park the task (pending → awaiting-input): non-terminal, so 🛑 still cancels
  // and the fan-out doesn't drain. When we recorded this request fresh but the
  // park matched no `pending` row, a terminal callback or a 🛑 completed the task
  // between the boundary's `row` snapshot and here — it can no longer be resumed,
  // so don't post an unanswerable prompt. (A `created`-false re-post is the
  // crash-recovery path, whose task was already parked, so a false park there is
  // expected — let it re-post.)
  const parked = await suspendForInput(token);
  if (created && !parked) return;

  const { displayName, iconUrl } = await agentRenderIdentity(
    agent,
    row.channelId
  );
  const ts = await postBlocks({
    channelId: row.channelId,
    threadTs: row.replyThreadTs,
    blocks: inputRequestToSlackBlocks(slackReq),
    text: sanitized.prompt,
    username: displayName,
    iconUrl
  });
  if (ts) await setHitlSlackMessageTs(req.requestId, ts);
}

/** Blocks that show a prompt in a resolved (expired/canceled) state under a note. */
function resolvedHitlBlocks(promptText: string, note: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: promptText } },
    { type: "context", elements: [{ type: "mrkdwn", text: note }] }
  ];
}

/**
 * Update a HITL prompt's Slack message to a resolved state (its buttons removed),
 * e.g. "expired" or "canceled". No-op if the prompt was never posted (no ts).
 * Best-effort: a failed update is logged, never thrown — the row is already
 * terminal in D1, so the resolution stands regardless of the cosmetic update.
 */
export async function markHitlPromptResolved(
  row: HitlRequestRow,
  note: string
): Promise<void> {
  if (!row.slackMessageTs) return;
  try {
    await updateBlocks({
      channelId: row.channelId,
      ts: row.slackMessageTs,
      blocks: resolvedHitlBlocks(row.promptText, note),
      text: note
    });
  } catch (err) {
    console.error("[hitl] failed to update resolved prompt", {
      requestId: row.requestId,
      err: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Post a thread notice that a parked task could not be handed back to its agent:
 * the continuation was not accepted (the agent is unreachable or broke the A2A
 * contract), so the task will not resume. Mirrors how a *fresh* dispatch surfaces
 * a non-accept to the user (the MessageWorkflow error-reply path) — a parked task
 * deserves the same visibility so the user knows to fix the agent. Any recorded
 * answer still stands; only the handoff failed. Posted under the gatekeeper's own
 * identity, not the agent's — the agent is the thing that's broken. Best-effort: a
 * failed post is logged, never thrown.
 *
 * `detail` is a gatekeeper-authored sentence naming an actual A2A verdict the agent
 * returned. Without one we fall back to "looks unreachable", which is only an
 * inference — so it must not be stated when the agent demonstrably answered.
 */
export async function notifyHitlContinuationFailed(
  row: HitlRequestRow,
  detail?: string
): Promise<void> {
  const text = detail
    ? `⚠️ Couldn't continue this task. ${detail}`
    : `⚠️ Couldn't reach *${row.agentName}* to continue this task — the agent looks unreachable. Please check the agent.`;
  try {
    await postReply(row.channelId, row.threadTs, text, null, null);
  } catch (err) {
    console.error("[hitl] failed to post continuation-failure notice", {
      requestId: row.requestId,
      err: err instanceof Error ? err.message : String(err)
    });
  }
}
