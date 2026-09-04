import {
  verifySlackRequest,
  parseSlackWebhookBody,
  SlackWebhookVerificationError
} from "@chat-adapter/slack/webhook";
import type { SlackWebhookPayload } from "@chat-adapter/slack/webhook";
import { env } from "cloudflare:workers";
import { isRecord, str } from "@/util/json";
import { normalizeWhitespace } from "@/util/text-diff";
import { pickDisplayName } from "@/util/display-name";
import { getSlackTeamId, setPublicUrl } from "@/db/models/workspace-configs";
import { STOP_REACTION, reactionInstanceId } from "@/workflows/reaction";
import { addReaction, getBotUserId } from "@/wrappers/slack";
import { resolveTargets } from "@/router/resolve";
import type {
  ClassifiedMessageParams,
  MessageWorkflowParams,
  LifecycleWorkflowParams,
  CancelWorkflowParams,
  Classification
} from "@/slack/types";
export type {
  MessageWorkflowParams,
  LifecycleWorkflowParams,
  CancelWorkflowParams,
  Classification
};

const LIFECYCLE_EVENT_TYPES = new Set([
  "member_joined_channel",
  "member_left_channel",
  "team_join"
]);

const MESSAGE_EDIT_SUBTYPES = new Set(["message_changed", "message_deleted"]);

function userIdOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return str(value.id);
  return undefined;
}

/** Extracted fields for a message edit/delete, normalized from the inner event. */
interface MessageEdit {
  editKind: "edited" | "deleted";
  ts?: string;
  threadTs?: string;
  userId?: string;
  /** New text after edit (empty for deletes). */
  text: string;
  /** Prior text — the transcript on delete, the before-image on edit. */
  prevText?: string;
  /**
   * Bot id of the edited/deleted message's author, when it was posted by an app.
   * A `message_changed` carries this on the nested `message` (not the top-level
   * event), so the outer bot filter misses it. Present ⇒ the gatekeeper's own edit
   * (e.g. swapping a HITL prompt to its answered state); such edits are dropped,
   * never fed back as a turn.
   */
  botId?: string;
}

/**
 * Pull the edit/delete shape out of a Slack `message` event. `message_changed`
 * carries the new body in `event.message` and the old in `event.previous_message`;
 * `message_deleted` carries only `previous_message` plus `deleted_ts`. Returns the
 * authored ts/user (not the edit's own ts) so the feed turn attributes the origin.
 */
function messageEditFromEvent(raw: unknown, subtype: string): MessageEdit {
  const event = isRecord(raw) ? (isRecord(raw.event) ? raw.event : raw) : {};
  const inner = isRecord(event.message) ? event.message : undefined;
  const prev = isRecord(event.previous_message)
    ? event.previous_message
    : undefined;
  const prevText = str(prev?.text);
  if (subtype === "message_deleted") {
    return {
      editKind: "deleted",
      ts: str(event.deleted_ts) ?? str(prev?.ts),
      threadTs: str(prev?.thread_ts),
      userId: userIdOf(prev?.user),
      text: "",
      prevText,
      botId: str(prev?.bot_id)
    };
  }
  const edited = isRecord(inner?.edited) ? inner.edited : undefined;
  return {
    editKind: "edited",
    ts: str(inner?.ts) ?? str(event.ts),
    threadTs: str(inner?.thread_ts) ?? str(prev?.thread_ts),
    userId:
      userIdOf(inner?.user) ?? userIdOf(edited?.user) ?? userIdOf(prev?.user),
    text: str(inner?.text) ?? "",
    prevText,
    botId: str(inner?.bot_id)
  };
}

/**
 * True when an "edit" changed no visible text — e.g. Slack re-firing
 * `message_changed` for link unfurling/embedding, or a whitespace-only tweak.
 * These carry no signal for agents, so they are ignored rather than dispatched.
 * Deletes are never no-ops (empty `text` differs from the prior transcript).
 */
