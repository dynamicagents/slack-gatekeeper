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
 * Everything a person reads is in the message's sections, in full. A control
 * holds at most 75 characters, and a button shows about 30, so a control carries
 * a short label or only an option's number — never the only copy of anything.
 *
 * One question picked from a short list is answered in the thread, by a button
 * per option. Anything else — several questions, several picks, words — opens a
 * modal with an input per question, from one "Answer" button, paged when one
 * modal cannot hold them all: see {@link formPages}.
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

/** Slack's cap on an input block's label. */
const INPUT_LABEL = 2_000;

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
 * `text` cut to `max` with a mark, outside any link or mention it would land
 * in, and any code block it leaves open closed.
 */
function clipMrkdwn(text: string, max: number): string {
  if (text.length <= max) return text;
  const at = Math.max(1, max - `\n${FENCE}`.length - 1);
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
      ? `${mrkdwn.slice(0, Math.max(0, budget - note.length))}…${note}`
      : mrkdwn;
  return text ? splitMrkdwn(text).map(section) : [];
}

const CUT_FORM =
  "Cut here: the questions run past what one Slack message holds.";
const CUT_ANSWER = "Cut here to fit Slack; the agent has the full answer.";

/** An option's sample: as a code block, the nearest Slack has to a preview. */
function exampleMrkdwn(example: string): string {
  return example.includes(FENCE)
    ? toMrkdwn(example)
    : `${FENCE}\n${escapeMrkdwn(example)}\n${FENCE}`;
}

/** What shows under an option's heading: "" for nothing. */
type Detail = (option: HitlOption) => string;

/** An option's description, and its example as a code block. */
const fullDetail: Detail = (o) =>
  [
    o.description ? toMrkdwn(o.description) : "",
    o.example ? exampleMrkdwn(o.example) : ""
  ]
    .filter(Boolean)
    .join("\n");

