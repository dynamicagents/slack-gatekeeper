import {
  verifySlackRequest,
  parseSlackWebhookBody,
  SlackWebhookVerificationError
} from "@chat-adapter/slack/webhook";
import type {
  SlackBlockActionsPayload,
  SlackViewSubmissionPayload
} from "@chat-adapter/slack/webhook";
import {
  parseSlackInputResponse,
  answeredSlackInputBlocks,
  buildSlackFreeformView,
  parseSlackFreeformValue,
  SLACK_FREEFORM_ACTION_PREFIX,
  SLACK_FREEFORM_BLOCK_ID,
  SLACK_FREEFORM_CALLBACK_ID
} from "@chat-adapter/slack/blocks";
import { MAX_MESSAGE_TEXT_BYTES } from "@dynamicagents/g2a-protocol";
import type { SlackInputOption } from "@chat-adapter/slack/blocks";
import { env } from "cloudflare:workers";
import { guardTeamId } from "@/slack-webhook-handler";
import {
  getHitlRequest,
  claimHitlAnswer,
  type HitlRequestRow
} from "@/db/models/hitl-requests";
import { optionLabel, type HitlAnswerChoice } from "@/a2a/hitl";
import { resumeAgentTask } from "@/agents/dispatch";
import { postEphemeral, updateBlocks, openView } from "@/wrappers/slack";

const OK = () => new Response("ok", { status: 200 });

/** Parse the stored options JSON back into the rendered option set (or []). */
function optionsOf(row: HitlRequestRow): SlackInputOption[] {
  if (!row.optionsJson) return [];
  try {
    const parsed: unknown = JSON.parse(row.optionsJson);
    return Array.isArray(parsed) ? (parsed as SlackInputOption[]) : [];
  } catch {
    return [];
  }
}

/** Ephemeral notice text when a click lands on a prompt that is no longer open. */
function alreadyResolvedText(row: HitlRequestRow): string {
  switch (row.status) {
    case "answered":
      return row.answeredBy
        ? `That was already answered by <@${row.answeredBy}>.`
        : "That was already answered.";
    case "expired":
      return "That prompt has expired.";
    case "canceled":
      return "That prompt is closed — its task has already ended.";
    default:
      return "That prompt is no longer open.";
  }
}

/** Re-render the original prompt above the answered state, so context survives. */
function promptSectionBlock(row: HitlRequestRow): unknown {
  return { type: "section", text: { type: "mrkdwn", text: row.promptText } };
}

/**
 * Record a human's answer to a HITL prompt and resume the task. First-click-wins
 * via the atomic claim: a losing racer (or a click on an already-resolved prompt)
 * gets an ephemeral notice instead. On a win, the Slack prompt is updated to an
 * answered state and the answer is sent back onto the paused A2A task.
 */
