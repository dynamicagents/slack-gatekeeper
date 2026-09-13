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
  reopenHitlRequest,
  type HitlRequestRow
} from "@/db/models/hitl-requests";
import { optionLabel, type HitlAnswerChoice } from "@/a2a/hitl";
import {
  markHitlPromptResolved,
  TASK_ENDED_NOTE
} from "@/a2a/notifications/hitl";
import { resumeAgentTask, type ResumeOutcome } from "@/agents/dispatch";
import { postEphemeral, updateBlocks, openView } from "@/wrappers/slack";
import { isRecord } from "@/util/json";

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
 * The `block_id` of the one line the gatekeeper adds to a prompt about its
 * answer — on its way, or didn't arrive. Fixed, so each new line replaces the
 * last instead of stacking under it when the same prompt fails more than once.
 */
const DELIVERY_NOTE_BLOCK_ID = "hitl-delivery-note";

/** Longest answer label quoted in a delivery note; a typed answer can be long. */
const MAX_NOTE_LABEL_CHARS = 200;

/** Longest typed answer handed back to its author for pasting in again. */
const MAX_RETURNED_ANSWER_CHARS = 30_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function blockField(block: unknown, key: string): unknown {
  return isRecord(block) ? block[key] : undefined;
}

/** A prompt's blocks with the gatekeeper's delivery note, if any, taken out. */
function withoutDeliveryNote(blocks: readonly unknown[]): unknown[] {
  return blocks.filter(
    (b) => blockField(b, "block_id") !== DELIVERY_NOTE_BLOCK_ID
  );
}

function deliveryNote(text: string): unknown {
  return {
    type: "context",
    block_id: DELIVERY_NOTE_BLOCK_ID,
    elements: [{ type: "mrkdwn", text }]
  };
}

/**
 * The prompt while its answer is being sent: as it was, minus every control
 * (buttons, radios, selects and "Type your answer" are all `actions` blocks), plus
 * a note saying whose answer is on its way.
 */
function sendingBlocks(blocks: readonly unknown[], note: string): unknown[] {
  return [
    ...withoutDeliveryNote(blocks).filter(
      (b) => blockField(b, "type") !== "actions"
    ),
    deliveryNote(note)
  ];
}

/** The prompt put back exactly as it was clicked, plus a note saying why. */
function reopenedBlocks(blocks: readonly unknown[], note: string): unknown[] {
  return [...withoutDeliveryNote(blocks), deliveryNote(note)];
}

/**
 * Record a human's answer to a HITL prompt and resume the task. First-click-wins
 * via the atomic claim: a losing racer (or a click on an already-resolved prompt)
 * gets an ephemeral notice instead.
 *
 * Slack shows nothing once a click is acknowledged, so every sign of progress is
 * an update we make. When the click carried the prompt's blocks, the prompt loses
 * its controls and says the answer is on its way while it is sent; a typed answer
 * arrives from a modal, which carries none, so its prompt is left alone.
 *
 * Only once the agent has accepted (or refused) does the prompt show the answered
 * state. If the answer never got there, the claim is undone and the prompt comes
 * back as it was clicked, with a note — or, with no blocks to put back, its author
 * is told privately, with what they typed.
 */
