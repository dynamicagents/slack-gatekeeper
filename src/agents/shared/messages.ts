import type { ModelMessage, UIMessage } from "ai";
import { convertToModelMessages } from "ai";
import type {
  SessionMessage,
  SessionMessagePart
} from "agents/experimental/memory/session";
import { isRecord, jsonOf } from "@/util/json";

/**
 * Glue between A2A text and the Agents SDK Sessions store.
 *
 * A user turn is plain text. An assistant turn is its final text **plus the tool
 * calls it actually made** — see {@link assistantSessionMessage} for why that
 * second half exists and {@link toModelMessages} for how it is replayed.
 *
 * `SessionMessagePart` is structurally the AI SDK's `UIMessagePart` (it declares
 * `toolCallId` / `toolName` / `input` / `output` / `state`), so the two shapes are
 * the same shape and the SDK's own converter can do the replay. Shared by every
 * in-repo agent.
 */

/**
 * Who authored a turn — the WHO the Gatekeeper renders into the `<turn>` wrapper.
 * Used to attribute "who said what" in multi-actor channels (e.g. the admin
 * channel) where a flat `role: "user"` is ambiguous.
 */
export interface TurnAuthor {
  /** Stable actor key — the raw Slack user id (e.g. `U123`). */
  id: string;
  /** Human-readable name, falling back to the raw user id. */
  label: string;
}

/**
 * Structured, extensible source-of-truth for a user turn's provenance —
 * who / where / when. {@link renderTurn} projects it into the persisted text;
 * adding a future field means adding an attribute, not changing the format.
 */
export interface TurnContext {
  /** WHO authored the turn. */
  author: TurnAuthor;
  /** WHERE — resolved channel name (e.g. `general`), or the channel id as a fallback. Never null. */
  channel: string;
  /** WHEN — the turn instant as ISO-8601 (see {@link slackTsToIso}). */
  at: string;
}

/** Derive a {@link TurnAuthor} from a Slack-resolved caller. */
export function authorFromUser(user: {
  slackUserId: string;
  displayName: string | null;
}): TurnAuthor {
  return {
    id: user.slackUserId,
    label: user.displayName ?? user.slackUserId
  };
}

const ATTR_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
};

/** Escape a value for safe use inside a double-quoted XML attribute. */
function escAttr(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ATTR_ESCAPES[c]);
}

/**
 * Strip any `<turn …>` / `</turn>` lookalikes from user body text so a crafted
 * message cannot inject gatekeeper-authored provenance wrappers into model context.
 */
function sanitizeBody(text: string): string {
  return text.replace(/<\s*\/?\s*turn(\s[^>]*)?\s*>/gi, "");
}

/** Convert a Slack message ts (`"1719331800.123456"`) to an ISO-8601 instant. */
export function slackTsToIso(ts: string): string {
  return new Date(Math.round(parseFloat(ts) * 1000)).toISOString();
}

/**
 * Project a {@link TurnContext} into the authoritative `<turn>` wrapper the
 * Gatekeeper inlines into the outbound message text — the single source of
 * who/where/when read by the model, by remote agents, and (via {@link parseTurn})
 * by the recall archiver. Attributes are escaped with {@link escAttr}; the body
 * is sanitized with {@link sanitizeBody} to strip any `<turn>`/`</turn>` lookalikes
 * that could spoof provenance in the model-visible history.
 */
export function renderTurn(text: string, ctx: TurnContext): string {
  return (
    `<turn from="${escAttr(ctx.author.label)}"` +
    ` id="${escAttr(ctx.author.id)}"` +
    ` channel="${escAttr(ctx.channel)}"` +
    ` at="${escAttr(ctx.at)}">` +
    `${sanitizeBody(text)}</turn>`
  );
}

/** Build the {@link TurnContext} the Gatekeeper wraps each outbound turn with. */
export function turnContextFromPayload(p: {
  user: { slackUserId: string; displayName: string | null };
  channelId: string;
  channelName: string | null;
  messageTs: string;
}): TurnContext {
  return {
    author: authorFromUser(p.user),
    channel: p.channelName ?? p.channelId,
    at: slackTsToIso(p.messageTs)
  };
}

const ATTR_UNESCAPES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"'
};

/** Inverse of {@link escAttr} — single-pass so escaped `&amp;` round-trips. */
function unescAttr(value: string): string {
  return value.replace(/&(amp|lt|gt|quot);/g, (_, e) => ATTR_UNESCAPES[e]);
}

/** The fields recovered from a rendered `<turn>` wrapper. */
export interface ParsedTurn {
  from: string;
  /** Slack user id, as rendered. */
  id: string;
  channel: string;
  at: string;
  /** The raw inner words. */
  body: string;
}

const TURN_TAG_RE = /^<turn\b([^>]*)>([\s\S]*)<\/turn>$/;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) out[m[1]] = m[2];
  return out;
}

/**
 * Inverse of {@link renderTurn}: recover the structured provenance from a
 * Gatekeeper-authored turn. Returns null for any text that isn't a `<turn>` wrapper
 * (assistant replies, plain text), so callers can treat the fields as optional.
 */
export function parseTurn(text: string): ParsedTurn | null {
  const m = TURN_TAG_RE.exec(text);
  if (!m) return null;
  const attrs = parseAttrs(m[1]);
  if (!attrs.from || !attrs.id || !attrs.channel || !attrs.at) return null;
  return {
    from: unescAttr(attrs.from),
    id: unescAttr(attrs.id),
    channel: unescAttr(attrs.channel),
    at: unescAttr(attrs.at),
    body: m[2]
  };
}

export function userSessionMessage(text: string): SessionMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    createdAt: new Date(),
    parts: [{ type: "text", text }]
  };
}

