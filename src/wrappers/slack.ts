import {
  callSlackApi,
  assertSlackOk,
  postSlackEphemeral,
  updateSlackMessage,
  openSlackView
} from "@chat-adapter/slack/api";
import type { SlackApiResponse } from "@chat-adapter/slack/api";
import { env } from "cloudflare:workers";
import { pickDisplayName } from "@/util/display-name";
import { slackifyMarkdown } from "slackify-markdown";

// Thin, cursor-paginated wrappers over the Slack reads the chat SDK doesn't
// cover. `callSlackApi` only throws on HTTP errors, so we assertSlackOk to
// surface Slack-level failures (e.g. missing_scope) as thrown errors.

interface SlackMember {
  id: string;
  name?: string;
  deleted?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  profile?: { real_name?: string; display_name?: string };
}
interface UsersListResponse extends SlackApiResponse {
  members?: SlackMember[];
}
interface ConversationsMembersResponse extends SlackApiResponse {
  members?: string[];
}
interface ConversationsListResponse extends SlackApiResponse {
  channels?: { id: string; name?: string }[];
}
interface AuthTestResponse extends SlackApiResponse {
  user_id?: string;
  team_id?: string;
}
interface ChatPostMessageResponse extends SlackApiResponse {
  ts?: string;
}

/** A Slack user normalized to the fields the registry cares about. */
export interface SlackUserInfo {
  id: string;
  displayName: string | null;
  isPrimaryOwner: boolean;
  deleted: boolean;
}

function normalizeMember(m: SlackMember): SlackUserInfo {
  const display = pickDisplayName(
    m.profile?.display_name,
    m.profile?.real_name,
    m.name
  );
  return {
    id: m.id,
    displayName: display,
    isPrimaryOwner: m.is_primary_owner === true,
    deleted: m.deleted === true
  };
}