function optionList(options: readonly HitlOption[], detail: Detail): string {
  return options
    .map((o, j) => {
      const head = `*${j + 1}.* ${toMrkdwn(o.label)}`;
      const shown = detail(o);
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
 * Whether a question's options are listed in full in the message. Always, but
 * for a short list of short labels answered by buttons that show them whole.
 */
function listsOptions(question: HitlQuestion, quick: boolean): boolean {
  if (question.kind !== "choice") return false;
  if (!quick) return true;
  return question.options.some(
    (o) =>
      o.label.length > VISIBLE_BUTTON_LABEL ||
      Boolean(o.description) ||
      Boolean(o.example)
  );
}

/** A question as the message shows it, numbered when the form asks several. */
function questionMrkdwn(
  question: HitlQuestion,
  index: number,
  many: boolean,
  withOptions: boolean,
  detail: Detail = fullDetail
): string {
  const prompt = toMrkdwn(question.prompt);
  const head = !many
    ? prompt
    : question.header
      ? `*${index + 1}. ${toMrkdwn(question.header)}*\n${prompt}`
      : `*${index + 1}.* ${prompt}`;
  const lines = [head];
  if (question.kind === "choice" && withOptions) {
    lines.push(optionList(question.options, detail));
  }
  if (question.kind === "approval") {
    lines.push(artifactLink(question.artifact.url));
  }
  return lines.join("\n\n");
}

/** The one question answered by buttons in the thread, when the form is that. */
function quickQuestion(request: HitlRequest): HitlQuestion | undefined {
  if (request.questions.length !== 1) return undefined;
  const [question] = request.questions;
  if (question.kind === "approval") return question;
  if (
    question.kind === "choice" &&
    !question.multiple &&
    question.options.length <= GROUP_OPTIONS
  ) {
    return question;
  }
  return undefined;
}

function formMrkdwn(
  request: HitlRequest,
  listAll: boolean,
  detail: Detail = fullDetail,
  preamble = request.prompt ? toMrkdwn(request.prompt) : ""
): string {
  const quick = !listAll && quickQuestion(request) !== undefined;
  const many = request.questions.length > 1;
  const body = request.questions.map((q, i) =>
    questionMrkdwn(q, i, many, listsOptions(q, quick), detail)
  );
  return [preamble, ...body].filter(Boolean).join("\n\n");
}

/**
 * The form as the message shows it, in what one message holds. Every question
 * and every option's heading is kept whatever it costs the preamble, the
 * descriptions and the examples — a button showing "2" means nothing once the
 * line naming 2 is gone. A preamble that leaves the headings no room is
 * shortened into what they leave; otherwise descriptions and examples share
 * what room is left. `whole` is whether that held: when even the headings do
 * not fit, the text is cut, and buttons keep their labels.
 */
function fittedForm(
  request: HitlRequest,
  listAll: boolean
): { text: string; whole: boolean } {
  const full = formMrkdwn(request, listAll);
  if (full.length <= MESSAGE_TEXT) return { text: full, whole: true };
  const none: Detail = () => "";
  const bare = formMrkdwn(request, listAll, none);
  if (bare.length > MESSAGE_TEXT && request.prompt) {
    const headings = formMrkdwn(request, listAll, none, "");
    const room = MESSAGE_TEXT - headings.length - "\n\n".length;
    const preamble = clipMrkdwn(toMrkdwn(request.prompt), room);
    if (room > 0 && preamble.length <= room) {
      return {
        text: formMrkdwn(request, listAll, none, preamble),
        whole: true
      };
    }
  }
  const details = request.questions
    .flatMap((q) => (q.kind === "choice" ? q.options : []))
    .map(fullDetail)
    .filter(Boolean);
  const room = MESSAGE_TEXT - bare.length - details.length;
  if (room < 0 || details.length === 0) return { text: bare, whole: false };
  const share = Math.floor(room / details.length);
  const clipped: Detail = (o) => {
    const shown = fullDetail(o);
    return shown && share > 0 ? clipMrkdwn(shown, share) : "";
  };
  return { text: formMrkdwn(request, listAll, clipped), whole: true };
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

/** The prompt's controls. `numbered` is whether the message names every number. */
function controlBlocks(request: HitlRequest, numbered: boolean): unknown[] {
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
    const numbers = numbered && listsOptions(question, true);
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

/** The open prompt: why the agent asks, every question with its options in full, then the controls. */
export function requestBlocks(request: HitlRequest): unknown[] {
  const form = fittedForm(request, false);
  return [
    ...sections(form.text, MESSAGE_TEXT, CUT_FORM),
    ...controlBlocks(request, form.whole)
  ];
}

/** A prompt closed without an answer — expired, or its task over — under `note`. */
export function resolvedBlocks(request: HitlRequest, note: string): unknown[] {
  return [
    ...sections(fittedForm(request, true).text, MESSAGE_TEXT, CUT_FORM),
    context(note)
  ];
}

/**
 * The answered prompt: each question as it was asked, its answer under it, in
 * what room the message has. A long typed answer is cut here only — the agent
 * was sent all of it.
 */
export function answeredBlocks(input: {
  request: HitlRequest;
  answers: Record<string, HitlAnswer>;
  answeredBy: string;
}): unknown[] {
  const { request } = input;
  const many = request.questions.length > 1;
  const byId = new Map(
    answeredQuestions(request, input.answers).map((a) => [a.question.id, a])
  );
  const body = request.questions.map((q, i) => {
    const answer = byId.get(q.id);
    const picked = (answer?.picked ?? []).map((p) => `*${toMrkdwn(p)}*`);
    const words = [picked.join(", "), answer?.text && escapeMrkdwn(answer.text)]
      .filter(Boolean)
      .join("\n");
    return `${questionMrkdwn(q, i, many, false)}\n:white_check_mark: ${words}`;
  });
  const text = [request.prompt ? toMrkdwn(request.prompt) : "", ...body]
    .filter(Boolean)
    .join("\n\n");
  return [
    ...sections(text, MESSAGE_TEXT, CUT_ANSWER),
    context(`Answered by <@${input.answeredBy}>`)
  ];
}

/** What the prompt says when even {@link answeredBlocks} could not be shown. */
export function answeredFallbackBlocks(answeredBy: string): unknown[] {
  return [section(`:white_check_mark: Answered by <@${answeredBy}>.`)];
}

function choiceOption(
  option: HitlOption,
  index: number,
  numbered: boolean,
  withDescription: boolean
): unknown {
  return {
    text: plain(
      clip(
        numbered ? `${index + 1}. ${option.label}` : option.label,
        CONTROL_TEXT
      )
    ),
    value: String(index),
    ...(withDescription && option.description
      ? { description: plain(clip(option.description, CONTROL_TEXT)) }
      : {})
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
      const numbered = listsOptions(question, false);
      const options = question.options
        .slice(0, SELECT_OPTIONS)
        .map((o, j) => choiceOption(o, j, numbered, few));
      const initial = options.filter((_, j) => picked(question.options[j]!.id));
      if (question.multiple) {
        return {
          ...(few
            ? { type: "checkboxes" }
            : { type: "multi_static_select", placeholder: plain("Pick any") }),
          action_id: "value",
          options,
          ...(initial.length > 0 ? { initial_options: initial } : {})
        };
      }
      return {
        ...(few
          ? { type: "radio_buttons" }
          : { type: "static_select", placeholder: plain("Pick one") }),
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

/** One question in the modal, whole, with its inputs holding `answer` if given. */
function questionBlocks(
  question: HitlQuestion,
  index: number,
  many: boolean,
  answer?: HitlAnswer
): unknown[] {
  const label =
    question.header ?? (many ? `Question ${index + 1}` : "Your answer");
  const blocks: unknown[] = [
    ...splitMrkdwn(
      questionMrkdwn(question, index, many, question.kind === "choice")
    ).map(section),
    {
      type: "input",
      block_id: inputBlockId(index, question),
      // The section above shows the header whole.
      label: plain(clip(label, INPUT_LABEL)),
      // A pick may be left for words typed below instead; a text question has
      // only its words, which Slack then requires.
      optional: question.kind !== "text",
      element: inputElement(question, answer)
    }
  ];
  if (question.kind === "choice") {
    blocks.push(
      textInput(
        otherBlockId(index),
        "Or, in your own words",
        true,
        answer?.text
      )
    );
  }
  if (question.kind === "approval") {
    blocks.push(textInput(otherBlockId(index), "Comment", true, answer?.text));
  }
  return blocks;
}

/**
 * The form's pages, as the positions of the questions on each. One page when the
 * whole form fits a modal. Past that, each page holds as many questions as fit,
 * whole and in order — the preamble on the first, and room for Back on every
 * one — and the gate keeps each person's answers between pages until they send
 * them all at once (see `saveHitlDraft` in `src/db/models/hitl-forms.ts`).
 */
export function formPages(request: HitlRequest): number[][] {
  const many = request.questions.length > 1;
  const sizes = request.questions.map(
    (q, i) => questionBlocks(q, i, many).length
  );
  const preamble = preambleBlocks(request).length;
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
  const many = request.questions.length > 1;
  const meta: ViewMeta = { r: request.requestId, p: at };
  const blocks = [
    ...(at === 0 ? preambleBlocks(request) : []),
    ...pages[at]!.flatMap((i) => {
      const question = request.questions[i]!;
      const answer = Object.hasOwn(answers, question.id)
        ? answers[question.id]
        : undefined;
      return questionBlocks(question, i, many, answer);
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

/** One question's words alone — what "Other…" and "Comment…" open. */
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
      ...splitMrkdwn(
        questionMrkdwn(
          question,
          index,
          request.questions.length > 1,
          question.kind === "choice"
        )
      ).map(section),
      textInput(
        otherBlockId(index),
        question.kind === "approval" ? "Comment" : "Your answer",
        false
      )
    ]
  };
}

/** `text` for a Block Kit message: the notification fallback, cut to stay accepted. */
export function fallbackText(text: string): string {
  return clip(text, FALLBACK_TEXT);
}

/** The form in a line or two, for a notification. */
export function requestFallbackText(request: HitlRequest): string {
  return fallbackText(
    [request.prompt, ...request.questions.map((q) => q.prompt)]
      .filter(Boolean)
      .join("\n\n")
  );
}
