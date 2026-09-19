import { z } from "zod";
import type { Message, Part } from "@a2a-js/sdk";
import type {
  SlackInputOption,
  SlackInputRequest
} from "@chat-adapter/slack/blocks";
import {
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID,
  HITL_REQUEST_KINDS,
  HITL_REQUEST_TYPE,
  HITL_RESPONSE_TYPE,
  HITL_TIMEOUT_TYPE,
  type HitlOption,
  type HitlRequestData,
  type HitlResponseData,
  type HitlTimeoutData
} from "@dynamicagents/g2a-protocol";
import { isRecord } from "@/util/json";
import { dataOf, dataPart, textPart } from "@/a2a/parts";

/**
 * Human-in-the-loop (HITL) over A2A: how an agent asks a person something
 * through this gatekeeper, and how the answer gets back.
 *
 * A2A carries the exchange but standardizes nothing inside it — a part's `data`
 * is arbitrary JSON — so the two sides must agree on what a `data` part holds and
 * what its `type` is called. That agreement is not ours to make alone: the names
 * live in `@dynamicagents/g2a-protocol` and are re-exported here unchanged, which
 * is the only thing a gatekeeper and the agent runtime can both hold.
 *
 * What stays here is everything either side *enforces*. The protocol declares
 * the shapes as types only; this module validates them with the schema library
 * this side already carries, and maps them onto Slack.
 *
 * Flow:
 * - An agent that needs a human decision transitions its task to
 *   `input-required` and emits a status update whose `status.message.parts`
 *   include a {@link HITL_REQUEST_TYPE} data part (plus a human-readable text part).
 * - The gatekeeper renders it in Slack, captures the answer, and resumes the task
 *   with a new message carrying a {@link HITL_RESPONSE_TYPE} data part.
 * - On TTL expiry the gatekeeper sends a {@link HITL_TIMEOUT_TYPE} data part instead.
 *
 * An "approval" is just a two-option "choice" (Approve/Reject), so one shape
 * covers both.
 */

export {
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID,
  HITL_REQUEST_TYPE,
  HITL_RESPONSE_TYPE,
  HITL_TIMEOUT_TYPE,
  type HitlOption
};

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  // Maps to Slack's button/option style; "danger" is the natural Reject accent.
  style: z.enum(["primary", "danger", "default"]).optional()
});

/** An agent → gatekeeper request to ask a human to approve or choose. */
export const hitlRequestSchema = z.object({
  type: z.literal(HITL_REQUEST_TYPE),
  /** Agent-chosen, unique per request — the Slack action + gatekeeper correlation key. */
  requestId: z.string().min(1),
  // Built from the protocol's tuple rather than spelled again: a kind added
  // upstream widens this enum on the next install, instead of parsing as invalid.
  requestKind: z.enum(HITL_REQUEST_KINDS),
  prompt: z.string().min(1),
  /** Omit for `approval` to accept the canonical Approve/Reject pair. */
  options: z.array(optionSchema).optional(),
  display: z.enum(["buttons", "radio", "select"]).optional(),
  /** Allow a typed "Something else…" answer alongside the fixed options. */
  allowFreeform: z.boolean().optional()
});

/**
 * The protocol's own shape, not `z.infer` of the schema above.
 *
 * Naming the contract type here is what makes {@link parseHitlRequest}'s return
 * annotation a proof: the schema's output has to be assignable to it, so a field
 * this validator drops, renames, or types differently from the contract fails
 * `tsc` rather than surviving as a parse that quietly returns less.
 */
export type HitlRequest = HitlRequestData;

/**
 * Find and validate a HITL request in an A2A message's parts. Returns `null`
 * when the message carries no (valid) HITL request data part — the caller then
 * falls back to treating the `input-required` update as plain text.
 */
export function parseHitlRequest(
  message: Message | undefined
): HitlRequest | null {
  return parseDataPart(message, HITL_REQUEST_TYPE, hitlRequestSchema);
}

/** The canonical two options for an `approval` request that supplies none. */
export function approvalOptions(): SlackInputOption[] {
  return [
    { id: HITL_APPROVE_OPTION_ID, label: "Approve", style: "primary" },
    { id: HITL_REJECT_OPTION_ID, label: "Reject", style: "danger" }
  ];
}

/**
 * Map a validated {@link HitlRequest} onto the Slack SDK's `SlackInputRequest`,
 * filling the canonical Approve/Reject options when an `approval` omits its own.
 * The shapes are intentionally close, so this is mostly a rename plus defaulting.
 *
 * ## When there is nothing to click
 *
 * A `choice` can arrive with `options: []`, or with no `options` at all — both
 * protocol-legal, and neither gets the Approve/Reject fill, which is for
 * `approval` only. What reaches Slack then has an empty option set, and the
 * adapter renders a freeform button for it **whether or not `allowFreeform` is
 * set**.
 *
 * So the gatekeeper never posts a question nobody can answer, and the price is
 * that `allowFreeform: false` is not honoured when there is nothing to offer
 * instead. That is the right way round for a gatekeeper — the alternative is a
 * prompt a person can only watch expire, and an agent that waits out the full
 * TTL to learn nothing — but it is a decision, not an accident, which is why it
 * is written down here.
 *
 * Nothing sends this shape today. If something does, the fix belongs in the
 * contract — a request must offer at least one way to answer — rather than in a
 * local refusal that leaves the other side guessing why its question vanished.
 */
