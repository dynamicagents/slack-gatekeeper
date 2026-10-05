/**
 * The `<turn>` wrapper: who / where / when, inlined by the gatekeeper into the
 * text of every turn it dispatches, built-in and remote alike.
 *
 * Nothing structured rides beside it. An agent built on `@dynamicagents/core`
 * never sees A2A message metadata — only text crosses into its runtime — so the
 * wrapper is the one place a model reads who is speaking to it.
 */

/**
 * Who authored a turn. Used to attribute "who said what" in multi-actor
 * channels (e.g. the admin channel) where a flat `role: "user"` is ambiguous.
 */
export interface TurnAuthor {
  /** Stable actor key — the raw Slack user id (e.g. `U123`). */
  id: string;
  /** Human-readable name, falling back to the raw user id. */
  label: string;
}

/**
 * Structured source of truth for a user turn's provenance. {@link renderTurn}
 * projects it into the dispatched text; adding a field means adding an
 * attribute, not changing the format.
 */
export interface TurnContext {
  /** WHO authored the turn. */
  author: TurnAuthor;
  /** WHERE — resolved channel name (e.g. `general`), or the channel id as a fallback. Never null. */
  channel: string;
  /** WHEN — the turn instant as ISO-8601 (see {@link slackTsToIso}). */
  at: string;
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
 * Project a {@link TurnContext} into the authoritative `<turn>` wrapper.
 * Attributes are escaped; the body is sanitized so it cannot spoof a wrapper of
 * its own.
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

/**
 * The Slack user id of a turn's author, read back off a wrapper this
 * gatekeeper rendered — or null for text that does not open with one. Only the
 * leading wrapper counts: the body is sanitized of lookalikes, so it is the
 * gatekeeper's own.
 */
export function turnAuthorId(text: string): string | null {
  const m = /^<turn\b[^>]*\sid="([^"]*)"/.exec(text);
  return m ? unescAttr(m[1]) : null;
}

const ATTR_UNESCAPES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"'
};

/** Inverse of {@link escAttr} — single-pass so an escaped `&amp;` round-trips. */
function unescAttr(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot);/g,
    (_, e: string) => ATTR_UNESCAPES[e]
  );
}

/** Build the {@link TurnContext} the gatekeeper wraps each outbound turn with. */
export function turnContextFromPayload(p: {
  user: { slackUserId: string; displayName: string | null };
  channelId: string;
  channelName: string | null;
  messageTs: string;
}): TurnContext {
  return {
    author: {
      id: p.user.slackUserId,
      label: p.user.displayName ?? p.user.slackUserId
    },
    channel: p.channelName ?? p.channelId,
    at: slackTsToIso(p.messageTs)
  };
}
