import type { Message } from "@a2a-js/sdk";
import {
  HITL_APPROVE_OPTION_ID,
  HITL_REQUEST_TYPE,
  parseHitlResponse,
  parseHitlTimeout,
  type HitlRequest
} from "@/a2a/hitl";
import { textOf } from "@/a2a/parts";
import {
  ASK_USER_TOOL_NAME,
  askUserInputSchema,
  askUserRequest
} from "./ask-user";
import type { ToolRecord } from "./messages";

/**
 * A turn that stops for a human, and the later turn that picks the answer up.
 *
 * Two things stop a turn, and they stop it the same way: a question the model
 * asked with `ask_user`, and a call the approval policy gated behind a human's
 * Approve. Neither produces an output on the step it was made, so the SDK's loop
 * halts on it by itself, and both wait as one {@link OpenCall}.
 *
 * The call is kept **outside** the Session, in a record keyed by the HITL
 * `requestId`. Keeping it in history as a pending tool part looks simpler and does
 * not survive use: compaction folds older messages into a summary once history
 * passes its threshold, so a prompt raised a few turns ago stops being there to
 * find by the time anyone answers it. A record nothing compacts has none of that
 * problem.
 *
 * This is the agent's own copy, and it holds what only the agent needs: which call
 * the answer belongs to. The human-facing half — prompt text, options, status,
 * deadline — is the gatekeeper's `hitl_requests` row, and the two meet on the
 * `requestId` alone.
 *
 * On the way back the settled call is written to the *end* of history, as the call
 * plus its result, and no user turn is added: the model asked for something, and
 * what it gets back is the answer to that. Where the two kinds differ is *when*
 * that write can happen — see {@link approvedCall}.
 */

/** A tool call a turn paused on, kept until a human answers it. */
export interface OpenCall {
  /** The HITL correlation key the gatekeeper renders and answers with. */
  requestId: string;
  toolCallId: string;
  toolName: string;
  /** The call's input, as the SDK validated it. */
  input: unknown;
  /**
   * Present ⇔ the call is gated behind an approval rather than being a question.
   *
   * `requestId` is the SDK's own `approvalId`, which is what the replay has to
   * quote, so the id is not repeated here — only the reason the policy gave for
   * stopping, which is what the human is shown.
   */
  approval?: { reason?: string };
  /** Epoch ms — a call stopped with 🛑 is never answered, so it has to age out. */
  createdAt: number;
}

/** Where open calls wait. Implemented over DO storage by `DurableOpenCalls`. */
export interface OpenCallStore {
  /** Keep a call until it is answered. Also drops calls past the HITL TTL. */
  put(call: OpenCall): Promise<void>;
  /**
   * Hand the call `requestId` answers to `record`, then forget it — only after
   * `record` has finished, and not at all if it throws. Null, with `record` never
   * called, when there is no such call: never asked, or already settled.
   */
  settle(
    requestId: string,
    record: (call: OpenCall) => Promise<void>
  ): Promise<OpenCall | null>;
}

/**
 * Recorded for a call that would have paused the turn but was not raised. One
 * call is open per turn, so the rest never reached anyone — and a later turn
 * should be able to see that they were not asked, rather than guess.
 */
export const NOT_ASKED_NOTE =
  "Not asked: only one question or approval can be open at a time. Ask again once this one is settled.";

/** The call a step paused on, plus the calls it could not also raise. */
export interface Pause {
  call: OpenCall;
  notRaised: ToolRecord[];
}

interface CallLike {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/**
 * An approval the SDK raised, as it appears among a step's content parts.
 *
 * `isAutomatic` marks a decision the policy made on its own — an `approved` or a
 * `denied` — which no human is ever shown. Only a `user-approval` waits.
 */
interface ApprovalLike {
  type: string;
  approvalId: string;
  toolCall: CallLike;
  reason?: string;
  isAutomatic?: boolean;
}

/** A call that was not raised, recorded as such. */
function notAsked(call: CallLike): ToolRecord {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    errorText: NOT_ASKED_NOTE
  };
}