function isNoOpEdit(edit: MessageEdit): boolean {
  return (
    edit.editKind === "edited" &&
    normalizeWhitespace(edit.text) === normalizeWhitespace(edit.prevText ?? "")
  );
}

/**
 * Map a parsed Slack webhook payload to the Workflow it should drive.
 *
 * Exported for unit-testing in isolation. The gatekeeper calls this via
 * handleSlackEvent — not directly.
 *
 * Note: parseSlackWebhookBody only types app_mention, direct_message,
 * slash/interactive, and url_verification. Lifecycle events arrive as
 * kind:"unsupported" with the event type on payload.type and the full
 * envelope on payload.raw, so we classify those from raw.
 */
export function classifyEvent(payload: SlackWebhookPayload): Classification {
  // Returned above the event-id gate: a challenge carries no `event_id`.
  if (payload.kind === "url_verification") {
    return { kind: "challenge", challenge: payload.challenge };
  }

  // `unsupported` is the adapter's catch-all (`raw: unknown`), so it carries both
  // real Events API envelopes (lifecycle, reactions, channel messages) and any
  // other POST that reached this route. Only an `event_callback` envelope is an
  // event delivery and therefore owes us an `event_id`.
  const envelope =
    payload.kind === "unsupported" && isRecord(payload.raw)
      ? payload.raw
      : undefined;
  const isEventDelivery =
    payload.kind === "app_mention" ||
    payload.kind === "direct_message" ||
    str(envelope?.type) === "event_callback";
  if (!isEventDelivery) {
    // Slash commands, interactive payloads, `app_rate_limited`, non-Slack POSTs —
    // acked and dropped as before. These never carry an `event_id`, so they must
    // clear the gate below rather than be rejected by it.
    return payload.kind === "unsupported"
      ? { kind: "ignore", reason: `unsupported event: ${payload.type}` }
      : { kind: "ignore", reason: `interactive: ${payload.kind}` };
  }

  // `event_id` is Slack's idempotency key and this gatekeeper's dedupe anchor — the
  // Message/Reaction/Cancel workflow instance ids and the `agent_tasks` token PK
  // all derive from it. Minting a substitute (a random UUID) would make a Slack
  // retry miss every one of those and double-dispatch the whole fan-out, so an
  // event delivery without one is rejected rather than guessed at. Narrowing this
  // once here is what lets every branch below use `eventId` directly.
  const eventId =
    payload.kind === "app_mention" || payload.kind === "direct_message"
      ? payload.eventId
      : str(envelope?.event_id);
  if (!eventId) {
    return { kind: "invalid", reason: `${payload.kind} without an event id` };
  }

  switch (payload.kind) {
    case "app_mention":
      if (!payload.userId) {
        return { kind: "ignore", reason: "app_mention without a user id" };
      }
      return {
        kind: "message",
        params: {
          eventId,
          eventType: "app_mention",
          channelId: payload.channelId,
          threadTs: payload.threadTs,
          ts: payload.ts,
          userId: payload.userId,
          teamId: payload.teamId,
          text: payload.text,
          raw: payload.raw
        }
      };

    case "direct_message": {
      if (payload.subtype && MESSAGE_EDIT_SUBTYPES.has(payload.subtype)) {
        // DM edit/delete → feed turn for the onboarding agent (DMs are an
        // implicit mention, so the agent is always woken). raw is the inner event.
        const edit = messageEditFromEvent(payload.raw, payload.subtype);
        if (edit.botId) {
          // The bot editing its own DM message (e.g. an `ask_user` prompt
          // flipping to its answered state) must never become a feed turn.
          return { kind: "ignore", reason: "bot message edit" };
        }
        if (isNoOpEdit(edit)) {
          return { kind: "ignore", reason: "message edit with no text change" };
        }
        const userId = edit.userId ?? payload.userId;
        if (!userId) {
          return {
            kind: "ignore",
            reason: "DM message edit without a user id"
          };
        }
        return {
          kind: "message",
          params: {
            eventId,
            eventType: "message",
            channelId: payload.channelId,
            threadTs: edit.threadTs ?? payload.threadTs,
            ts: edit.ts ?? payload.ts,
            userId,
            teamId: payload.teamId,
            text: edit.text,
            prevText: edit.prevText,
            editKind: edit.editKind,
            raw: payload.raw
          }
        };
      }
      if (payload.botId || payload.subtype === "bot_message") {
        return { kind: "ignore", reason: "bot message" };
      }
      if (!payload.userId) {
        return { kind: "ignore", reason: "direct message without a user id" };
      }
      return {
        kind: "message",
        params: {
          eventId,
          eventType: "message",
          channelId: payload.channelId,
          threadTs: payload.threadTs,
          ts: payload.ts,
          userId: payload.userId,
          teamId: payload.teamId,
          text: payload.text,
          raw: payload.raw
        }
      };
    }

    case "unsupported": {
      const eventType = payload.type;
      const event =
        envelope && isRecord(envelope.event) ? envelope.event : undefined;
      const subtype = event ? str(event.subtype) : undefined;

      // 🛑 stop reaction → cancel the reacted message's in-flight fan-out. Only
      // the STOP_REACTION on a message item is actionable; every other emoji and
      // `reaction_removed` falls through to `ignore`. The reactor (event.user) is
      // carried so the handler can drop the gatekeeper's own initial reaction.
      if (eventType === "reaction_added" && event) {
        const reaction = str(event.reaction);
        if (reaction !== STOP_REACTION) {
          return {
            kind: "ignore",
            reason: `reaction: ${reaction ?? "unknown"}`
          };
        }
        const item = isRecord(event.item) ? event.item : undefined;
        const channelId = item ? str(item.channel) : undefined;
        const ts = item ? str(item.ts) : undefined;
        const userId = userIdOf(event.user);
        if (!channelId || !ts) {
          return {
            kind: "ignore",
            reason: "stop reaction without a message item"
          };
        }
        if (!userId) {
          return { kind: "ignore", reason: "stop reaction without a user id" };
        }
        return {
          kind: "cancel",
          params: {
            eventId,
            channelId,
            ts,
            userId,
            teamId: envelope ? str(envelope.team_id) : undefined
          }
        };
      }

      const isLifecycle = LIFECYCLE_EVENT_TYPES.has(eventType);
      if (isLifecycle) {
        // For team_join, the user field is an object — extract the display name
        // here so the Workflow handler receives it directly on params.displayName
        // rather than re-digging the raw envelope.
        let displayName: string | null = null;
        if (eventType === "team_join") {
          const user = event && isRecord(event.user) ? event.user : undefined;
          const profile =
            user && isRecord(user.profile) ? user.profile : undefined;
          displayName = pickDisplayName(
            str(profile?.display_name),
            str(profile?.real_name),
            str(user?.name)
          );
        }

        return {
          kind: "lifecycle",
          params: {
            eventId,
            type: eventType,
            subtype,
            channelId: event ? str(event.channel) : undefined,
            userId: event ? userIdOf(event.user) : undefined,
            teamId: envelope ? str(envelope.team_id) : undefined,
            displayName,
            raw: envelope ?? {}
          }
        };
      }

      // Plain channel messages (and their edits/deletes) arrive here because the
      // adapter only types app_mention + DMs. Every one becomes a feed turn so
      // channel_messages agents see the full channel reality; mention agents are
      // filtered later by name. Bot/system traffic and senderless events are dropped.
      if (eventType === "message" && event) {
        if (str(event.bot_id) || subtype === "bot_message") {
          return { kind: "ignore", reason: "bot message" };
        }
        const channelId = str(event.channel);
        if (!channelId) {
          return { kind: "ignore", reason: "message without a channel" };
        }
        if (subtype && MESSAGE_EDIT_SUBTYPES.has(subtype)) {
          const edit = messageEditFromEvent(event, subtype);
          if (edit.botId) {
            // The bot editing its own message (e.g. a HITL prompt flipping to its
            // answered state) — the outer bot filter can't see the nested author.
            return { kind: "ignore", reason: "bot message edit" };
          }
          if (isNoOpEdit(edit)) {
            return {
              kind: "ignore",
              reason: "message edit with no text change"
            };
          }
          if (!edit.userId) {
            return { kind: "ignore", reason: "message edit without a user id" };
          }
          return {
            kind: "message",
            params: {
              eventId,
              eventType: "message",
              channelId,
              threadTs: edit.threadTs ?? edit.ts ?? "",
              ts: edit.ts ?? "",
              userId: edit.userId,
              teamId: envelope ? str(envelope.team_id) : undefined,
              text: edit.text,
              prevText: edit.prevText,
              editKind: edit.editKind,
              raw: envelope ?? {}
            }
          };
        }
        if (subtype) {
          return { kind: "ignore", reason: `message subtype: ${subtype}` };
        }
        const userId = userIdOf(event.user);
        if (!userId) {
          return {
            kind: "ignore",
            reason: "channel message without a user id"
          };
        }
        const ts = str(event.ts) ?? "";
        return {
          kind: "message",
          params: {
            eventId,
            eventType: "message",
            channelId,
            threadTs: str(event.thread_ts) ?? ts,
            ts,
            userId,
            teamId: envelope ? str(envelope.team_id) : undefined,
            text: str(event.text) ?? "",
            raw: envelope ?? {}
          }
        };
      }

      return { kind: "ignore", reason: `unsupported event: ${eventType}` };
    }

    // slash_command, block_actions, block_suggestion, view_submission, view_closed
    default:
      return { kind: "ignore", reason: `interactive: ${payload.kind}` };
  }
}

