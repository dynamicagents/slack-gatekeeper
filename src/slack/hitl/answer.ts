import type { SlackViewStateValue } from "@chat-adapter/slack/webhook";
import {
  MAX_MESSAGE_TEXT_BYTES,
  type HitlAnswer
} from "@dynamicagents/g2a-protocol";
import type { HitlRequest } from "@/a2a/hitl";
import { isRecord } from "@/util/json";
import { OPEN_ACTION, PICK_ACTION, type ControlValue } from "./render";

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
  | { kind: "open"; requestId: string; question?: number };

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
 * here. The words together are held to the bound the agent holds a message to.
 */
export function formErrors(
  values: readonly SlackViewStateValue[]
): Record<string, string> | undefined {
  const errors: Record<string, string> = {};
  let bytes = 0;
  let lastText: string | undefined;
  for (const entry of entries(values).values()) {
    if (entry.text) {
      bytes += encoder.encode(entry.text).byteLength;
      lastText = entry.textBlockId;
    }
    if (entry.picks.length > 0 || entry.text) continue;
    const where = entry.blockId ?? entry.textBlockId;
    if (!where) continue;
    errors[where] =
      entry.kind === "choice"
        ? "Pick one, or answer in your own words below."
        : entry.kind === "approval"
          ? "Approve, reject, or leave a comment below."
          : "Write an answer.";
  }
  if (bytes > MAX_MESSAGE_TEXT_BYTES && lastText) {
    errors[lastText] =
      "These answers are too long to send — please shorten them.";
  }
  return Object.keys(errors).length > 0 ? errors : undefined;
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
  const answers: Record<string, HitlAnswer> = {};
  for (const [index, entry] of byIndex) {
    const question = request.questions[index];
    if (!question) return null;
    const optionIds =
      question.kind === "choice"
        ? entry.picks.flatMap((p) => {
            const option = question.options[Number(p)];
            return option ? [option.id] : [];
          })
        : question.kind === "approval"
          ? entry.picks.filter((p) => p === "approve" || p === "reject")
          : [];
    if (optionIds.length > 0) {
      answers[question.id] = {
        optionIds,
        ...(entry.text ? { text: entry.text } : {})
      };
    } else if (entry.text) {
      answers[question.id] = { text: entry.text };
    } else {
      return null;
    }
  }
  return Object.keys(answers).length > 0 ? answers : null;
}
