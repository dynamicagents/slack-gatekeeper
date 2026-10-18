import type { SlackViewStateValue } from "@chat-adapter/slack/webhook";
import {
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID,
  MAX_MESSAGE_TEXT_BYTES,
  type HitlAnswer
} from "@dynamicagents/g2a-protocol";
import { answersText, type HitlRequest } from "@/a2a/hitl";
import { isRecord } from "@/util/json";
import {
  BACK_ACTION,
  OPEN_ACTION,
  PICK_ACTION,
  type ControlValue,
  type ViewMeta
} from "./render";

/**
 * Reading a person's answers back out of Slack: a click on one of the prompt's
 * controls, or a submitted modal. The ids these read are the ones
 * `./render.ts` writes.
 */

/** What a click on one of the prompt's controls asks for. */
export type Control =
  | {
      kind: "pick";
      requestId: string;
      question: number;
      option: number | "approve" | "reject";
    }
  /** Open the form's modal — or, with `question`, that question's words alone. */
  | { kind: "open"; requestId: string; question?: number }
  /** Go back to `page` of a paged form, from the modal showing a later one. */
  | { kind: "back"; requestId: string; page: number };

function controlValue(value: string | undefined): ControlValue | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && typeof parsed.r === "string" && parsed.r
      ? (parsed as unknown as ControlValue)
      : null;
  } catch {
    return null;
  }
}

/** The control a block action clicked, or `null` for anything not a HITL control. */
export function readControl(action: {
  actionId: string;
  value?: string;
}): Control | null {
  const value = controlValue(action.value);
  if (!value) return null;
  if (action.actionId === BACK_ACTION) {
    return typeof value.p === "number"
      ? { kind: "back", requestId: value.r, page: value.p }
      : null;
  }
  if (action.actionId === OPEN_ACTION) {
    return {
      kind: "open",
      requestId: value.r,
      ...(typeof value.q === "number" ? { question: value.q } : {})
    };
  }
  if (
    action.actionId.startsWith(`${PICK_ACTION}-`) &&
    typeof value.q === "number" &&
    value.o !== undefined
  ) {
    return {
      kind: "pick",
      requestId: value.r,
      question: value.q,
      option: value.o
    };
  }
  return null;
}

/** What a modal's `private_metadata` says it shows, or `null` for none of ours. */
export function readViewMeta(metadata: string | undefined): ViewMeta | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return isRecord(parsed) &&
      typeof parsed.r === "string" &&
      parsed.r &&
      (parsed.p === undefined || typeof parsed.p === "number")
      ? (parsed as unknown as ViewMeta)
      : null;
  } catch {
    return null;
  }
}

/**
 * The inputs of a modal a button was clicked in, as a submission carries them.
 * The adapter reads them for a submission only; a click inside a modal carries
 * the same `view.state.values`, which Back keeps rather than lose.
 */
export function viewValues(view: unknown): SlackViewStateValue[] {
  const state = isRecord(view) ? view.state : undefined;
  const values = isRecord(state) ? state.values : undefined;
  if (!isRecord(values)) return [];
  return Object.entries(values).flatMap(([blockId, block]) =>
    isRecord(block)
      ? Object.entries(block).flatMap(([actionId, raw]) =>
          isRecord(raw)
            ? [
                {
                  actionId,
                  blockId,
                  raw,
                  ...(typeof raw.value === "string" ? { value: raw.value } : {})
                }
              ]
            : []
        )
      : []
  );
}

/** The answers a pick amounts to, or `null` when it names nothing the form asked. */
export function pickAnswers(
  request: HitlRequest,
  control: Extract<Control, { kind: "pick" }>
): Record<string, HitlAnswer> | null {
  const question = request.questions[control.question];
  if (!question) return null;
  if (question.kind === "approval" && typeof control.option === "string") {
    return { [question.id]: { optionIds: [control.option] } };
  }
  if (question.kind === "choice" && typeof control.option === "number") {
    const option = question.options[control.option];
    return option ? { [question.id]: { optionIds: [option.id] } } : null;
  }
  return null;
}

/** One question's state in a submitted modal: what was picked, and what was typed. */
interface Entry {
  /** The main input's block id, when the modal had one — where its error goes. */
  blockId?: string;
  kind?: string;
  picks: string[];
  text?: string;
  textBlockId?: string;
}

function selectedValues(raw: Record<string, unknown>): string[] {
  const one = raw.selected_option;
  if (isRecord(one) && typeof one.value === "string") return [one.value];
  const many = raw.selected_options;
  if (!Array.isArray(many)) return [];
  return many.flatMap((o) =>
    isRecord(o) && typeof o.value === "string" ? [o.value] : []
  );
}