// ---------------------------------------------------------------------------
// Workflow dispatch
// ---------------------------------------------------------------------------

const OK = () => new Response("ok", { status: 200 });

// Matches the error Cloudflare Workflows throws when create() is called with a
// duplicate instance id (Slack retry delivering the same event_id). The message
// always contains "already exists"; the broader "duplicate" arm was a guess and
// has been dropped to avoid false positives on unrelated errors.
function isInstanceExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(message);
}

async function triggerWorkflow(
  workflow: Workflow,
  params: MessageWorkflowParams | LifecycleWorkflowParams | CancelWorkflowParams
): Promise<void> {
  const id = params.eventId;
  try {
    await workflow.create({ id, params });
  } catch (err) {
    if (isInstanceExistsError(err)) {
      console.log("[gatekeeper] duplicate event — skipping", { eventId: id });
      return;
    }
    console.error("[gatekeeper] failed to create workflow instance", {
      eventId: id,
      err: String(err)
    });
  }
}

/**
 * Add the 🛑 stop reaction to the trigger message inline, so it appears
 * immediately rather than after a workflow cold start. It both signals that
 * agents are working and gives the human a one-tap cancel affordance.
 * Best-effort: any failure here is logged but never affects the Slack ack. The
 * matching ReactionWorkflow is responsible for removing it.
 */