/**
 * One tool call a turn actually made, as it is recorded in history. `errorText`
 * is set *instead of* `output` when the call itself failed (a schema rejection,
 * or a throw from the handler) — note that most in-repo tools report refusals as
 * an ordinary `{ error: … }` output rather than failing, and those are `output`s.
 */
export interface ToolRecord {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  errorText?: string;
}

/**
 * Ceiling on one recorded value — a call's output, or any single property of its
 * input. History is replayed on
 * every subsequent turn and counted toward compaction, so one broad read must not
 * be able to crowd out the conversation on its own. Truncation is explicit in the
 * value so the model can tell "large result" from "small result".
 */
export const MAX_TOOL_RECORD_CHARS = 1500;

/** Cap a plain string — the readable form, so it is measured and cut as itself. */
function capText(text: string): string {
  return text.length <= MAX_TOOL_RECORD_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_RECORD_CHARS)}… [truncated, ${text.length} chars total]`;
}

/**
 * Cap one recorded value, keeping small values structured.
 *
 * A string is capped as a string. Measuring it by its JSON encoding instead would
 * charge it for quotes and escapes it does not have, prefix the stored value with
 * a stray `"`, and — because an escape is two characters — could cut between the
 * `\` and its escaped character, leaving a dangling backslash in the transcript.
 *
 * Anything else is measured by its serialization, and a value over the ceiling is
 * replaced by a clearly-marked preview: past the cut it is prose for the model to
 * read, not JSON for anything to parse.
 */
function cap(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") return capText(value);
  const json = jsonOf(value);
  if (json.length <= MAX_TOOL_RECORD_CHARS) return value;
  return `${json.slice(0, MAX_TOOL_RECORD_CHARS)}… [truncated, ${json.length} chars total]`;
}

/**
 * Cap a recorded call's **input**, which — unlike its output — must survive as an
 * *object*.
 *
 * A tool call's arguments are a JSON object by contract, and every provider
 * re-serializes a replayed call as `arguments: JSON.stringify(input)`. Capping the
 * whole value the way {@link cap} does would put a *string* there: Workers AI
 * rejects that outright on `glm-5.2` ("Assistant tool call function.arguments must
 * be a JSON object"), and on `glm-4.7-flash` the chat template calls `.items()` on
 * it and dies with `'str object' has no attribute 'items'`. Because history is
 * replayed on every later turn, one such record fails *every* subsequent turn — a
 * durable break, not a blip.
 *
 * So the ceiling is applied per property instead. The keys and the shape survive,
 * the over-long values carry the same truncation marker they always did, and the
 * model reads a call it can still recognize rather than one opaque blob.
 *
 * A non-object input is not a tool call the model got merely too verbose about — it
 * is one the SDK could not parse at all, and hands back as the raw arguments string
 * (`invalid: true`). That still has to be replayed as an object, so it is wrapped
 * rather than dropped: the malformed text stays visible to the next turn.
 */
function capInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, cap(v)])
    );
  }
  return { _raw: capText(typeof value === "string" ? value : jsonOf(value)) };
}

/**
 * One recorded call as a message part.
 *
 * Cast at the boundary because `SessionMessagePart` is the Session's deliberately
 * *minimal* shape; the full contract is the AI SDK's `ToolUIPart`, which is what
 * {@link toModelMessages} hands back to the converter, and only that one declares
 * `errorText`.
 *
 * The part carries its own `input` **and** `output`, so a call and its result can
 * never be separated — including by a compaction boundary landing between them.
 */
function toolPart(record: ToolRecord): SessionMessagePart {
  const call = {
    type: `tool-${record.toolName}`,
    toolCallId: record.toolCallId,
    input: capInput(record.input)
  };
  const part =
    record.errorText === undefined
      ? { ...call, state: "output-available", output: cap(record.output) }
      : {
          ...call,
          state: "output-error",
          errorText: capText(record.errorText)
        };
  return part as SessionMessagePart;
}

/**
 * The assistant's turn: what it did, then what it said.
 *
 * `actions` are the tool calls the turn really made. Persisting them is what stops
 * a fabricated claim compounding: with only the final text in history, a turn that
 * announced "Done ✅" while calling nothing was indistinguishable from one that did
 * the work, and every later turn read the claim back as fact. Now the transcript
 * either contains the call or visibly does not.
 *
 * The `step-start` separator flushes the converter's block so the replayed
 * transcript is chronological — results land *before* the reply that describes
 * them, rather than after it.
 */
export function assistantSessionMessage(
  text: string,
  actions: ToolRecord[] = []
): SessionMessage {
  const parts: SessionMessagePart[] = actions.map(toolPart);
  if (parts.length > 0) parts.push({ type: "step-start" });
  parts.push({ type: "text", text });
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    createdAt: new Date(),
    parts
  };
}

/** Concatenate the text parts of a stored session message. */
export function sessionText(m: SessionMessage): string {
  return m.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/**
 * Replay stored history as AI-SDK model messages.
 *
 * Delegates to the SDK's own `convertToModelMessages` rather than joining text by
 * hand: a stored assistant turn is a `UIMessage`, and expanding its tool parts
 * into the `assistant[tool-call]` → `tool[tool-result]` pair every provider
 * expects is exactly what that function is for.
 *
 * Only `user` and `assistant` survive the filter — any other role makes the
 * converter throw, and nothing here writes one. Unrecognized *parts* are ignored
 * by the converter, so a future part type cannot break an existing session.
 */
export async function toModelMessages(
  history: SessionMessage[]
): Promise<ModelMessage[]> {
  const messages = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      // Same shape, narrower declaration — see {@link toolPart}.
      parts: m.parts as UIMessage["parts"]
    }));
  return convertToModelMessages(messages, { ignoreIncompleteToolCalls: true });
}