async function answerHitl(
  requestId: string,
  input: HitlAnswerChoice & { answeredBy: string },
  clickedBlocks?: readonly unknown[]
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
  const noteLabel = clip(label, MAX_NOTE_LABEL_CHARS);
  const ts = claimed.slackMessageTs;
  const blocks = ts ? clickedBlocks : undefined;

  // Not awaited before the send: it is cosmetic, and the send is what the
  // `waitUntil` budget is for. Awaited before the final update, so it can never
  // land on top of it — but only after anything durable, since a Slack call has
  // no timeout of its own and a hung one must not strand the answer.
  const sending =
    ts && blocks
      ? updateBlocks({
          channelId: claimed.channelId,
          ts,
          blocks: sendingBlocks(
            blocks,
            `⏳ Sending <@${input.answeredBy}>'s answer: *${noteLabel}*…`
          ),
          text: `Sending: ${noteLabel}`
        }).catch((err: unknown) => {
          console.error("[hitl] failed to show the answer as sending", {
            requestId,
            err: err instanceof Error ? err.message : String(err)
          });
        })
      : undefined;

  // Spread rather than re-listing the two fields: rebuilding them by hand loses
  // the union's narrowing and lets an answer with neither back through.
  const outcome: ResumeOutcome = await resumeAgentTask(claimed, {
    ...input,
    humanText: label
  }).catch((err: unknown) => {
    console.error("[hitl] resume failed before any verdict", {
      requestId,
      err: err instanceof Error ? err.message : String(err)
    });
    return "undelivered" as const;
  });

  if (outcome === "undelivered" && (await reopenHitlRequest(requestId))) {
    await sending;
    await offerAnswerAgain(claimed, input, noteLabel, blocks);
    return;
  }
  await sending;

  // Delivered, refused (the answer stands, and the thread has been told), or
  // never delivered to a task that has since ended. Either way someone answered,
  // and the prompt must stop offering controls.
  if (ts) {
    try {
      await updateBlocks({
        channelId: claimed.channelId,
        ts,
        blocks: answeredSlackInputBlocks({
          answer: label,
          promptBlock: promptSectionBlock(claimed),
          userId: input.answeredBy
        }),
        text: `Answered: ${label}`
      });
    } catch (err) {
      // Cosmetic — the answer is recorded whether or not the prompt says so.
      console.error("[hitl] failed to update answered prompt", {
        requestId,
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

/**
 * Tell people a re-opened prompt needs answering again. On the prompt itself when
 * the click's blocks can be put back; otherwise — a typed answer, or a failed
 * update — privately to whoever answered, with their typed text so it is not lost.
 */
async function offerAnswerAgain(
  row: HitlRequestRow,
  input: HitlAnswerChoice & { answeredBy: string },
  noteLabel: string,
  blocks: readonly unknown[] | undefined
): Promise<void> {
  if (row.slackMessageTs && blocks) {
    try {
      await updateBlocks({
        channelId: row.channelId,
        ts: row.slackMessageTs,
        blocks: reopenedBlocks(
          blocks,
          `⚠️ <@${input.answeredBy}>'s answer (*${noteLabel}*) didn't reach *${row.agentName}* — please answer again.`
        ),
        text: row.promptText
      });
      await closeIfEndedMeanwhile(row.requestId);
      return;
    } catch (err) {
      console.error("[hitl] failed to re-open prompt", {
        requestId: row.requestId,
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const failed = `didn't reach *${row.agentName}*, so the question is open again — please answer again.`;
  try {
    await postEphemeral({
      channelId: row.channelId,
      userId: input.answeredBy,
      threadTs: row.threadTs,
      text: input.text
        ? `⚠️ Your answer ${failed} What you wrote:\n${clip(input.text, MAX_RETURNED_ANSWER_CHARS)}`
        : `⚠️ Your answer (*${noteLabel}*) ${failed}`
    });
  } catch (err) {
    console.error("[hitl] failed to tell the answerer to answer again", {
      requestId: row.requestId,
      err: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Undo a restore that lost a race with the task ending.
 *
 * Between re-opening the row and restoring its controls, a final status or a 🛑
 * can close the task's open prompts — this one included — and write the closed
 * state first, which the restore would then paint over with live controls. Read
 * after writing, so whichever order the two landed in, the closed state is last.
 */
async function closeIfEndedMeanwhile(requestId: string): Promise<void> {
  const row = await getHitlRequest(requestId);
  if (row?.status === "canceled") {
    await markHitlPromptResolved(row, TASK_ENDED_NOTE);
  }
}

/** Handle a button/select/radio click, or a "Something else…" freeform button. */
async function handleBlockActions(
  payload: SlackBlockActionsPayload
): Promise<void> {
  for (const action of payload.actions) {
    // A fixed-option answer (button, static_select, or radio).
    const parsed = parseSlackInputResponse(action);
    if (parsed?.optionId) {
      await answerHitl(
        parsed.requestId,
        { optionId: parsed.optionId, answeredBy: payload.userId },
        payload.messageBlocks
      );
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