async function answerHitl(
  requestId: string,
  input: HitlAnswerChoice & { answeredBy: string }
): Promise<void> {
  const claimed = await claimHitlAnswer(requestId, {
    answeredBy: input.answeredBy,
    optionId: input.optionId,
    text: input.text
  });

  if (!claimed) {
    const row = await getHitlRequest(requestId);
    if (row) {
      await postEphemeral({
        channelId: row.channelId,
        userId: input.answeredBy,
        threadTs: row.threadTs,
        text: alreadyResolvedText(row)
      });
    }
    return;
  }

  const label =
    optionLabel(optionsOf(claimed), input.optionId) ??
    input.text ??
    input.optionId ??
    "answered";

  // Swap the live buttons for a resolved state (chat.update by stored ts).
  if (claimed.slackMessageTs) {
    try {
      await updateBlocks({
        channelId: claimed.channelId,
        ts: claimed.slackMessageTs,
        blocks: answeredSlackInputBlocks({
          answer: label,
          promptBlock: promptSectionBlock(claimed),
          userId: input.answeredBy
        }),
        text: `Answered: ${label}`
      });
    } catch (err) {
      // Cosmetic — never block the resume on a failed message update.
      console.error("[hitl] failed to update answered prompt", {
        requestId,
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Spread rather than re-listing the two fields: rebuilding them by hand loses
  // the union's narrowing and lets an answer with neither back through.
  await resumeAgentTask(claimed, { ...input, humanText: label });
}

/** Handle a button/select/radio click, or a "Something else…" freeform button. */
async function handleBlockActions(
  payload: SlackBlockActionsPayload
): Promise<void> {
  for (const action of payload.actions) {
    // A fixed-option answer (button, static_select, or radio).
    const parsed = parseSlackInputResponse(action);
    if (parsed?.optionId) {
      await answerHitl(parsed.requestId, {
        optionId: parsed.optionId,
        answeredBy: payload.userId
      });
      continue;
    }

    // The freeform "Something else…" button → open the typed-answer modal.
    if (action.actionId.startsWith(SLACK_FREEFORM_ACTION_PREFIX)) {
      const requestId =
        action.value ??
        action.actionId.slice(SLACK_FREEFORM_ACTION_PREFIX.length);
      if (!payload.triggerId) continue;
      const row = await getHitlRequest(requestId);
      if (!row || row.status !== "awaiting") {
        if (row) {
          await postEphemeral({
            channelId: row.channelId,
            userId: payload.userId,
            threadTs: row.threadTs,
            text: alreadyResolvedText(row)
          });
        }
        continue;
      }
      try {
        await openView(
          payload.triggerId,
          buildSlackFreeformView({
            metadata: requestId,
            prompt: row.promptText,
            title: "Your answer"
          })
        );
      } catch (err) {
        console.error("[hitl] failed to open freeform modal", {
          requestId,
          err: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
}

const encoder = new TextEncoder();

/**
 * Refuse a typed answer the far end would refuse anyway — on the request path,
 * while Slack is still listening.
 *
 * The agent runtime bounds the text of an inbound message at
 * {@link MAX_MESSAGE_TEXT_BYTES} and rejects anything past it. Left to
 * {@link handleViewSubmission}, which runs in `ctx.waitUntil` *after* the
 * response is sent, that rejection lands too late to matter: the prompt has
 * already been claimed and marked answered, so the person's answer is gone, the
 * question cannot be asked again, and there is nothing to retry.
 *
 * Checked here, the same text is a correctable mistake. `response_action:
 * "errors"` keeps the modal open with what they wrote still in it, the prompt is
 * never claimed, and they can shorten it and submit again. Measuring is
 * synchronous, so moving it on-path costs no I/O against the 3s ack budget.
 *
 * Returns the refusal response, or `undefined` to carry on.
 */
function overlongFreeformAnswer(
  payload: SlackViewSubmissionPayload
): Response | undefined {
  if (payload.callbackId !== SLACK_FREEFORM_CALLBACK_ID) return undefined;
  const text = payload.values
    ? parseSlackFreeformValue(payload.values)
    : undefined;
  // Trimmed, because that is what gets sent and therefore what gets measured —
  // see the constant's own doc for the rest of the algorithm.
  const trimmed = text?.trim();
  if (
    !trimmed ||
    encoder.encode(trimmed).byteLength <= MAX_MESSAGE_TEXT_BYTES
  ) {
    return undefined;
  }
  return Response.json({
    response_action: "errors",
    errors: {
      [SLACK_FREEFORM_BLOCK_ID]:
        "That answer is too long to send — please shorten it."
    }
  });
}

/** Handle a freeform-modal submission (the typed "Something else…" answer). */
async function handleViewSubmission(
  payload: SlackViewSubmissionPayload
): Promise<void> {
  if (payload.callbackId !== SLACK_FREEFORM_CALLBACK_ID) return;
  const requestId = payload.privateMetadata;
  if (!requestId) return;
  const text = payload.values
    ? parseSlackFreeformValue(payload.values)
    : undefined;
  if (!text || !text.trim()) return;
  await answerHitl(requestId, {
    text: text.trim(),
    answeredBy: payload.userId
  });
}

/**
 * Slack Interactivity ingress (Request URL → `/slack/interactivity`). Verifies
 * the signature and team anchor exactly like the events handler, then routes
 * HITL interactions. All work runs off-path in `ctx.waitUntil` so Slack gets its
 * ack inside the 3s budget; a `view_submission` returns an empty 200 to close the
 * modal. Non-HITL interactive payloads are acked and ignored.
 */
export async function handleSlackInteractivity(
  request: Request,
  ctx: ExecutionContext
): Promise<Response> {
  let rawBody: string;
  try {
    rawBody = await verifySlackRequest(request, {
      signingSecret: env.SLACK_SIGNING_SECRET
    });
  } catch (err) {
    if (err instanceof SlackWebhookVerificationError) {
      return new Response("Invalid signature", { status: 401 });
    }
    throw err;
  }

  const payload = parseSlackWebhookBody(rawBody, { headers: request.headers });

  if (payload.kind === "block_actions") {
    const guard = await guardTeamId(payload.teamId);
    if (guard) return guard;
    ctx.waitUntil(handleBlockActions(payload));
    return OK();
  }

  if (payload.kind === "view_submission") {
    const guard = await guardTeamId(payload.teamId);
    if (guard) return guard;
    const tooLong = overlongFreeformAnswer(payload);
    if (tooLong) return tooLong;
    ctx.waitUntil(handleViewSubmission(payload));
    // An empty 200 tells Slack to close the modal.
    return new Response(null, { status: 200 });
  }

  // block_suggestion, view_closed, slash_command, etc. — acked and ignored.
  return OK();
}