/** Each question's state in a submitted modal, by the question's position. */
function entries(values: readonly SlackViewStateValue[]): Map<number, Entry> {
  const out = new Map<number, Entry>();
  for (const value of values) {
    const match = /^q(\d+):(.+)$/.exec(value.blockId);
    if (!match) continue;
    const index = Number(match[1]);
    const entry = out.get(index) ?? { picks: [] };
    const role = match[2];
    const typed = value.value?.trim();
    if (role === "other" || role === "text") {
      if (typed) entry.text = typed;
      entry.textBlockId = value.blockId;
      if (role === "text") {
        entry.blockId = value.blockId;
        entry.kind = "text";
      }
    } else {
      entry.blockId = value.blockId;
      entry.kind = role.replace(/\+$/, "");
      entry.picks = selectedValues(value.raw);
    }
    out.set(index, entry);
  }
  return out;
}

const encoder = new TextEncoder();

/**
 * Why a submitted modal cannot be sent, by the block each reason goes under —
 * or `undefined` when it can. Checked on the request path, so a mistake keeps
 * the modal open with everything typed still in it instead of spending the
 * question on an answer the agent would refuse.
 *
 * Every question needs an answer: a pick, or words. Slack enforces a required
 * input only by its being empty, so words that are only whitespace are caught
 * here. Then the text part the answers are sent with — {@link answersText}, the
 * labels and headings beside the words — is held to the bound the agent holds
 * a message's text to, with `earlier` the answers a paged form's earlier pages
 * hold: each page is held to what it brings the total to.
 */
export function formErrors(
  request: HitlRequest,
  values: readonly SlackViewStateValue[],
  earlier: Record<string, HitlAnswer> = {}
): Record<string, string> | undefined {
  const errors: Record<string, string> = {};
  let first: string | undefined;
  let lastText: string | undefined;
  for (const entry of entries(values).values()) {
    const where = entry.blockId ?? entry.textBlockId;
    first ??= where;
    if (entry.text) lastText = entry.textBlockId;
    if (entry.picks.length > 0 || entry.text) continue;
    if (!where) continue;
    errors[where] =
      entry.kind === "choice"
        ? "Pick an option, or write yours in Other below."
        : entry.kind === "approval"
          ? "Approve, reject, or leave a comment below."
          : "Write an answer.";
  }
  if (Object.keys(errors).length > 0) return errors;
  const answers = formAnswers(request, values);
  const where = lastText ?? first;
  if (
    answers &&
    where &&
    encoder.encode(answersText(request, { ...earlier, ...answers }))
      .byteLength > MAX_MESSAGE_TEXT_BYTES
  ) {
    return {
      [where]: "These answers are too long to send — please shorten them."
    };
  }
  return undefined;
}

/** One question's answer from what its inputs hold, or `undefined` for none. */
function entryAnswer(
  question: HitlRequest["questions"][number],
  entry: Entry
): HitlAnswer | undefined {
  const optionIds =
    question.kind === "choice"
      ? entry.picks.flatMap((p) => {
          const option = question.options[Number(p)];
          return option ? [option.id] : [];
        })
      : question.kind === "approval"
        ? entry.picks.filter(
            (p) => p === HITL_APPROVE_OPTION_ID || p === HITL_REJECT_OPTION_ID
          )
        : [];
  const [first, ...more] = optionIds;
  if (first !== undefined) {
    return {
      optionIds: [first, ...more],
      ...(entry.text ? { text: entry.text } : {})
    };
  }
  return entry.text ? { text: entry.text } : undefined;
}

/**
 * What a modal's inputs hold so far, keyed by question id: each question given
 * a pick or words. Collected as entries, not assigned: an agent picks its
 * question ids, and assigning `__proto__` would set the object's prototype
 * rather than a key.
 */
export function enteredAnswers(
  request: HitlRequest,
  values: readonly SlackViewStateValue[]
): Record<string, HitlAnswer> {
  const answers: [string, HitlAnswer][] = [];
  for (const [index, entry] of entries(values)) {
    const question = request.questions[index];
    const answer = question && entryAnswer(question, entry);
    if (question && answer) answers.push([question.id, answer]);
  }
  return Object.fromEntries(answers);
}

/**
 * The answers a submitted modal amounts to, keyed by question id — or `null`
 * when one it asked is unanswered, which {@link formErrors} has already
 * refused on the request path.
 */
export function formAnswers(
  request: HitlRequest,
  values: readonly SlackViewStateValue[]
): Record<string, HitlAnswer> | null {
  const byIndex = entries(values);
  if (byIndex.size === 0) return null;
  for (const [index, entry] of byIndex) {
    const question = request.questions[index];
    if (!question || !entryAnswer(question, entry)) return null;
  }
  return enteredAnswers(request, values);
}