async function addStopReaction(params: ClassifiedMessageParams): Promise<void> {
  try {
    await addReaction(params.channelId, params.ts, STOP_REACTION);
  } catch (err) {
    console.error("[gatekeeper] failed to add stop reaction", {
      eventId: params.eventId,
      err: String(err)
    });
  }
}

/**
 * Kick off the parallel ReactionWorkflow that removes the 🛑 reaction once a
 * reply is posted (or on its timeout backstop). Best-effort and cosmetic: any
 * failure here is logged but never affects the Slack ack — the message
 * workflows remain authoritative. Duplicate Slack deliveries are deduped by the
 * deterministic instance id.
 */
async function triggerReactionWorkflow(
  workflow: Workflow,
  params: ClassifiedMessageParams
): Promise<void> {
  try {
    await workflow.create({
      id: reactionInstanceId(params.eventId),
      params: {
        eventId: params.eventId,
        channelId: params.channelId,
        ts: params.ts
      }
    });
  } catch (err) {
    if (isInstanceExistsError(err)) return; // duplicate delivery — already running
    console.error("[gatekeeper] failed to start reaction workflow", {
      eventId: params.eventId,
      err: String(err)
    });
  }
}

// ---------------------------------------------------------------------------
// Team-id guard — D1 anchor check with isolate-level memoization
// ---------------------------------------------------------------------------