export function toSlackInputRequest(req: HitlRequest): SlackInputRequest {
  const options: SlackInputOption[] | undefined = req.options
    ? req.options.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
        style: o.style
      }))
    : req.requestKind === "approval"
      ? approvalOptions()
      : undefined;

  return {
    prompt: req.prompt,
    requestId: req.requestId,
    display: req.display ?? "buttons",
    allowFreeform: req.allowFreeform,
    options
  };
}

/** Look up an option's human label by id, for the resume TextPart / answered UI. */
export function optionLabel(
  options: readonly SlackInputOption[],
  optionId: string | undefined
): string | undefined {
  if (!optionId) return undefined;
  return options.find((o) => o.id === optionId)?.label;
}

/**
 * What a person actually gave back: a picked option, typed text, or an option
 * with text alongside it — but never neither.
 *
 * The protocol says the same thing, and this is not a second copy of it: it is
 * the protocol's union with `optionId?: undefined` in place of
 * `optionId?: string` on the text-only member. That narrower spelling is what
 * makes `input.optionId !== undefined` discriminate, so a builder can take the
 * branch the compiler already proved instead of casting. It stays assignable to
 * the protocol's union, which is the direction that matters.
 *
 * Carried from the Slack handler down to the resume, so the "one of the two is
 * present" invariant holds at every step rather than being re-checked or
 * papered over with an empty string at the end.
 */
export type HitlAnswerChoice =
  { optionId: string; text?: string } | { optionId?: undefined; text: string };

/**
 * Build the parts of the resume message the gatekeeper sends back onto the task.
 * `humanText` (the chosen option's label, or the freeform text) is the text
 * part a non-HITL client sees; the data part carries the structured answer.
 */
export function buildHitlResponseParts(
  input: HitlAnswerChoice & {
    requestId: string;
    answeredBy: string;
    humanText: string;
  }
): Part[] {
  // Annotated as the protocol's own type, so the compiler checks the outbound
  // direction: the union below refuses an answer carrying neither an `optionId`
  // nor a `text`, which is a part no conformant agent could act on.
  const data: HitlResponseData =
    input.optionId !== undefined
      ? {
          type: HITL_RESPONSE_TYPE,
          requestId: input.requestId,
          optionId: input.optionId,
          ...(input.text ? { text: input.text } : {}),
          answeredBy: input.answeredBy
        }
      : {
          type: HITL_RESPONSE_TYPE,
          requestId: input.requestId,
          text: input.text,
          answeredBy: input.answeredBy
        };
  return [textPart(input.humanText), dataPart(data)];
}

/** Build the parts of the timeout message sent when a HITL prompt expires. */
export function buildHitlTimeoutParts(requestId: string): Part[] {
  const data: HitlTimeoutData = { type: HITL_TIMEOUT_TYPE, requestId };
  return [
    textPart("(No response was received within the allotted time.)"),
    dataPart(data)
  ];
}

/**
 * Build the parts of the `input-required` status message an agent emits to raise
 * a HITL prompt: a human-readable text part fallback plus the structured request
 * data part the gatekeeper renders in Slack. Symmetric to {@link buildHitlResponseParts};
 * the data part round-trips through {@link parseHitlRequest}.
 */
export function buildHitlRequestParts(req: HitlRequest): Part[] {
  return [textPart(req.prompt), dataPart({ ...req, type: HITL_REQUEST_TYPE })];
}

const hitlResponseSchema = z
  .object({
    type: z.literal(HITL_RESPONSE_TYPE),
    requestId: z.string().min(1),
    optionId: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    answeredBy: z.string().min(1)
  })
  .refine((data) => data.optionId !== undefined || data.text !== undefined, {
    message: "HITL response must include optionId or text"
  });

export type HitlResponse = z.infer<typeof hitlResponseSchema>;

/** Find the data part of `type` in a message and validate it with `schema`. */
function parseDataPart<T>(
  message: Message | undefined,
  type: string,
  schema: z.ZodType<T>
): T | null {
  if (!message) return null;
  for (const part of message.parts) {
    const data = dataOf(part);
    if (!isRecord(data) || data.type !== type) continue;
    const parsed = schema.safeParse(data);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Find and validate the gatekeeper → agent answer that resumes a parked task.
 * Returns `null` when the message carries no HITL response data part.
 */
export function parseHitlResponse(
  message: Message | undefined
): HitlResponse | null {
  return parseDataPart(message, HITL_RESPONSE_TYPE, hitlResponseSchema);
}

const hitlTimeoutSchema = z.object({
  type: z.literal(HITL_TIMEOUT_TYPE),
  requestId: z.string().min(1)
});

/**
 * Find and validate the gatekeeper → agent timeout that ends a parked task's wait.
 * Returns `null` when the message carries no HITL timeout DataPart.
 */
export function parseHitlTimeout(
  message: Message | undefined
): { requestId: string } | null {
  const parsed = parseDataPart(message, HITL_TIMEOUT_TYPE, hitlTimeoutSchema);
  return parsed ? { requestId: parsed.requestId } : null;
}
