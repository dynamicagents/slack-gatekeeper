import { z } from "zod";
import type { Message, Part } from "@a2a-js/sdk";
import type {
  SlackInputOption,
  SlackInputRequest
} from "@chat-adapter/slack/blocks";
import { isRecord } from "@/util/json";
import { dataOf, dataPart, textPart } from "@/a2a/parts";

/**
 * The gatekeeper's human-in-the-loop (HITL) wire contract, carried inside A2A
 * `data` parts. A2A does not standardize a form schema (a part's `data` content
 * is arbitrary JSON), so we namespace our own `data.type` discriminators — this
 * is spec-compliant and lets a non-HITL-aware client still read the sibling
 * text part fallback.
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

/** Data-part `type` for an agent → gatekeeper HITL request. */
export const HITL_REQUEST_TYPE = "io.da.hitl.request";
/** Data-part `type` for the gatekeeper → agent answer that resumes the task. */
export const HITL_RESPONSE_TYPE = "io.da.hitl.response";
/** Data-part `type` for the gatekeeper → agent timeout that ends the wait. */
export const HITL_TIMEOUT_TYPE = "io.da.hitl.timeout";

/** Canonical option ids used when an `approval` request omits its own options. */
export const HITL_APPROVE_OPTION_ID = "approve";
export const HITL_REJECT_OPTION_ID = "reject";

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
  requestKind: z.enum(["approval", "choice"]),
  prompt: z.string().min(1),
  /** Omit for `approval` to accept the canonical Approve/Reject pair. */
  options: z.array(optionSchema).optional(),
  display: z.enum(["buttons", "radio", "select"]).optional(),
  /** Allow a typed "Something else…" answer alongside the fixed options. */
  allowFreeform: z.boolean().optional()
});

export type HitlRequest = z.infer<typeof hitlRequestSchema>;
export type HitlOption = z.infer<typeof optionSchema>;

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
 * Build the parts of the resume message the gatekeeper sends back onto the task.
 * `humanText` (the chosen option's label, or the freeform text) is the text
 * part a non-HITL client sees; the data part carries the structured answer.
 */
export function buildHitlResponseParts(input: {
  requestId: string;
  optionId?: string;
  text?: string;
  answeredBy: string;
  humanText: string;
}): Part[] {
  return [
    textPart(input.humanText),
    dataPart({
      type: HITL_RESPONSE_TYPE,
      requestId: input.requestId,
      ...(input.optionId ? { optionId: input.optionId } : {}),
      ...(input.text ? { text: input.text } : {}),
      answeredBy: input.answeredBy
    })
  ];
}

/** Build the parts of the timeout message sent when a HITL prompt expires. */
export function buildHitlTimeoutParts(requestId: string): Part[] {
  return [
    textPart("(No response was received within the allotted time.)"),
    dataPart({ type: HITL_TIMEOUT_TYPE, requestId })
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
