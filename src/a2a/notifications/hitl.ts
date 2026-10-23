import { HITL_REQUEST_TTL_SECONDS } from "@/config";
import { agentRenderIdentity, type AgentRow } from "@/db/models/agents";
import {
  getAgentTaskByToken,
  isTerminalTaskStatus,
  suspendForInput,
  type AgentTaskRow
} from "@/db/models/agent-tasks";
import type { HitlOption, HitlQuestion } from "@dynamicagents/g2a-protocol";
import {
  cancelHitlForm,
  cancelHitlFormsByToken,
  createHitlForm,
  getHitlForm,
  setHitlFormMessageTs,
  type HitlFormRow
} from "@/db/models/hitl-forms";
import { sanitizeAgentReply } from "@/a2a/client";
import type { HitlRequest } from "@/a2a/hitl";
import type { TaskSnapshot } from "@/a2a/snapshot";
import {
  requestBlocks,
  requestFallbackText,
  resolvedBlocks
} from "@/slack/hitl/render";
import {
  postBlocks,
  postReply,
  slackErrorFields,
  updateBlocks
} from "@/wrappers/slack";

/** `text`, sanitized, when there is any: every string an agent wrote is untrusted. */
function sanitized(text: string | undefined): string | undefined {
  return text === undefined ? undefined : sanitizeAgentReply(text);
}

function sanitizeOption(option: HitlOption): HitlOption {
  return {
    ...option,
    label: sanitizeAgentReply(option.label),
    ...(option.description
      ? { description: sanitized(option.description) }
      : {}),
    ...(option.example ? { example: sanitized(option.example) } : {})
  };
}

function sanitizeQuestion(question: HitlQuestion): HitlQuestion {
  const base = {
    ...question,
    prompt: sanitizeAgentReply(question.prompt),
    ...(question.header ? { header: sanitized(question.header) } : {})
  };
  switch (base.kind) {
    case "choice":
      return { ...base, options: base.options.map(sanitizeOption) };
    case "approval":
      return {
        ...base,
        artifact: {
          ...base.artifact,
          url: sanitizeAgentReply(base.artifact.url)
        }
      };
    case "text":
      return base;
  }
}

/**
 * Render a human-in-the-loop form to Slack, and park the task when `park` says
 * its agent has nothing left but its questions to wait on.
 *
 * Called from the delivery boundary when a non-terminal snapshot carries a HITL
 * request data part. A task may have any number open, each its own form,
 * answered on its own. Sanitizes the agent's prompt/options before they are
 * stored or shown, persists the request keyed by `requestId` (idempotent: a
 * redelivered push does not double-post), then posts the interactive message
 * and records its ts for later updates.
 */
export async function deliverHitlRequest(
  token: string,
  row: AgentTaskRow,
  agent: AgentRow,
  snapshot: TaskSnapshot,
  req: HitlRequest,
  options: { park: boolean }
): Promise<void> {
  const request: HitlRequest = {
    ...req,
    ...(req.prompt ? { prompt: sanitized(req.prompt) } : {}),
    questions: req.questions.map(sanitizeQuestion)
  };

  // Idempotent create is the dedup guard: an at-least-once push redelivery of the
  // same input-required update returns `created: false` and skips re-posting.
  const created = await createHitlForm({
    requestId: req.requestId,
    token,
    taskId: snapshot.taskId,
    contextId: snapshot.contextId,
    agentName: row.agentName,
    channelId: row.channelId,
    threadTs: row.replyThreadTs,
    request,
    deadlineAt: Math.floor(Date.now() / 1000) + HITL_REQUEST_TTL_SECONDS
  });

  if (!created) {
    // A duplicate — unless a prior attempt created the row but crashed before it
    // could post (no ts recorded). Recover that one case; otherwise it is a true
    // redelivery of an already-shown prompt.
    const existing = await getHitlForm(req.requestId);
    if (
      !existing ||
      existing.status !== "awaiting" ||
      existing.slackMessageTs
    ) {
      return;
    }
  }

  // A task finished, or stopped by a 🛑, between the boundary's `row` snapshot
  // and here can no longer be answered, so the prompt is not posted. Not posting
  // still leaves the form just created `awaiting`, and a week from now the
  // expiry sweep would send a timeout for a question nobody was shown, so this
  // form alone is closed: a finished task's other prompts were closed by the
  // delivery that finished it.
  const current = await getAgentTaskByToken(token);
  if (!current || isTerminalTaskStatus(current.status)) {
    if (created) await cancelHitlForm(req.requestId);
    return;
  }
  // Park the task (pending → awaiting-input) when its agent is idle on its
  // questions: non-terminal, so 🛑 still cancels and the fan-out doesn't drain.
  if (options.park) await suspendForInput(token);

  const { displayName, iconUrl } = await agentRenderIdentity(
    agent,
    row.channelId
  );
  const ts = await postBlocks({
    channelId: row.channelId,
    threadTs: row.replyThreadTs,
    // `row.startedBy` is whoever sent the message that woke the agent, so a form
    // asking for an approval mentions the person who started the task. A task no
    // person started carries a sentinel instead — a feed turn, or a row written
    // before the column existed — which renders as no mention at all.
    blocks: requestBlocks(request, row.startedBy),
    text: requestFallbackText(request, row.startedBy),
    username: displayName,
    iconUrl
  });
  if (ts) await setHitlFormMessageTs(req.requestId, ts);
}

/**
 * Update a HITL prompt's Slack message to a resolved state (its buttons removed),
 * e.g. "expired" or "canceled". No-op if the prompt was never posted (no ts).
 * Best-effort: a failed update is logged, never thrown — the row is already
 * terminal in D1, so the resolution stands regardless of the cosmetic update.
 */
export async function markHitlPromptResolved(
  row: HitlFormRow,
  note: string
): Promise<void> {
  if (!row.slackMessageTs) return;
  try {
    await updateBlocks({
      channelId: row.channelId,
      ts: row.slackMessageTs,
      blocks: resolvedBlocks(row.requestJson, note),
      text: note
    });
  } catch (err) {
    console.error("[hitl] failed to update resolved prompt", {
      requestId: row.requestId,
      ...slackErrorFields(err)
    });
  }
}

/** The note on a prompt closed because its task ended on the agent's own terms. */
export const TASK_ENDED_NOTE =
  "⏹️ Closed — the task ended before anyone answered.";

/**
 * Close every prompt a task still has open, because the task is over and an answer
 * could no longer resume it. Whoever ended it — a 🛑, or the agent reaching a final
 * status of its own — is the caller's concern; `note` is what the prompt says why.
 *
 * A prompt left `awaiting` on a finished task is not merely stale. Its buttons stay
 * live, and a click claims the answer and sends it to an agent that must refuse a
 * continuation on a terminal task. So does the expiry sweep, a week later. Both
 * then warn the thread that the task couldn't be continued, pinning it on an agent
 * that did nothing wrong.
 *
 * Idempotent: only rows still `awaiting` are closed and only those get their Slack
 * message updated, so a retry of the caller repeats nothing a person would see.
 */
export async function closeOpenHitlPrompts(
  token: string,
  note: string
): Promise<void> {
  const closed = await cancelHitlFormsByToken(token);
  for (const prompt of closed) {
    await markHitlPromptResolved(prompt, note);
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
  row: HitlFormRow,
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
