import {
  inputRequestToSlackBlocks,
  SLACK_FREEFORM_ACTION_ID,
  SLACK_FREEFORM_BLOCK_ID,
  SLACK_FREEFORM_CALLBACK_ID,
  type SlackInputOption,
  type SlackInputRequest
} from "@chat-adapter/slack/blocks";
import { slackifyMarkdown } from "slackify-markdown";
import { sanitizeSlackText } from "@/util/slack-text";

/**
 * How a human-in-the-loop prompt looks in Slack: the question, its options, and
 * the states it moves through once answered or closed.
 *
 * Every string the agent or a person wrote fits Slack whole or is cut where the
 * reader can see it — never silently. A question cut at a block limit is a
 * question nobody was asked: one prompt lost every numbered question it held
 * that way, because they all started past the 3,000th character.
 *
 * The adapter still builds the controls, so their action ids and values stay
 * what `parseSlackInputResponse` reads back. Only its prompt section is
 * replaced: it truncates at 3,000 without a mark.
 */

/** Slack's cap on one section's text. */
const SECTION_TEXT = 3_000;

/**
 * The text one message's blocks may hold in all. Slack documents 50 blocks of
 * up to 3,000 each, yet refuses a message whose blocks hold about 13,000
 * (`msg_blocks_too_long`); this stays under that.
 */
const MESSAGE_TEXT = 12_000;

/**
 * What a prompt may take of {@link MESSAGE_TEXT}, so the message still has room
 * for its options while open and for the answer once answered.
 */
const PROMPT_TEXT = 8_000;

/** Past roughly this many characters Slack's client clips a button's label. */
const VISIBLE_BUTTON_LABEL = 30;

/** Slack's cap on a radio or select option's text. */
const OPTION_TEXT = 75;

/** The notification fallback sent as `text` beside the blocks. */
const FALLBACK_TEXT = 3_000;

const FENCE = "```";

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

/** A person's typed text, shown as written: mrkdwn's three control characters escaped. */
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

/** `text` cut to `max` with a mark, and any code block it leaves open closed. */
function clipMrkdwn(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = clip(text, Math.max(1, max - `\n${FENCE}`.length));
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
  return splitMrkdwn(text).map(section);
}

function textLength(blocks: readonly SectionBlock[]): number {
  return blocks.reduce((sum, b) => sum + b.text.text.length, 0);
}

/** The prompt as sections — the same blocks every time, open or resolved. */
export function promptBlocks(prompt: string): SectionBlock[] {
  return sections(
    toMrkdwn(prompt),
    PROMPT_TEXT,
    "The question is cut here: it runs past what one Slack message holds."
  );
}

/**
 * Whether the options are listed in full above their controls, which then show
 * only their numbers. A button shows about 30 characters and a radio or select
 * option at most 75, and none shows a description; a list shows all of it.
 */
function listsOptions(options: readonly SlackInputOption[]): boolean {
  return options.some(
    (o) => o.label.length > VISIBLE_BUTTON_LABEL || Boolean(o.description)
  );
}

/**
 * The options as a numbered list in at most `budget` characters, or `undefined`
 * when not even their headings fit. Every heading is kept whatever it costs the
 * descriptions — a button showing "2" means nothing once the line naming 2 is
 * gone — and the descriptions share what room is left.
 */
function optionList(
  options: readonly SlackInputOption[],
  budget: number
): string | undefined {
  const heads = options.map((o, i) => `*${i + 1}.* ${toMrkdwn(o.label)}`);
  const details = options.map((o) =>
    o.description ? toMrkdwn(o.description) : ""
  );
  const list = (shown: readonly string[]) =>
    heads.map((h, i) => (shown[i] ? `${h}\n${shown[i]}` : h)).join("\n\n");
  const whole = list(details);
  if (whole.length <= budget) return whole;
  const described = details.filter(Boolean).length;
  const room = budget - list([]).length - described;
  if (room < 0) return undefined;
  const share = Math.floor(room / described);
  return list(details.map((d) => (d && share > 0 ? clipMrkdwn(d, share) : "")));
}

function numberedLabel(
  index: number,
  label: string,
  display: SlackInputRequest["display"]
): string {
  return display === "buttons" || display === undefined
    ? String(index + 1)
    : clip(`${index + 1}. ${label}`, OPTION_TEXT);
}

/** The open prompt: its question, its options listed when they need it, its controls. */
export function requestBlocks(req: SlackInputRequest): unknown[] {
  const options = req.options ?? [];
  const prompt = promptBlocks(req.prompt);
  const list = listsOptions(options)
    ? optionList(options, MESSAGE_TEXT - textLength(prompt))
    : undefined;
  const controls = inputRequestToSlackBlocks({
    ...req,
    // Numbered only beside the list that names each number. Without one, a
    // label is cut where the reader can see it, not where the adapter would.
    options: options.map((o, i) => ({
      ...o,
      label:
        list !== undefined
          ? numberedLabel(i, o.label, req.display)
          : clip(o.label, OPTION_TEXT)
    }))
  });
  const listBlocks = list ? splitMrkdwn(list).map(section) : [];
  // The adapter leads with its own prompt section, cut at 3,000 without a mark.
  return [...prompt, ...listBlocks, ...controls.slice(1)];
}

/** A prompt closed without an answer — expired, or its task over — under `note`. */
export function resolvedBlocks(prompt: string, note: string): unknown[] {
  return [...promptBlocks(prompt), context(note)];
}

/**
 * The answered prompt: the question as it was asked, then the answer, in what
 * room the message has left. A long typed answer is cut here only — the agent
 * was sent all of it.
 */
export function answeredBlocks(input: {
  prompt: string;
  answer: string;
  answeredBy: string;
}): unknown[] {
  const prompt = promptBlocks(input.prompt);
  const escaped = escapeMrkdwn(input.answer);
  const shown =
    escaped.includes("\n") || escaped.includes("*") ? escaped : `*${escaped}*`;
  return [
    ...prompt,
    ...sections(
      `:white_check_mark: ${shown}`,
      MESSAGE_TEXT - textLength(prompt),
      "Cut here to fit Slack; the agent has the full answer."
    ),
    context(`Answered by <@${input.answeredBy}>`)
  ];
}

/** What the prompt says when even {@link answeredBlocks} could not be shown. */
export function answeredFallbackBlocks(answeredBy: string): unknown[] {
  return [section(`:white_check_mark: Answered by <@${answeredBy}>.`)];
}

/**
 * The modal a typed answer is written in, with the whole question above it —
 * not cut to a message's budget, which a modal does not share: a prompt as long
 * as one can be stored is a handful of sections, well inside a view's 100.
 */
export function freeformView(input: {
  requestId: string;
  prompt: string;
}): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: SLACK_FREEFORM_CALLBACK_ID,
    private_metadata: input.requestId,
    title: { type: "plain_text", text: "Your answer" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      ...splitMrkdwn(toMrkdwn(input.prompt)).map(section),
      {
        type: "input",
        block_id: SLACK_FREEFORM_BLOCK_ID,
        label: { type: "plain_text", text: "Answer" },
        // No `max_length`: answers past 3,000 characters reach the agent
        // without one, and setting it would cap them there.
        element: {
          type: "plain_text_input",
          action_id: SLACK_FREEFORM_ACTION_ID,
          multiline: true
        }
      }
    ]
  };
}

/** `text` for a Block Kit message: the notification fallback, cut to stay accepted. */
export function fallbackText(text: string): string {
  return clip(text, FALLBACK_TEXT);
}