/**
 * The call a turn's last step paused on, or `undefined` if it did not pause.
 *
 * Questions read off `staticToolCalls`, which holds only calls whose input passed
 * the tool's own schema — a malformed question was already handed back to the
 * model as a failed result and never stopped the loop. Approvals read off
 * `content`, where the SDK puts the requests it raised.
 *
 * A question out-ranks an approval raised in the same step. Asking means the model
 * is unsure what was wanted, and an approval decided against an unclear request is
 * the one decision a human should not be handed.
 *
 * A question's `requestId` is minted here rather than borrowed from the call:
 * provider call ids come in whatever shape and length the provider chooses, and
 * this id ends up inside a Slack action id, which Slack caps. An approval instead
 * carries the SDK's own `approvalId`, which is bounded — and which the replay has
 * to quote back for the SDK to recognize the decision.
 */
export function openCallOf(
  step: {
    staticToolCalls: readonly CallLike[];
    content: readonly { type: string }[];
  },
  now = Date.now()
): Pause | undefined {
  const [question, ...otherQuestions] = step.staticToolCalls.filter(
    (c) => c.toolName === ASK_USER_TOOL_NAME
  );
  const approvals = step.content.filter(
    (part): part is ApprovalLike =>
      part.type === "tool-approval-request" &&
      !(part as ApprovalLike).isAutomatic
  );

  if (question) {
    return {
      call: {
        requestId: crypto.randomUUID(),
        toolCallId: question.toolCallId,
        toolName: question.toolName,
        input: question.input,
        createdAt: now
      },
      notRaised: [
        ...otherQuestions.map(notAsked),
        ...approvals.map((a) => notAsked(a.toolCall))
      ]
    };
  }

  const [approval, ...otherApprovals] = approvals;
  if (!approval) return undefined;
  return {
    call: {
      requestId: approval.approvalId,
      toolCallId: approval.toolCall.toolCallId,
      toolName: approval.toolCall.toolName,
      input: approval.toolCall.input,
      approval:
        approval.reason === undefined ? {} : { reason: approval.reason },
      createdAt: now
    },
    notRaised: otherApprovals.map((a) => notAsked(a.toolCall))
  };
}

/**
 * The HITL request a call renders as.
 *
 * A question is parsed rather than cast: the input was validated when the model
 * made the call, but it has since been through storage. An approval renders as the
 * canonical Approve/Reject pair, with the policy's own reason as the prompt — that
 * sentence is what the human decides on, so a policy that gave none has nothing
 * worth showing and falls back to naming the tool.
 */
export function hitlRequestOf(call: OpenCall): HitlRequest {
  if (call.approval) {
    return {
      type: HITL_REQUEST_TYPE,
      requestId: call.requestId,
      requestKind: "approval",
      prompt: call.approval.reason ?? `Approve \`${call.toolName}\`?`
    };
  }
  return askUserRequest(call.requestId, askUserInputSchema.parse(call.input));
}

/** What came back for an open call. */
export type HumanAnswer =
  | { kind: "answered"; text: string; by: string; optionId?: string }
  | { kind: "timed-out" };

/**
 * The answer an inbound message carries, if it is the gatekeeper resuming a parked
 * task. `answerer` is the display name of whoever answered, when the caller knows
 * it; the Slack id on the response stands in otherwise. The text is the message's
 * own text part, which the gatekeeper fills with the chosen label or the typed
 * answer, and `optionId` is which button — the one thing that separates an Approve
 * from a Reject, since both arrive as an ordinary answer.
 */
export function humanAnswerOf(
  message: Message,
  answerer: string | null | undefined
): { requestId: string; answer: HumanAnswer } | null {
  const response = parseHitlResponse(message);
  if (response) {
    return {
      requestId: response.requestId,
      answer: {
        kind: "answered",
        text: textOf(message),
        by: answerer ?? response.answeredBy,
        ...(response.optionId ? { optionId: response.optionId } : {})
      }
    };
  }
  const timeout = parseHitlTimeout(message);
  return timeout
    ? { requestId: timeout.requestId, answer: { kind: "timed-out" } }
    : null;
}

