import type {
  HitlAnswer,
  HitlOption,
  HitlQuestion
} from "@dynamicagents/g2a-protocol";
import { slackifyMarkdown } from "slackify-markdown";
import {
  answeredQuestions,
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID,
  type HitlRequest
} from "@/a2a/hitl";
import { sanitizeSlackText } from "@/util/slack-text";

/**
 * How a human-in-the-loop form looks in Slack: the questions, their options,
 * and the states the prompt moves through once answered or closed.
 *
 * Every string the agent or a person wrote fits Slack whole or is cut where the
 * reader can see it — never silently. A question cut at a block limit is a
 * question nobody was asked: one prompt lost every numbered question it held
 * that way, because they all started past the 3,000th character.
 *
 * Each thing is said once, where it is answered. One question picked from a
 * short list is answered in the thread, by a button per option, so the message
 * holds the question. Anything else — several questions, several picks, words —
 * opens a modal with an input per question, from one "Answer" button, paged when
 * one modal cannot hold them all (see {@link formPages}): the message then holds
 * only the agent's words, and the modal only the questions.
 *
 * A control holds at most 75 characters, and a button shows about 30, so where
 * an option has more to it than a control shows, its options are listed in full
 * above the controls, which then carry only their numbers.
 *
 * A form asking someone to approve something mentions whoever started the task,
 * so it reaches the person who asked for the work instead of waiting in a thread
 * nobody is watching (see {@link approvalPing}). Anyone in the thread may still
 * answer it.
 */

/** Slack's cap on one section's text. */
const SECTION_TEXT = 3_000;

/**
 * The text one message's blocks may hold in all. Slack documents 50 blocks of
 * up to 3,000 each, yet refuses a message whose blocks hold about 13,000
 * (`msg_blocks_too_long`); this stays under that.
 */
const MESSAGE_TEXT = 12_000;

/** Past roughly this many characters Slack's client clips a button's label. */
const VISIBLE_BUTTON_LABEL = 30;

/** Slack's cap on a button's, or a radio or select option's, text. */
const CONTROL_TEXT = 75;

/** Slack's caps on a radio group's or checkbox group's options, and a select's. */
const GROUP_OPTIONS = 10;
const SELECT_OPTIONS = 100;

/** Slack's cap on a modal's blocks. */
const VIEW_BLOCKS = 100;

/** The notification fallback sent as `text` beside the blocks. */
const FALLBACK_TEXT = 3_000;

const FENCE = "```";

/** The `callback_id` of the modal a form is answered in. */
export const FORM_CALLBACK_ID = "hitl-form";

/** Action ids on the prompt's controls: a pick (`-<n>` per option), and "open a modal". */
export const PICK_ACTION = "hitl-pick";
export const OPEN_ACTION = "hitl-open";

/** Action id of the Back button on a paged form's later pages. */
export const BACK_ACTION = "hitl-back";

/**
 * What a control's `value` carries: the request, which question and option, and
 * for Back the page it goes to. A control is found by its value rather than its
 * action id, which Slack caps at 255 characters — less than an agent's request
 * id may be.
 */
export interface ControlValue {
  r: string;
  q?: number;
  o?: number | "approve" | "reject";
  p?: number;
}

/**
 * What a modal's `private_metadata` carries: the request, and the page of the
 * form it shows — none for one question's words alone.
 */
export interface ViewMeta {
  r: string;
  p?: number;
}

/**
 * The `block_id` of a question's input in the modal: its position, its kind,
 * and `+` when it takes several picks — everything checking a submission needs,
 * which has to happen before Slack's 3s run out, with no read in between.
 */
export function inputBlockId(index: number, question: HitlQuestion): string {
  const many = question.kind === "choice" && question.multiple === true;
  return `q${index}:${question.kind}${many ? "+" : ""}`;
}

/** The `block_id` of the words typed beside, or instead of, a question's picks. */
export function otherBlockId(index: number): string {
  return `q${index}:other`;
}

export interface SectionBlock {
  type: "section";
  text: { type: "mrkdwn"; text: string };
}

function section(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): unknown {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function plain(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text };
}

/** Agent Markdown as Slack mrkdwn, with channel-wide mentions defused. */
function toMrkdwn(markdown: string): string {
  let mrkdwn: string;
  try {
    mrkdwn = slackifyMarkdown(markdown).trim();
  } catch {
    mrkdwn = markdown;
  }
  // slackifyMarkdown passes `<!…>` through as raw HTML; see sanitizeSlackText.
  return sanitizeSlackText(mrkdwn);
}

