import {
  verifySlackRequest,
  parseSlackWebhookBody,
  SlackWebhookVerificationError
} from "@chat-adapter/slack/webhook";
import type {
  SlackBlockActionsPayload,
  SlackViewSubmissionPayload
} from "@chat-adapter/slack/webhook";
import { env } from "cloudflare:workers";
import { guardTeamId } from "@/slack-webhook-handler";
import {
  getHitlForm,
  claimHitlAnswer,
  reopenHitlForm,
  type HitlFormRow
} from "@/db/models/hitl-forms";
import { answersText } from "@/a2a/hitl";
import {
  markHitlPromptResolved,
  TASK_ENDED_NOTE
} from "@/a2a/notifications/hitl";
import {
  resumeAgentTask,
  type HitlSubmission,
  type ResumeOutcome
} from "@/a2a/dispatch";
import {
  answeredBlocks,
  answeredFallbackBlocks,
  fallbackText,
  formView,
  FORM_CALLBACK_ID,
  requestFallbackText
} from "@/slack/hitl/render";
import {
  formAnswers,
  formErrors,
  pickAnswers,
  readControl
} from "@/slack/hitl/answer";
import {
  postEphemeral,
  updateBlocks,
  openView,
  slackErrorFields
} from "@/wrappers/slack";
import { isRecord } from "@/util/json";

const OK = () => new Response("ok", { status: 200 });

/** Ephemeral notice text when a click lands on a prompt that is no longer open. */
function alreadyResolvedText(row: HitlFormRow): string {
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

/**
 * The `block_id` of the one line the gatekeeper adds to a prompt about its
 * answer — on its way, or didn't arrive. Fixed, so each new line replaces the
 * last instead of stacking under it when the same prompt fails more than once.
 */
const DELIVERY_NOTE_BLOCK_ID = "hitl-delivery-note";

/** Longest answer label quoted in a delivery note; a typed answer can be long. */
const MAX_NOTE_LABEL_CHARS = 200;

/** Longest typed answers handed back to their author for pasting in again. */
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
 * (all in `actions` blocks), plus a note saying whose answer is on its way.
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
 * Record a person's answers to a HITL prompt and resume the task. First-answer-
 * wins via the atomic claim: a losing racer (or a click on an already-resolved
 * prompt) gets an ephemeral notice instead.
 *
 * Slack shows nothing once a click is acknowledged, so every sign of progress is
 * an update we make. When the click carried the prompt's blocks, the prompt loses
 * its controls and says the answer is on its way while it is sent; answers from a
 * modal carry none, so their prompt is left alone.
 *
 * Only once the agent has accepted (or refused) does the prompt show the answered
 * state. If the answers never got there, the claim is undone and the prompt comes
 * back as it was clicked, with a note — or, with no blocks to put back, its author
 * is told privately, with what they typed.
 */
async function answerHitl(
  requestId: string,
  input: HitlSubmission,
  clickedBlocks?: readonly unknown[]
): Promise<void> {
  const claimed = await claimHitlAnswer(requestId, input);

  if (!claimed) {
    const row = await getHitlForm(requestId);
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

  const label = answersText(claimed.requestJson, input.answers) || "answered";
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
            ...slackErrorFields(err)
          });
        })
      : undefined;

  const outcome: ResumeOutcome = await resumeAgentTask(claimed, input).catch(
    (err: unknown) => {
      console.error("[hitl] resume failed before any verdict", {
        requestId,
        err: err instanceof Error ? err.message : String(err)
      });
      return "undelivered" as const;
    }
  );

  if (outcome === "undelivered" && (await reopenHitlForm(requestId))) {
    await sending;
    await offerAnswerAgain(claimed, input, noteLabel, blocks);
    return;
  }
  await sending;

  // Delivered, refused (the answer stands, and the thread has been told), or
  // never delivered to a task that has since ended. Either way someone answered,
  // and the prompt must stop offering controls.
  if (ts) await showAnswered(claimed, ts, input, label);
}

/**
 * Put a prompt in its answered state. Should Slack still refuse it, the prompt
 * falls back to a bare "answered by" line rather than keep live controls that
 * would claim an answer already sent.
 */