/**
 * Whether an answer to an approval prompt was the Approve button, and only that.
 *
 * A predicate rather than a boolean: everything else — a Reject, a typed reply, a
 * timeout — is a refusal, and narrowing here is what stops a caller reaching for
 * an answerer who, in the timeout case, does not exist.
 */
export function wasApproved(
  answer: HumanAnswer
): answer is Extract<HumanAnswer, { kind: "answered" }> {
  return (
    answer.kind === "answered" && answer.optionId === HITL_APPROVE_OPTION_ID
  );
}

/**
 * The paused question with its answer as the result — how the model reads it on the
 * turn that resumes, and how that turn records it.
 *
 * A timeout is an ordinary result, not a failed call. A failure reads as "fix the
 * arguments and try again", and asking the same question again a week later is not
 * what an unanswered question calls for.
 */
export function answeredCall(call: OpenCall, answer: HumanAnswer): ToolRecord {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    output:
      answer.kind === "answered"
        ? { answer: answer.text, answeredBy: answer.by }
        : {
            answered: false,
            note: "No answer came back within the allotted time."
          }
  };
}

/**
 * An approved call, as the resumed turn replays it for the SDK to carry out.
 *
 * This is the whole mechanism of an approval resume: replayed into the model
 * messages it becomes `assistant[tool-call, tool-approval-request]` followed by
 * `tool[tool-approval-response]`, which is the shape the SDK collects an approval
 * from. It then re-validates the input against the tool's schema, re-runs the
 * policy against *this* turn's caller, and only then executes the call the model
 * originally made — not a description of it.
 *
 * Unlike an answered question, this record is **not** written to history before the
 * turn runs. It is not the outcome yet: the tool has not run, and history has no way
 * to amend a record it already holds, so a pre-written one plus the settled one
 * would leave two parts carrying the same `toolCallId` — and a duplicated call id
 * breaks the replay of *every* later turn, not just this one. The decision is
 * recorded once, on the way out, by whichever exit the turn takes.
 */
export function approvedCall(call: OpenCall, by: string): ToolRecord {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    approval: {
      id: call.requestId,
      approved: true,
      reason: `Approved in Slack by ${by}.`
    }
  };
}

/**
 * An approval that was decided against, or that never ran, as the turn records it.
 * `reason` is why, and it reaches the model in place of a result.
 */
export function refusedCall(call: OpenCall, reason: string): ToolRecord {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    approval: { id: call.requestId, approved: false, reason }
  };
}

/**
 * Why an approval prompt closed without the call running: a human who said no, or
 * a week of silence. Both are answers; neither is a failure to retry around.
 */
export function refusalReason(answer: HumanAnswer): string {
  return answer.kind === "answered"
    ? `Rejected in Slack by ${answer.by}.`
    : "The approval request expired with no response.";
}

/**
 * An approved call's record, turned into a refusal because it never ran — a 🛑 that
 * landed first, or a policy that refused it when the SDK re-ran it for the approver.
 *
 * A record with no approval id never went through an approval at all, so it is
 * recorded as a plain failed call rather than being given a fabricated one: an id
 * invented here would claim a decision nobody made.
 */
export function withRefusal(record: ToolRecord, reason: string): ToolRecord {
  const call = {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    input: record.input
  };
  const id = record.approval?.id;
  return id === undefined
    ? { ...call, errorText: reason }
    : { ...call, approval: { id, approved: false, reason } };
}

/** An approved call that has now run, carrying whatever it produced. */
export function settledCall(
  record: ToolRecord,
  outcome: { output: unknown } | { errorText: string }
): ToolRecord {
  return { ...record, ...outcome };
}
