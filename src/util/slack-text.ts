/**
 * Channel-wide mentions, in both spellings Slack accepts:
 *
 *  - the *command sequence* `<!channel>` / `<!here>` / `<!everyone>` / `<!subteam^S…>`,
 *    which Slack always renders in a message's `text` as a broadcast @-notification;
 *  - the *plain* `@channel` / `@here` / `@everyone`, which Slack links up whenever a
 *    message is posted with `link_names`.
 *
 * Both are neutralized by dropping the marker (`<!here>` and `@here` alike become
 * `here`), which no re-parse can turn back into a ping. `slackifyMarkdown` passes
 * `<!…>` through verbatim — it treats it as raw HTML — so this module, not the
 * markdown conversion, is what stands between untrusted text and a channel-wide ping.
 */
const COMMAND_SEQUENCE = /<!([^>\n]*)>/;
const COMMAND_SEQUENCE_ALL = new RegExp(COMMAND_SEQUENCE, "g");

// `@channel` and friends. The lookbehind keeps an address (`ops@here.com`) and the
// `\b` keeps a longer word (`@channels`) out of it; `@channel-ops` does match, which
// is the conservative side to err on.
const PLAIN_BROADCAST = /(?<![\w@])@(channel|here|everyone)\b/i;
const PLAIN_BROADCAST_ALL = new RegExp(PLAIN_BROADCAST, "gi");

/** Does this string carry a channel-wide mention in either spelling? */
export function hasSlackBroadcast(text: string): boolean {
  return COMMAND_SEQUENCE.test(text) || PLAIN_BROADCAST.test(text);
}

/**
 * Make untrusted text safe to hand to Slack as message text: strip C0 control
 * characters (keeping `\t`, `\n`, `\r`) and neutralize channel-wide mentions in
 * both spellings. Mentions of a single user or channel (`<@U…>`, `<#C…>`) are
 * intentionally left intact — they notify one person or link one channel.
 */
export function sanitizeSlackText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(COMMAND_SEQUENCE_ALL, "$1")
    .replace(PLAIN_BROADCAST_ALL, "$1");
}

/**
 * Make a display name safe to render in Slack. A display name is untrusted from
 * every direction: the admin agent's model names itself with
 * `self_set_display_name`, names custom agents with `agents_create`/`agents_update`,
 * and an un-overridden custom agent inherits the name published on the remote's own
 * A2A card. It is not only `chat.postMessage`'s `username` (which Slack does not
 * parse) — it is also interpolated into message *text* on the agent-failure notice,
 * where a `<!channel>`/`@channel` name would fire a channel-wide ping. So it goes
 * through the same sanitizer as reply text, with whitespace collapsed to keep it
 * one line.
 *
 * Applied by **every writer** of a display name (`registerAgent`, `updateAgent`,
 * `setAdminDisplayName`), so an unsafe name cannot exist in the database and read
 * paths need no guard of their own. Returns "" when nothing renderable survives;
 * writers store null and rendering falls back to the agent's machine name.
 */
export function sanitizeDisplayName(name: string): string {
  return sanitizeSlackText(name).replace(/\s+/g, " ").trim();
}

/**
 * Pick the best available display name from Slack user fields.
 * Prefers display_name → real_name → name. Returns null if all are blank.
 */
export function pickDisplayName(
  displayName?: string | null,
  realName?: string | null,
  name?: string | null
): string | null {
  return displayName?.trim() || realName?.trim() || name?.trim() || null;
}