/**
 * Isolate-level memo of the pinned Slack team_id anchor. Starts as null
 * (not yet loaded). Once the anchor is read from D1 and found to be a
 * non-null string, it is cached here for the lifetime of the isolate,
 * avoiding a D1 round-trip on every subsequent request.
 *
 * While the anchor is unset in D1 (bootstrap grace) this stays null and
 * each request re-reads D1 — cheap given the grace window is temporary.
 */
let cachedAnchorTeamId: string | null = null;

/** Reset the isolate-level anchor cache. Only for test isolation. */
export function _resetAnchorCacheForTest(): void {
  cachedAnchorTeamId = null;
}

/**
 * Isolate-level memo of the gatekeeper's public origin (the JWT `iss` + `jku` host
 * for remote agents). Discovered from the first *signature-verified* Slack
 * request and persisted to D1 once per isolate, so the Message Workflow (which
 * has no `Request` in scope) can read it when signing gatekeeper tokens. Resets to
 * null on cold start (new deploy, domain change), triggering a fresh write.
 */
let cachedPublicUrl: string | null = null;

/** Reset the isolate-level public-url cache. Only for test isolation. */
export function _resetPublicUrlCacheForTest(): void {
  cachedPublicUrl = null;
}

/**
 * Persist the gatekeeper's public origin, derived from a request that has already
 * passed Slack signature verification — so an unauthenticated caller can never
 * set or poison this trust anchor. Cheap after the first write: the isolate memo
 * short-circuits every subsequent request.
 */
async function discoverPublicUrl(request: Request): Promise<void> {
  if (cachedPublicUrl !== null) return;
  const origin = new URL(request.url).origin;
  cachedPublicUrl = origin;
  await setPublicUrl(origin);
}

/**
 * Enforce the team_id invariant: every request must come from the workspace
 * whose `team_id` was pinned on first reconcile. On mismatch, log and return
 * a 403. Passes through when the anchor is not yet set (bootstrap grace) or
 * when the event carries no `team_id`.
 *
 * Uses an isolate-level memo so D1 is read at most once per isolate lifetime.
 * Until the anchor is pinned in D1, each request does a single D1 read.
 */