/** Iterate every Slack user via paginated `users.list`. */
export async function* iterateSlackUsers(): AsyncGenerator<SlackUserInfo> {
  let cursor: string | undefined;
  do {
    const res = await callSlackApi<UsersListResponse>(
      "users.list",
      { limit: 200, ...(cursor ? { cursor } : {}) },
      { token: env.SLACK_BOT_TOKEN }
    );
    assertSlackOk("users.list", res);
    for (const m of res.members ?? []) yield normalizeMember(m);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

/** All member ids of a channel via paginated `conversations.members`. */
export async function fetchChannelMemberIds(
  channelId: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await callSlackApi<ConversationsMembersResponse>(
      "conversations.members",
      { channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) },
      { token: env.SLACK_BOT_TOKEN }
    );
    assertSlackOk("conversations.members", res);
    for (const id of res.members ?? []) ids.add(id);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

/**
 * Iterate every named channel (public/private, unarchived) via paginated
 * `conversations.list`. Channels without a name (shouldn't happen for these
 * types) are skipped. Reconcile upserts these into D1 so the message hot path
 * resolves channel names without a Slack call.
 */
export async function* iterateSlackChannels(): AsyncGenerator<{
  id: string;
  name: string;
}> {
  let cursor: string | undefined;
  do {
    const res = await callSlackApi<ConversationsListResponse>(
      "conversations.list",
      {
        limit: 200,
        exclude_archived: true,
        types: "public_channel,private_channel",
        ...(cursor ? { cursor } : {})
      },
      { token: env.SLACK_BOT_TOKEN }
    );
    assertSlackOk("conversations.list", res);
    for (const c of res.channels ?? []) {
      if (c.name) yield { id: c.id, name: c.name };
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

/** The bot's own Slack user id and team id from `auth.test`. */
export interface BotInfo {
  userId: string | null;
  teamId: string | null;
}

// Cached for the isolate lifetime (token never changes while the isolate lives).
let botInfoCache: BotInfo | undefined;

/**
 * Reset the bot-info cache. Exposed only for testing — production code never
 * calls this; cache invalidation happens naturally on isolate restart.
 * @internal
 */
export function _resetBotInfoCacheForTest(): void {
  botInfoCache = undefined;
}

/** Fetch (and cache) the bot's `user_id` and `team_id` via `auth.test`. */
export async function getBotInfo(): Promise<BotInfo> {
  if (botInfoCache !== undefined) return botInfoCache;
  const res = await callSlackApi<AuthTestResponse>(
    "auth.test",
    {},
    { token: env.SLACK_BOT_TOKEN }
  );
  assertSlackOk("auth.test", res);
  botInfoCache = { userId: res.user_id ?? null, teamId: res.team_id ?? null };
  return botInfoCache;
}

/** The bot's own Slack user id, used to skip the bot in membership handling. */
export async function getBotUserId(): Promise<string | null> {
  return (await getBotInfo()).userId;
}

/**
 * Post a bot reply via `chat.postMessage`. Pass `threadTs` to reply inside a
 * thread; pass null to post at the top level (e.g. in a DM). Pass `username` to
 * render the message under a custom name (the agent's display name) — requires
 * the `chat:write.customize` scope; a null/empty value is omitted so the default
 * app name is used. Stored agent names/display names are already trimmed at the
 * model layer, so no trimming happens here. The gatekeeper owns the bot token, so
 * all agent replies flow through here.
 */
export async function postReply(
  channelId: string,
  threadTs: string | null,
  text: string,
  username?: string | null,
  iconUrl?: string | null
): Promise<void> {
  let mrkdwn: string;
  try {
    mrkdwn = slackifyMarkdown(text).trim();
  } catch {
    mrkdwn = text;
  }

  try {
    const res = await callSlackApi<ChatPostMessageResponse>(
      "chat.postMessage",
      {
        channel: channelId,
        text: mrkdwn,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(username ? { username } : {}),
        ...(iconUrl ? { icon_url: iconUrl } : {})
      },
      { token: env.SLACK_BOT_TOKEN }
    );
    assertSlackOk("chat.postMessage", res);
    console.log("[slack] reply posted ok", { channelId, ts: res.ts });
  } catch (err) {
    console.error("[slack] postReply failed", {
      channelId,
      threadTs,
      err: String(err)
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Block Kit — interactive messages for human-in-the-loop prompts. postReply is
// text-only; these carry `blocks`. Prompt/label text must already be sanitized
// by the caller (as with agent replies), since blocks are structured and never
// pass through slackifyMarkdown.
// ---------------------------------------------------------------------------

/**
 * Post an interactive Block Kit message (a HITL approval/question) via
 * `chat.postMessage`. Rendered under the agent's identity (`username`/`iconUrl`)
 * like {@link postReply}, so a prompt looks like it came from the asking agent.
 * `text` is the required notification/accessibility fallback. Returns the posted
 * message `ts` so the prompt can later be updated to an answered/expired state.
 */
export async function postBlocks(input: {
  channelId: string;
  threadTs: string | null;
  blocks: unknown[];
  text: string;
  username?: string | null;
  iconUrl?: string | null;
}): Promise<string | null> {
  const res = await callSlackApi<ChatPostMessageResponse>(
    "chat.postMessage",
    {
      channel: input.channelId,
      blocks: input.blocks,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.iconUrl ? { icon_url: input.iconUrl } : {})
    },
    { token: env.SLACK_BOT_TOKEN }
  );
  assertSlackOk("chat.postMessage", res);
  return res.ts ?? null;
}

/**
 * Replace a message's blocks via `chat.update` (e.g. swap live buttons for an
 * answered/expired/canceled state). Used well after a Slack `response_url` has
 * expired (the HITL TTL is days), so we always update by `ts`.
 */
export async function updateBlocks(input: {
  channelId: string;
  ts: string;
  blocks: unknown[];
  text: string;
}): Promise<void> {
  await updateSlackMessage({
    token: env.SLACK_BOT_TOKEN,
    channel: input.channelId,
    ts: input.ts,
    blocks: input.blocks,
    text: input.text
  });
}

/** Open a modal (the freeform "Something else…" answer view) via `views.open`. */
export async function openView(
  triggerId: string,
  view: unknown
): Promise<void> {
  await openSlackView({ token: env.SLACK_BOT_TOKEN, triggerId, view });
}

/** Post an ephemeral notice (e.g. "already answered") visible only to one user. */
export async function postEphemeral(input: {
  channelId: string;
  userId: string;
  threadTs: string | null;
  text: string;
}): Promise<void> {
  await postSlackEphemeral({
    token: env.SLACK_BOT_TOKEN,
    channel: input.channelId,
    user: input.userId,
    text: input.text,
    ...(input.threadTs ? { threadTs: input.threadTs } : {})
  });
}

// Benign reaction errors that mean the desired end-state already holds, so we
// treat them as success to keep the reaction steps idempotent under retries.
const BENIGN_ADD_REACTION_ERRORS = new Set(["already_reacted"]);
const BENIGN_REMOVE_REACTION_ERRORS = new Set([
  "no_reaction",
  "message_not_found"
]);

/**
 * Add an emoji reaction to a message via `reactions.add`. Idempotent: an
 * `already_reacted` error is treated as success so step retries don't throw.
 * Requires the `reactions:write` scope on the bot token.
 */
export async function addReaction(
  channelId: string,
  timestamp: string,
  name: string
): Promise<void> {
  const res = await callSlackApi<SlackApiResponse>(
    "reactions.add",
    { channel: channelId, timestamp, name },
    { token: env.SLACK_BOT_TOKEN }
  );
  if (!res.ok && BENIGN_ADD_REACTION_ERRORS.has(res.error ?? "")) return;
  assertSlackOk("reactions.add", res);
}

/**
 * Remove an emoji reaction from a message via `reactions.remove`. Idempotent: a
 * `no_reaction`/`message_not_found` error is treated as success so the backstop
 * cleanup never throws when the reaction was already collected or the message is
 * gone. Requires the `reactions:write` scope on the bot token.
 */
export async function removeReaction(
  channelId: string,
  timestamp: string,
  name: string
): Promise<void> {
  const res = await callSlackApi<SlackApiResponse>(
    "reactions.remove",
    { channel: channelId, timestamp, name },
    { token: env.SLACK_BOT_TOKEN }
  );
  if (!res.ok && BENIGN_REMOVE_REACTION_ERRORS.has(res.error ?? "")) return;
  assertSlackOk("reactions.remove", res);
}
