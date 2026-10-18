import { z } from "zod";
import type { Message, Part } from "@a2a-js/sdk";
import {
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID,
  HITL_REQUEST_TYPE,
  HITL_RESPONSE_TYPE,
  HITL_TIMEOUT_TYPE,
  type HitlAnswer,
  type HitlQuestion,
  type HitlRequestData,
  type HitlResponseData,
  type HitlTimeoutData
} from "@dynamicagents/g2a-protocol";
import { isRecord } from "@/util/json";
import { dataOf, dataPart, textPart } from "@/a2a/parts";

/**
 * Human-in-the-loop (HITL) over A2A: how an agent asks a person something
 * through this gatekeeper, and how the answers get back.
 *
 * A2A carries the exchange but standardizes nothing inside it — a part's `data`
 * is arbitrary JSON — so the two sides must agree on what a `data` part holds and
 * what its `type` is called. That agreement is not ours to make alone: the names
 * and shapes live in `@dynamicagents/g2a-protocol`, the only thing a gatekeeper
 * and the agent runtime can both hold.
 *
 * What stays here is everything this side *enforces*, and nothing about Slack:
 * the protocol declares the shapes as types only, so this module validates them
 * with the schema library this side already carries. How a form looks is
 * `src/slack/hitl/`'s.
 *
 * Flow:
 * - An agent that needs a person transitions its task to `input-required` and
 *   emits a status update whose `status.message.parts` include a
 *   {@link HITL_REQUEST_TYPE} data part: a form of one or more questions.
 * - The gatekeeper renders it, captures the answers, and resumes the task with
 *   a new message carrying a {@link HITL_RESPONSE_TYPE} data part.
 * - On TTL expiry the gatekeeper sends a {@link HITL_TIMEOUT_TYPE} data part instead.
 */

export {
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID,
  HITL_REQUEST_TYPE,
  HITL_RESPONSE_TYPE,
  HITL_TIMEOUT_TYPE
};

const nonEmpty = z.string().min(1);

const optionSchema = z.object({
  id: nonEmpty,
  label: nonEmpty,
  description: nonEmpty.optional(),
  example: nonEmpty.optional()
});

const questionBase = {
  id: nonEmpty,
  prompt: nonEmpty,
  header: nonEmpty.optional()
};

const questionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choice"),
    ...questionBase,
    options: z.array(optionSchema).min(1),
    multiple: z.boolean().optional()
  }),
  z.object({ kind: z.literal("text"), ...questionBase }),
  z.object({
    kind: z.literal("approval"),
    ...questionBase,
    artifact: z.object({ id: nonEmpty, url: nonEmpty })
  })
]);

function distinct(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}

/** An agent → gatekeeper form: why it asks, and the questions to answer together. */
export const hitlRequestSchema = z
  .object({
    type: z.literal(HITL_REQUEST_TYPE),
    /** Agent-chosen, unique per request — the gatekeeper's correlation key. */
    requestId: nonEmpty,
    prompt: nonEmpty.optional(),
    questions: z.array(questionSchema).min(1)
  })
  // An answer is keyed by question id and names options by id: two the same
  // and the answer cannot say which it means.
  .refine(
    (r) =>
      distinct(r.questions.map((q) => q.id)) &&
      r.questions.every(
        (q) => q.kind !== "choice" || distinct(q.options.map((o) => o.id))
      ),
    { message: "question ids, and each question's option ids, are distinct" }
  );

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
 * falls back to treating the `input-required` update as plain text, which the
 * agent writes as the form in words.
 */
export function parseHitlRequest(
  message: Message | undefined
): HitlRequest | null {
  return parseDataPart(message, HITL_REQUEST_TYPE, hitlRequestSchema);
}

/** One question with its answer, in words: what a person picked and typed. */
export interface AnsweredQuestion {
  question: HitlQuestion;
  /** The picked options' labels; an approval's verdict as "Approved"/"Rejected". */
  picked: string[];
  text?: string;
}

/** Each question of `request` with its answer from `answers`, in question order. */
export function answeredQuestions(
  request: HitlRequest,
  answers: Record<string, HitlAnswer>
): AnsweredQuestion[] {
  return request.questions.flatMap((question) => {
    // Own keys only: an agent picks its question ids, and `constructor` would
    // otherwise find `Object.prototype`'s.
    const answer = Object.hasOwn(answers, question.id)
      ? answers[question.id]
      : undefined;
    if (!answer) return [];
    const picked = (answer.optionIds ?? []).map((id) => {
      if (question.kind === "approval") {
        return id === HITL_APPROVE_OPTION_ID ? "Approved" : "Rejected";
      }
      if (question.kind === "choice") {
        return question.options.find((o) => o.id === id)?.label ?? id;
      }
      return id;
    });
    return [
      { question, picked, ...(answer.text ? { text: answer.text } : {}) }
    ];
  });
}

/**
 * The answers in plain words, for the text part beside the data — what a client
 * that knows none of this reads. One question's answer stands alone; several
 * each follow their question.
 */
export function answersText(
  request: HitlRequest,
  answers: Record<string, HitlAnswer>
): string {
  const answered = answeredQuestions(request, answers);
  const words = (a: AnsweredQuestion) =>
    [a.picked.join(", "), a.text].filter(Boolean).join("\n");
  if (request.questions.length === 1) {
    return answered[0] ? words(answered[0]) : "";
  }
  return answered
    .map((a) => `${a.question.header ?? a.question.prompt}\n${words(a)}`)
    .join("\n\n");
}

/**
 * Build the parts of the resume message the gatekeeper sends back onto the task:
 * the answers in words, which a non-HITL client sees and the agent's size bound
 * measures, and the structured answers.
 */
export function buildHitlResponseParts(input: {
  request: HitlRequest;
  answeredBy: string;
  answers: Record<string, HitlAnswer>;
}): Part[] {
  const data: HitlResponseData = {
    type: HITL_RESPONSE_TYPE,
    requestId: input.request.requestId,
    answeredBy: input.answeredBy,
    answers: input.answers
  };
  return [textPart(answersText(input.request, input.answers)), dataPart(data)];
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
 * a HITL prompt: a text part fallback plus the structured request data part.
 * Symmetric to {@link buildHitlResponseParts}; the data part round-trips through
 * {@link parseHitlRequest}.
 */
export function buildHitlRequestParts(req: HitlRequest): Part[] {
  const text = [req.prompt, ...req.questions.map((q) => q.prompt)]
    .filter(Boolean)
    .join("\n\n");
  return [textPart(text), dataPart({ ...req, type: HITL_REQUEST_TYPE })];
}

const answerSchema = z.union([
  z.object({
    // A tuple of at least one, as the protocol types it.
    optionIds: z.tuple([nonEmpty], nonEmpty),
    text: nonEmpty.optional()
  }),
  // `optionIds` refused outright rather than stripped, as core reads it.
  z.object({ optionIds: z.undefined().optional(), text: nonEmpty })
]);

const hitlResponseSchema = z.object({
  type: z.literal(HITL_RESPONSE_TYPE),
  requestId: nonEmpty,
  answeredBy: nonEmpty,
  answers: z.record(nonEmpty, answerSchema)
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
 * Find and validate the gatekeeper → agent answers that resume a parked task.
 * Returns `null` when the message carries no HITL response data part.
 */
export function parseHitlResponse(
  message: Message | undefined
): HitlResponse | null {
  return parseDataPart(message, HITL_RESPONSE_TYPE, hitlResponseSchema);
}

const hitlTimeoutSchema = z.object({
  type: z.literal(HITL_TIMEOUT_TYPE),
  requestId: nonEmpty
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