export async function guardTeamId(
  eventTeamId: string | undefined
): Promise<Response | null> {
  if (!eventTeamId) return null; // no team_id in this event — skip check

  if (cachedAnchorTeamId === null) {
    const anchor = await getSlackTeamId();
    if (anchor !== null) {
      cachedAnchorTeamId = anchor; // pin once; never cleared in production
    }
  }

  if (cachedAnchorTeamId === null) {
    // Anchor not yet pinned — bootstrap grace; reconcile will set it on its next run.
    console.log(
      "[gatekeeper] team_id anchor not yet set — skipping guard (bootstrap grace)"
    );
    return null;
  }

  if (eventTeamId !== cachedAnchorTeamId) {
    console.error("[gatekeeper] team_id mismatch — rejecting event", {
      eventTeamId,
      anchor: cachedAnchorTeamId
    });
    return new Response("Forbidden", { status: 403 });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entry point — called by the gatekeeper fetch handler
// ---------------------------------------------------------------------------

/**
 * Verify the Slack signature, classify the event, run the team-id guard,
 * trigger the matching Workflow, and return 200 before any agent work runs.
 *
 * Returns 401 on bad signature, 403 on team_id mismatch, 400 on a malformed
 * delivery (an event envelope with no `event_id`), and 200 for everything else —
 * including ignored events, duplicate event_ids (native dedupe via instance id),
 * and Workflow create failures (logged but not surfaced, since all three tasks
 * run in ctx.waitUntil after the ack).
 */
export async function handleSlackEvent(
  request: Request,
  ctx: ExecutionContext
): Promise<Response> {
  let rawBody: string;
  try {
    rawBody = await verifySlackRequest(request, {
      signingSecret: env.SLACK_SIGNING_SECRET
    });
  } catch (err) {
    if (err instanceof SlackWebhookVerificationError) {
      return new Response("Invalid signature", { status: 401 });
    }
    throw err;
  }

  // Signature verified above — safe to record the gatekeeper's public origin now.
  await discoverPublicUrl(request);

  const payload = parseSlackWebhookBody(rawBody, { headers: request.headers });
  const classification = classifyEvent(payload);

  switch (classification.kind) {
    case "challenge":
      console.log("[gatekeeper] url_verification challenge");
      return Response.json({ challenge: classification.challenge });

    case "message": {
      const guardResponse = await guardTeamId(classification.params.teamId);
      if (guardResponse) return guardResponse;
      const base = classification.params;
      // Resolve, react, and fan out off-path so the 200 ack is never delayed.
      // Resolving here (not in the workflow) lets us skip the 🛑 reaction and
      // both workflows entirely when no agent is woken — no reaction flicker on
      // channels without a channel_messages agent. waitUntil keeps the isolate
      // alive until all tasks settle; each already swallows/logs its own errors.
      ctx.waitUntil(
        (async () => {
          const targets = await resolveTargets({
            channelId: base.channelId,
            text: base.editKind
              ? `${base.text} ${base.prevText ?? ""}`.trim()
              : base.text
          });
          if (targets.length === 0) {
            console.log("[gatekeeper] no agent woken — staying silent", {
              eventId: base.eventId,
              channelId: base.channelId
            });
            return;
          }
          // One workflow instance per event handles every woken agent, local or
          // remote; it dispatches each by `agent.kind` and owns the single
          // collect-reaction signal for the event.
          await Promise.allSettled([
            addStopReaction(base),
            triggerReactionWorkflow(env.REACTION_WORKFLOW, base),
            triggerWorkflow(env.MESSAGE_WORKFLOW, { ...base, targets })
          ]);
        })()
      );
      return OK();
    }

    case "lifecycle": {
      const guardResponse = await guardTeamId(classification.params.teamId);
      if (guardResponse) return guardResponse;
      ctx.waitUntil(
        triggerWorkflow(env.LIFECYCLE_WORKFLOW, classification.params)
      );
      return OK();
    }

    case "cancel": {
      const guardResponse = await guardTeamId(classification.params.teamId);
      if (guardResponse) return guardResponse;
      const params = classification.params;
      // The gatekeeper pre-adds the 🛑 itself, which fires a reaction_added for the
      // bot. Filter it here (getBotUserId is cached) so we don't spin a workflow
      // — and never self-cancel — on our own reaction. Off-path so the ack is
      // never delayed; the CancelWorkflow dedupes Slack retries by event_id.
      ctx.waitUntil(
        (async () => {
          const botUserId = await getBotUserId();
          if (botUserId && params.userId === botUserId) return;
          await triggerWorkflow(env.CANCEL_WORKFLOW, params);
        })()
      );
      return OK();
    }

    case "ignore":
      console.log("[gatekeeper] event ignored", {
        reason: classification.reason
      });
      return OK();

    // Malformed enough that acking 200 would hide it. Slack retries a non-2xx up
    // to 3×, but the defect is deterministic so those also fail and the delivery
    // surfaces in the app dashboard — which is the point.
    case "invalid":
      console.warn("[gatekeeper] event rejected", {
        reason: classification.reason
      });
      return new Response("Bad Request", { status: 400 });
  }
}