/** Text shown as written: mrkdwn's three control characters escaped. */
function escapeMrkdwn(text: string): string {
  return sanitizeSlackText(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isOpenFence(text: string): boolean {
  return (text.split(FENCE).length - 1) % 2 === 1;
}

/**
 * `text` cut to at most `max` with a mark, outside any link or mention it would
 * land in, and any code block it leaves open closed. Too little room for any of
 * the text leaves the mark alone, or nothing.
 */
export function clipMrkdwn(text: string, max: number): string {
  if (text.length <= max) return text;
  const at = max - `\n${FENCE}`.length - 1;
  if (at < 1) return max >= 1 ? "…" : "";
  const safe = outsideMarkup(text, at);
  const cut = `${text.slice(0, safe > 0 ? safe : at)}…`;
  return isOpenFence(cut) ? `${cut}\n${FENCE}` : cut;
}

/**
 * Where a cut at `at` may fall instead, so it breaks no markup: before a
 * `<…>` token it would land in — a link or a mention; Slack escapes a literal
 * `<` as `&lt;`, so an unescaped one opens a token — and before a ``` it would
 * land one or two characters into. `0` when the token starts the text, which
 * then cannot stay whole in any piece.
 */
function outsideMarkup(text: string, at: number): number {
  let cut = at;
  const open = text.lastIndexOf("<", cut - 1);
  if (open !== -1 && text.lastIndexOf(">", cut - 1) < open) cut = open;
  for (const k of [cut - 2, cut - 1]) {
    if (k >= 0 && text.startsWith(FENCE, k)) return k;
  }
  return cut;
}

/**
 * Split mrkdwn into pieces of at most `max` characters, at a paragraph break,
 * then a line break, then a space — never inside a link, a mention or a code
 * fence. A code block split across pieces is closed at the end of one and
 * reopened at the start of the next, so neither piece renders the rest of the
 * message as code.
 *
 * A link or mention longer than a whole piece cannot stay whole in any, so it
 * is cut like prose: the link stops working, and its text still reads.
 */
export function splitMrkdwn(text: string, max = SECTION_TEXT): string[] {
  const pieces: string[] = [];
  // Room to close a code block left open, and to reopen it in the next piece.
  const reserve = `\n${FENCE}`.length + `${FENCE}\n`.length;
  let rest = text;
  let reopen = false;
  while (rest.length > 0) {
    // The block the last piece closed ends right here: reopening it would
    // leave an empty one.
    if (reopen && rest.startsWith(FENCE)) {
      rest = rest.slice(FENCE.length).replace(/^\n/, "");
      reopen = false;
      continue;
    }
    const prefix = reopen ? `${FENCE}\n` : "";
    let piece: string;
    if (prefix.length + rest.length <= max - reserve) {
      piece = prefix + rest;
      rest = "";
    } else {
      const room = max - reserve - prefix.length;
      const floor = Math.floor(room / 2);
      let cut = rest.lastIndexOf("\n\n", room);
      let skip = 2;
      if (cut < floor) {
        cut = rest.lastIndexOf("\n", room);
        skip = 1;
      }
      if (cut < floor) {
        cut = rest.lastIndexOf(" ", room);
        skip = 1;
      }
      if (cut < floor) {
        cut = room;
        skip = 0;
      }
      const safe = outsideMarkup(rest, cut);
      if (safe > 0 && safe !== cut) {
        cut = safe;
        skip = 0;
      }
      piece = prefix + rest.slice(0, cut);
      rest = rest.slice(cut + skip);
    }
    reopen = isOpenFence(piece);
    pieces.push(reopen ? `${piece}\n${FENCE}` : piece);
  }
  return pieces;
}

/**
 * mrkdwn as sections, holding at most `budget` characters in all. Past it the
 * text is cut and `cutNote` says so, in the text itself.
 */
function sections(
  mrkdwn: string,
  budget: number,
  cutNote: string
): SectionBlock[] {
  const note = `\n\n_${cutNote}_`;
  const text =
    mrkdwn.length > budget
      ? `${clipMrkdwn(mrkdwn, Math.max(0, budget - note.length))}${note}`
      : mrkdwn;
  return text ? splitMrkdwn(text).map(section) : [];
}

const CUT_PROMPT = "Cut here to fit Slack; the rest opens with the questions.";

/** The longest a question's words run where the message names it in a line. */
const GLANCE = 150;
const CUT_ANSWER = "Cut here to fit Slack; the agent has the full answer.";

/** An option's sample: as a code block, the nearest Slack has to a preview. */
function exampleMrkdwn(example: string): string {
  return example.includes(FENCE)
    ? toMrkdwn(example)
    : `${FENCE}\n${escapeMrkdwn(example)}\n${FENCE}`;
}

/** An option's description, and its example as a code block. */
function optionDetail(o: HitlOption): string {
  return [
    o.description ? toMrkdwn(o.description) : "",
    o.example ? exampleMrkdwn(o.example) : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function optionList(options: readonly HitlOption[]): string {
  return options
    .map((o, j) => {
      const head = `*${j + 1}.* ${toMrkdwn(o.label)}`;
      const shown = optionDetail(o);
      return shown ? `${head}\n${shown}` : head;
    })
    .join("\n\n");
}

/** A link a person can open — only an https one, and only as itself. */
function artifactLink(url: string): string {
  return /^https:\/\/[^\s<>|]+$/.test(url)
    ? `:page_facing_up: <${url}>`
    : escapeMrkdwn(url);
}

/**
 * Whether a question's options are listed in full above its controls: when a
 * control showing `shown` characters cannot carry one whole — a longer label, a
 * description, an example. Otherwise the controls carry the labels alone.
 */
function listsOptions(question: HitlQuestion, shown: number): boolean {
  return (
    question.kind === "choice" &&
    question.options.some(
      (o) =>
        o.label.length > shown || Boolean(o.description) || Boolean(o.example)
    )
  );
}

/**
 * A question as it reads: its header over its words. Not numbered — the
 * numbers are its options'.
 */
function questionMrkdwn(question: HitlQuestion, withOptions: boolean): string {
  const prompt = toMrkdwn(question.prompt);
  const head = question.header
    ? `*${toMrkdwn(question.header)}*\n${prompt}`
    : prompt;
  const lines = [head];
  if (question.kind === "choice" && withOptions) {
    lines.push(optionList(question.options));
  }
  if (question.kind === "approval") {
    lines.push(artifactLink(question.artifact.url));
  }
  return lines.join("\n\n");
}

/** A question answered in the thread as its message shows it: the agent's words over it. */
function quickMrkdwn(request: HitlRequest, question: HitlQuestion): string {
  return [
    request.prompt ? toMrkdwn(request.prompt) : "",
    questionMrkdwn(question, listsOptions(question, VISIBLE_BUTTON_LABEL))
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The one question answered by buttons in the thread: when the form is that,
 * and it fits one message whole. One that does not is answered in the modal,
 * which shows it whole — a message shortened to fit would show buttons beside
 * options nobody can read in full.
 */
function quickQuestion(request: HitlRequest): HitlQuestion | undefined {
  if (request.questions.length !== 1) return undefined;
  const [question] = request.questions;
  const answeredHere =
    question.kind === "approval" ||
    (question.kind === "choice" &&
      !question.multiple &&
      question.options.length <= GROUP_OPTIONS);
  return answeredHere && quickMrkdwn(request, question).length <= MESSAGE_TEXT
    ? question
    : undefined;
}

/**
 * The questions named in a line each, for a form whose agent said nothing
 * around them: the message then still says what is being asked.
 */
function glance(request: HitlRequest): string {
  return request.questions
    .map((q) =>
      q.header
        ? `• *${toMrkdwn(q.header)}*`
        : `• ${clipMrkdwn(toMrkdwn(q.prompt.split("\n")[0] ?? ""), GLANCE)}`
    )
    .join("\n");
}

/** Whether the agent's words run past the message, so the modal opens with them. */
function promptCut(request: HitlRequest): boolean {
  return (
    quickQuestion(request) === undefined &&
    request.prompt !== undefined &&
    toMrkdwn(request.prompt).length > MESSAGE_TEXT
  );
}

/**
 * What the message says above its controls. A question answered in the thread
 * is in it, with its options, since its buttons answer it there. A form answered
 * in the modal is not: the message holds only the agent's words, and the modal
 * the questions.
 */
function messageText(request: HitlRequest): string {
  const quick = quickQuestion(request);
  if (quick) return quickMrkdwn(request, quick);
  return request.prompt ? toMrkdwn(request.prompt) : glance(request);
}

function button(
  text: string,
  actionId: string,
  value: ControlValue,
  style?: "primary" | "danger"
): unknown {
  return {
    type: "button",
    action_id: actionId,
    text: plain(clip(text, CONTROL_TEXT)),
    value: JSON.stringify(value),
    ...(style ? { style } : {})
  };
}

/** The prompt's controls. */
function controlBlocks(request: HitlRequest): unknown[] {
  const r = request.requestId;
  const question = quickQuestion(request);
  let elements: unknown[];
  if (!question) {
    elements = [button("Answer", OPEN_ACTION, { r }, "primary")];
  } else if (question.kind === "approval") {
    elements = [
      button(
        "Approve",
        `${PICK_ACTION}-0`,
        { r, q: 0, o: "approve" },
        "primary"
      ),
      button("Reject", `${PICK_ACTION}-1`, { r, q: 0, o: "reject" }, "danger"),
      button("Comment…", OPEN_ACTION, { r, q: 0 })
    ];
  } else if (question.kind === "choice") {
    // Numbers, when the message lists the options they stand for.
    const numbers = listsOptions(question, VISIBLE_BUTTON_LABEL);
    elements = [
      ...question.options.map((o, j) =>
        button(numbers ? String(j + 1) : o.label, `${PICK_ACTION}-${j}`, {
          r,
          q: 0,
          o: j
        })
      ),
      button("Other…", OPEN_ACTION, { r, q: 0 })
    ];
  } else {
    elements = [];
  }
  return [{ type: "actions", block_id: "hitl-controls", elements }];
}

/**
 * The line that puts an approval in front of the person who started the task: a
 * mention of them, which is what Slack notifies on. None when the form asks for
 * no approval — a question is the agent's to raise, but waking somebody up is
 * not, so only the decision it cannot make without a person gets a ping.
 *
 * `startedBy` is the Slack user id of whoever sent the message that woke the
 * agent, carried on the task row (`agent_tasks.started_by`) since dispatch. It
 * is deliberately not read from the form: every string in there is the agent's,
 * so a form that named its own mention would let the agent decide who this line
 * wakes. (An agent can still mention people in its own prose — `<@U…>` survives
 * `sanitizeSlackText` by design — but then it is the agent's words saying so,
 * not the gatekeeper's.) Null where the task row has nobody to name: a feed turn
 * for an edit or delete, or a row predating the column. The prompt then carries
 * no mention.
 */
function approvalPing(
  request: HitlRequest,
  startedBy: string | null | undefined
): string | undefined {
  const asksApproval = request.questions.some((q) => q.kind === "approval");
  // A Slack user id is alphanumeric; anything else has no place inside a mention
  // token, where a `>` would end it early and the rest would render as text.
  const named = startedBy ? /^[A-Z0-9]+$/i.test(startedBy) : false;
  return named && asksApproval
    ? `<@${startedBy}> — this needs your approval.`
    : undefined;
}

/**
 * The open prompt: who it is for when it asks for an approval, what
 * {@link messageText} says, then the controls.
 *
 * The mention is a block of its own rather than part of the message's text, so
 * the agent's words keep the whole {@link MESSAGE_TEXT} budget they had and a
 * form that only just fit is not cut to make room for it.
 */
export function requestBlocks(
  request: HitlRequest,
  startedBy?: string | null
): unknown[] {
  const ping = approvalPing(request, startedBy);
  return [
    ...(ping ? [section(ping)] : []),
    ...sections(messageText(request), MESSAGE_TEXT, CUT_PROMPT),
    ...controlBlocks(request)
  ];
}

/** A prompt closed without an answer — expired, or its task over — under `note`. */
export function resolvedBlocks(request: HitlRequest, note: string): unknown[] {
  return [
    ...sections(messageText(request), MESSAGE_TEXT, CUT_PROMPT),
    context(note)
  ];
}

/**
 * The answered prompt: each question as it was asked, its answer under it, in
 * what room the message has — the preamble giving way first. A long typed
 * answer is cut here only — the agent was sent all of it.
 */
export function answeredBlocks(input: {
  request: HitlRequest;
  answers: Record<string, HitlAnswer>;
  answeredBy: string;
}): unknown[] {
  const { request } = input;
  const byId = new Map(
    answeredQuestions(request, input.answers).map((a) => [a.question.id, a])
  );
  const body = request.questions.map((q) => {
    const answer = byId.get(q.id);
    const picked = (answer?.picked ?? []).map((p) => `*${toMrkdwn(p)}*`);
    const words = [picked.join(", "), answer?.text && escapeMrkdwn(answer.text)]
      .filter(Boolean)
      .join("\n");
    return `${questionMrkdwn(q, false)}\n:white_check_mark: ${words}`;
  });
  // The answers before the preamble: it is shortened into what they leave.
  const answered = body.join("\n\n");
  const preamble = request.prompt
    ? clipMrkdwn(
        toMrkdwn(request.prompt),
        Math.max(1, MESSAGE_TEXT - answered.length - "\n\n".length)
      )
    : "";
  const text = [preamble, answered].filter(Boolean).join("\n\n");
  return [
    ...sections(text, MESSAGE_TEXT, CUT_ANSWER),
    context(`Answered by <@${input.answeredBy}>`)
  ];
}

/** What the prompt says when even {@link answeredBlocks} could not be shown. */
export function answeredFallbackBlocks(answeredBy: string): unknown[] {
  return [section(`:white_check_mark: Answered by <@${answeredBy}>.`)];
}

/**
 * An option as its control shows it: the label, numbered when the options are
 * listed above — whose descriptions are there, not repeated under each control.
 */
function choiceOption(
  option: HitlOption,
  index: number,
  numbered: boolean
): unknown {
  return {
    text: plain(
      clip(
        numbered ? `${index + 1}. ${option.label}` : option.label,
        CONTROL_TEXT
      )
    ),
    value: String(index)
  };
}

/** Words already entered, put back in an input. */
function initialText(text: string | undefined): { initial_value?: string } {
  return text ? { initial_value: text } : {};
}

/**
 * The element a question is answered with — a group for a few options, a select
 * for more — holding `answer` when the person has already given one.
 */
function inputElement(question: HitlQuestion, answer?: HitlAnswer): unknown {
  const picked = (value: string) => answer?.optionIds?.includes(value) ?? false;
  switch (question.kind) {
    case "text":
      return {
        type: "plain_text_input",
        action_id: "value",
        multiline: true,
        // No `max_length`: answers past 3,000 characters reach the agent
        // without one, and setting it would cap them there.
        ...initialText(answer?.text)
      };
    case "approval": {
      const options = [
        { text: plain("Approve"), value: HITL_APPROVE_OPTION_ID },
        { text: plain("Reject"), value: HITL_REJECT_OPTION_ID }
      ];
      const initial = options.find((o) => picked(o.value));
      return {
        type: "radio_buttons",
        action_id: "value",
        options,
        ...(initial ? { initial_option: initial } : {})
      };
    }
    case "choice": {
      const few = question.options.length <= GROUP_OPTIONS;
      const numbered = listsOptions(question, CONTROL_TEXT);
      const options = question.options
        .slice(0, SELECT_OPTIONS)
        .map((o, j) => choiceOption(o, j, numbered));
      const initial = options.filter((_, j) => picked(question.options[j]!.id));
      if (question.multiple) {
        return {
          type: few ? "checkboxes" : "multi_static_select",
          action_id: "value",
          options,
          ...(initial.length > 0 ? { initial_options: initial } : {})
        };
      }
      return {
        type: few ? "radio_buttons" : "static_select",
        action_id: "value",
        options,
        ...(initial[0] ? { initial_option: initial[0] } : {})
      };
    }
  }
}

function textInput(
  blockId: string,
  label: string,
  optional: boolean,
  initial?: string
): unknown {
  return {
    type: "input",
    block_id: blockId,
    label: plain(label),
    optional,
    element: {
      type: "plain_text_input",
      action_id: "value",
      multiline: true,
      ...initialText(initial)
    }
  };
}

function preambleBlocks(request: HitlRequest): unknown[] {
  return request.prompt
    ? splitMrkdwn(toMrkdwn(request.prompt)).map(section)
    : [];
}

/** What an input is labelled: what to do with it — the question is right above. */
function inputLabel(question: HitlQuestion): string {
  switch (question.kind) {
    case "choice":
      return question.multiple ? "Pick any" : "Pick one";
    case "approval":
      return "Approve or reject";
    case "text":
      return "Your answer";
  }
}

/** One question in the modal, whole, with its inputs holding `answer` if given. */
function questionBlocks(
  question: HitlQuestion,
  index: number,
  answer?: HitlAnswer
): unknown[] {
  const blocks: unknown[] = [
    ...splitMrkdwn(
      questionMrkdwn(question, listsOptions(question, CONTROL_TEXT))
    ).map(section),
    {
      type: "input",
      block_id: inputBlockId(index, question),
      label: plain(inputLabel(question)),
      // A pick may be left for an answer typed in Other instead; a text
      // question has only its words, which Slack then requires.
      optional: question.kind !== "text",
      element: inputElement(question, answer)
    }
  ];
  // Words typed here are the answer an option did not offer, so this is the
  // option an agent never lists: see `ask_user`'s options in core.
  if (question.kind === "choice") {
    blocks.push(textInput(otherBlockId(index), "Other", true, answer?.text));
  }
  if (question.kind === "approval") {
    blocks.push(textInput(otherBlockId(index), "Comment", true, answer?.text));
  }
  return blocks;
}

/**
 * The form's pages, as the positions of the questions on each. One page when the
 * whole form fits a modal. Past that, each page holds as many questions as fit,
 * whole and in order — the agent's words on the first, when the message could
 * not hold them all, and room for Back on every one — and the gate keeps each
 * person's answers between pages until they send them all at once (see
 * `saveHitlDraft` in `src/db/models/hitl-forms.ts`).
 */
export function formPages(request: HitlRequest): number[][] {
  const sizes = request.questions.map((q, i) => questionBlocks(q, i).length);
  const preamble = promptCut(request) ? preambleBlocks(request).length : 0;
  if (preamble + sizes.reduce((a, b) => a + b, 0) <= VIEW_BLOCKS) {
    return [request.questions.map((_, i) => i)];
  }
  const room = VIEW_BLOCKS - 1;
  const pages: number[][] = [[]];
  let used = preamble;
  sizes.forEach((size, i) => {
    const page = pages[pages.length - 1]!;
    if (page.length > 0 && used + size > room) {
      pages.push([i]);
      used = size;
    } else {
      page.push(i);
      used += size;
    }
  });
  return pages;
}

function backBlock(requestId: string, page: number): unknown {
  return {
    type: "actions",
    block_id: "hitl-back",
    elements: [button("← Back", BACK_ACTION, { r: requestId, p: page })]
  };
}

/**
 * A page of the modal a form is answered in: each of its questions whole, with
 * an input of its own holding what `answers` has for it. A form of one page is
 * sent from it; a longer one goes Next page by page, and is sent from its last.
 */
export function formView(
  request: HitlRequest,
  page = 0,
  answers: Record<string, HitlAnswer> = {}
): Record<string, unknown> {
  const pages = formPages(request);
  const at = Math.min(Math.max(page, 0), pages.length - 1);
  const meta: ViewMeta = { r: request.requestId, p: at };
  const blocks = [
    // The message holds the agent's words — unless they ran past it.
    ...(at === 0 && promptCut(request) ? preambleBlocks(request) : []),
    ...pages[at]!.flatMap((i) => {
      const question = request.questions[i]!;
      const answer = Object.hasOwn(answers, question.id)
        ? answers[question.id]
        : undefined;
      return questionBlocks(question, i, answer);
    }),
    ...(at > 0 ? [backBlock(request.requestId, at - 1)] : [])
  ];
  return {
    type: "modal",
    callback_id: FORM_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: plain(
      pages.length > 1
        ? `Your answer · ${at + 1} of ${pages.length}`
        : "Your answer"
    ),
    submit: plain(at === pages.length - 1 ? "Send" : "Next"),
    close: plain("Cancel"),
    blocks
  };
}

/**
 * One question's words alone — what "Other…" and "Comment…" open, from a
 * message that already lists its options.
 */
export function wordsView(
  request: HitlRequest,
  index: number
): Record<string, unknown> {
  const question = request.questions[index];
  if (!question) return formView(request);
  const meta: ViewMeta = { r: request.requestId };
  return {
    type: "modal",
    callback_id: FORM_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: plain("Your answer"),
    submit: plain("Send"),
    close: plain("Cancel"),
    blocks: [
      ...splitMrkdwn(questionMrkdwn(question, false)).map(section),
      textInput(
        otherBlockId(index),
        question.kind === "approval" ? "Comment" : "Other",
        false
      )
    ]
  };
}

/** `text` for a Block Kit message: the notification fallback, cut to stay accepted. */
export function fallbackText(text: string): string {
  return clip(text, FALLBACK_TEXT);
}

/**
 * The form in a line or two, for a notification. An approval's mention leads it,
 * because this text is the fallback Slack falls back *to* — on a surface that
 * does not render the blocks, it is all there is — and leading it is what keeps
 * the mention out of the cut when a long form runs past {@link FALLBACK_TEXT}.
 */
export function requestFallbackText(
  request: HitlRequest,
  startedBy?: string | null
): string {
  return fallbackText(
    [
      approvalPing(request, startedBy),
      request.prompt,
      ...request.questions.map((q) => q.prompt)
    ]
      .filter(Boolean)
      .join("\n\n")
  );
}