async function showAnswered(
  row: HitlFormRow,
  ts: string,
  input: HitlSubmission,
  label: string
): Promise<void> {
  const text = fallbackText(`Answered: ${label}`);
  try {
    await updateBlocks({
      channelId: row.channelId,
      ts,
      blocks: answeredBlocks({ request: row.requestJson, ...input }),
      text
    });
    return;
  } catch (err) {
    // Cosmetic — the answer is recorded whether or not the prompt says so.
    console.error("[hitl] failed to update answered prompt", {
      requestId: row.requestId,
      ...slackErrorFields(err)
    });
  }
  try {
    await updateBlocks({
      channelId: row.channelId,
      ts,
      blocks: answeredFallbackBlocks(input.answeredBy),
      text
    });
  } catch (err) {
    console.error("[hitl] failed to mark the prompt answered", {
      requestId: row.requestId,
      ...slackErrorFields(err)
    });
  }
}

/**
 * Tell people a re-opened prompt needs answering again. On the prompt itself when
 * the click's blocks can be put back; otherwise — a typed answer, or a failed
 * update — privately to whoever answered, with their typed text so it is not lost.
 */
async function offerAnswerAgain(
  row: HitlFormRow,
  input: HitlSubmission,
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
        text: requestFallbackText(row.requestJson)
      });
      await closeIfEndedMeanwhile(row.requestId);
      return;
    } catch (err) {
      console.error("[hitl] failed to re-open prompt", {
        requestId: row.requestId,
        ...slackErrorFields(err)
      });
    }
  }

  const failed = `didn't reach *${row.agentName}*, so the question is open again — please answer again.`;
  const typed = Object.values(input.answers).some((a) => a.text);
  try {
    await postEphemeral({
      channelId: row.channelId,
      userId: input.answeredBy,
      threadTs: row.threadTs,
      text: typed
        ? `⚠️ Your answer ${failed} What you wrote:\n${clip(answersText(row.requestJson, input.answers), MAX_RETURNED_ANSWER_CHARS)}`
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
  const row = await getHitlForm(requestId);
  if (row?.status === "canceled") {
    await markHitlPromptResolved(row, TASK_ENDED_NOTE);
  }
}

/** A note to whoever clicked a prompt that is no longer open. */
async function tellClosed(row: HitlFormRow, userId: string): Promise<void> {
  await postEphemeral({
    channelId: row.channelId,
    userId,
    threadTs: row.threadTs,
    text: alreadyResolvedText(row)
  });
}

/** Handle a click on a prompt's controls: a pick, or opening the form's modal. */
async function handleBlockActions(
  payload: SlackBlockActionsPayload
): Promise<void> {
  for (const action of payload.actions) {
    const control = readControl(action);
    if (!control) continue;
    const row = await getHitlForm(control.requestId);
    if (!row) continue;

    if (control.kind === "pick") {
      const answers = pickAnswers(row.requestJson, control);
      if (!answers) continue;
      await answerHitl(
        control.requestId,
        { answers, answeredBy: payload.userId },
        payload.messageBlocks
      );
      continue;
    }

    if (!payload.triggerId) continue;
    if (row.status !== "awaiting") {
      await tellClosed(row, payload.userId);
      continue;
    }
    try {
      await openView(
        payload.triggerId,
        formView(row.requestJson, control.question)
      );
    } catch (err) {
      console.error("[hitl] failed to open the form", {
        requestId: control.requestId,
        ...slackErrorFields(err)
      });
    }
  }
}

/** Handle a submitted form: read its answers against the questions, and send them. */
async function handleViewSubmission(
  payload: SlackViewSubmissionPayload
): Promise<void> {
  const requestId = payload.privateMetadata;
  if (!requestId) return;
  const row = await getHitlForm(requestId);
  if (!row) return;
  const answers = formAnswers(row.requestJson, payload.values ?? []);
  if (!answers) {
    // `formErrors` refused this on the request path; reaching here means the
    // modal and the stored form disagree, which a person cannot fix.
    console.error("[hitl] a submitted form answers nothing it asked", {
      requestId
    });
    return;
  }
  await answerHitl(requestId, { answers, answeredBy: payload.userId });
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

  if (
    payload.kind === "view_submission" &&
    payload.callbackId === FORM_CALLBACK_ID
  ) {
    const guard = await guardTeamId(payload.teamId);
    if (guard) return guard;
    // On the request path, while Slack is still listening: refused here, a
    // mistake keeps the modal open with what was typed still in it. Refused by
    // the agent after the claim, the question would be spent on an answer
    // nobody holds.
    const errors = formErrors(payload.values ?? []);
    if (errors) return Response.json({ response_action: "errors", errors });
    ctx.waitUntil(handleViewSubmission(payload));
    // An empty 200 tells Slack to close the modal.
    return new Response(null, { status: 200 });
  }

  // block_suggestion, view_closed, slash_command, etc. — acked and ignored.
  return OK();
}
