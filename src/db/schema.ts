import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  check
} from "drizzle-orm/sqlite-core";
import type { HitlAnswer, HitlRequestData } from "@dynamicagents/g2a-protocol";

// Unix-seconds timestamp column with a SQLite-side default. Reused across tables.
const timestamp = (name: string) =>
  integer(name)
    .notNull()
    .default(sql`(unixepoch())`);

/**
 * Workspaces — logical sub-orgs, each mapped to a Slack admin channel.
 * `id` is OUR id (not a Slack team id). It's a plain INTEGER PRIMARY KEY, i.e.
 * the SQLite rowid: omit it on insert and SQLite assigns max(id)+1. `0`
 * (ORG_WORKSPACE_ID) is seeded explicitly, so new rows auto-allocate from 1.
 * Membership of a workspace's `adminChannelId` ⇒ admin of that workspace.
 */
export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  adminChannelId: text("admin_channel_id").unique(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at")
});

/**
 * Global Slack user registry, keyed by the stable Slack user id (`U…`).
 * Owner/admin flags are authoritative from `users.list` (reconcile); membership
 * events only ever upsert the id, never these flags.
 */
export const slackUsers = sqliteTable("slack_users", {
  slackUserId: text("slack_user_id").primaryKey(),
  displayName: text("display_name"),
  isPrimaryOwner: integer("is_primary_owner", { mode: "boolean" })
    .notNull()
    .default(false),
  isOrgAdmin: integer("is_org_admin", { mode: "boolean" })
    .notNull()
    .default(false),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at")
});

/**
 * Slack channel registry, keyed by the stable Slack channel id (`C…`). Kept
 * upserted by reconcile from the `conversations.list` traversal it already does,
 * so the message hot path resolves a channel name with a single D1 read instead
 * of a Slack call. Only named conversations (public/private channels) land here;
 * DMs/MPIMs miss and the hot path falls back to the raw id.
 */
export const slackChannels = sqliteTable(
  "slack_channels",
  {
    channelId: text("channel_id").primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at")
  },
  (t) => [index("idx_slack_channels_name").on(t.name)]
);

/**
 * Workspace admins — one row per (workspace, user). This join table IS the
 * source of `adminWorkspaces`; being a member of a workspace's admin channel
 * lands a row here. D1 enforces foreign keys at runtime and these are declared
 * `ON DELETE no action`, so cascades are done explicitly in code — a parent
 * delete is rejected outright while children still reference it.
 */
export const workspaceAdmins = sqliteTable(
  "workspace_admins",
  {
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    slackUserId: text("slack_user_id")
      .notNull()
      .references(() => slackUsers.slackUserId),
    source: text("source", { enum: ["membership", "bootstrap"] })
      .notNull()
      .default("membership"),
    createdAt: timestamp("created_at")
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.slackUserId] }),
    index("idx_ws_admins_user").on(t.slackUserId)
  ]
);

/**
 * Agent registry. Built-in `admin`/`onboarding` rows are seeded by
 * migrations/0001_seed_builtins.sql at deploy time.
 */
export const agents = sqliteTable(
  "agents",
  {
    name: text("name").primaryKey(),
    // Where this agent runs, and nothing else. `local` is one of this Worker's
    // own core tenants, dispatched in-process to its mounted A2A endpoint;
    // `remote` over HTTP at `a2aEndpoint`.
    // *Which* agent it is — including which built-in — is `tenantId`, on both
    // paths. The gatekeeper sets this itself; no admin chooses it, which is what
    // keeps a registered agent from claiming to be in-process.
    kind: text("kind", { enum: ["local", "remote"] }).notNull(),
    displayName: text("display_name"),
    // Optional gatekeeper-hosted, admin-generated avatar URL (never from the AgentCard).
    iconUrl: text("icon_url"),
    // Always set: custom agents carry a real HTTP endpoint; built-ins use an
    // `http://{name}.local` sentinel, because their endpoint is derived from the
    // gatekeeper's own public URL at dispatch. Whether an agent is local is
    // decided by `kind`, not by this value.
    a2aEndpoint: text("a2a_endpoint").notNull(),
    // Which agent at that location. One origin serves many agents over a single
    // A2A endpoint (spec §8.3.2), and the tenant is what picks between them —
    // dispatch sends it on every request and the remote refuses a request
    // without it.
    //
    // Required, and deliberately *without* a default: a default would make it
    // optional at every insert forever and turn `''` into a second sentinel
    // beside `http://{name}.local`. Built-ins carry a real tenant too
    // (`admin`, `onboarding`) rather than an empty one, so the column means the
    // same thing in every row — see `isBuiltin` in `src/a2a/dispatch.ts`.
    tenantId: text("tenant_id").notNull(),
    // Pinned AgentCard signing identity for custom agents (Trust-On-First-Use).
    // Verified at registration; a later card signed by a different key is
    // rejected. Null for built-ins, whose key is this Worker's own
    // `A2A_SIGNING_KEY` and is pinned by construction.
    cardSigningJku: text("card_signing_jku"),
    cardSigningKid: text("card_signing_kid"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // When the agent is woken: `mention` = only on a name mention (machine or
    // display name); `channel_messages` = every channel message. Required (no
    // default) so a missing value is rejected, not silently coerced.
    notifyOn: text("notify_on", {
      enum: ["mention", "channel_messages"]
    }).notNull(),
    // How long THIS agent gets to finish one processing leg before the
    // ReactionWorkflow cancels its task and says so in the channel. Required: every
    // row carries a concrete deadline, so nothing downstream has to decide what an
    // absent one means — there is no "no limit".
    //
    // Required and deliberately **without** a default, for the same reason
    // `tenantId` has none: a database default would make the column optional at
    // every insert forever, and it would put a second copy of the number somewhere
    // nobody thinks to change. The one authoritative default is
    // `DEFAULT_TASK_DEADLINE_SECONDS` in `src/config.ts`, which `registerAgent`
    // passes explicitly on every insert. With nothing to fall back on, a write
    // path that forgets this column fails loudly instead of quietly storing an
    // hour. Rows that predate the column were backfilled once, by 0021's rebuild.
    taskDeadlineSeconds: integer("task_deadline_seconds").notNull(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at")
  },
  (t) => [
    index("idx_agents_workspace_id").on(t.workspaceId),
    check("agents_name_lowercase", sql`${t.name} = lower(${t.name})`),
    // "Required" enforced by the database, not by every insert remembering.
    // `NOT NULL` alone would still accept `''`, which is the sentinel this
    // column exists to avoid.
    check("agents_tenant_id_nonempty", sql`${t.tenantId} <> ''`)
  ]
);

/** Channel → agent allowlist. Multiple agents can share a channel; agent names disambiguate. */
export const agentChannels = sqliteTable(
  "agent_channels",
  {
    channelId: text("channel_id").notNull(),
    agentName: text("agent_name")
      .notNull()
      .references(() => agents.name),
    workspaceId: integer("workspace_id").references(() => workspaces.id),
    createdAt: timestamp("created_at")
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.agentName] }),
    index("idx_agent_channels_agent").on(t.agentName)
  ]
);

/**
 * What `agent_tasks.started_by` holds when no person started the task. The
 * column is NOT NULL — every row answers "who asked for this?", and these are
 * the two ways the answer is nobody:
 *
 * - {@link STARTED_BY_PROCESS}: the gatekeeper itself fed the turn in. A feed
 *   turn for an edited or deleted message carries the *authored* message's user
 *   rather than the actor's, so there is no one on it who asked for the work.
 * - {@link STARTED_BY_UNKNOWN}: nobody was recorded. What migration 0023's
 *   rebuild backfilled the rows written before the column existed with, since
 *   nothing can recover a user id for them after the fact. No live write path
 *   produces it: every insert names a value, so a row reading `unknown` is one
 *   that predates the column.
 *
 * Neither is shaped like a Slack user id (`U…`/`W…`, uppercase), which is what
 * makes them safe to store in a column read for a mention: `requestBlocks` only
 * mentions a value of that shape, so a sentinel can never ping anyone. Keep that
 * true of any value added here.
 */
export const STARTED_BY_PROCESS = "process";
export const STARTED_BY_UNKNOWN = "unknown";

/**
 * Pending agent tasks — the correlation store for async A2A push
 * notifications. When the gatekeeper dispatches to a remote (custom) agent it no
 * longer blocks for the reply: it sends a per-dispatch validation `token` in the
 * A2A `pushNotificationConfig`, the remote returns a Task immediately, and later
 * POSTs Tasks back to `/a2a/notifications` — one or more intermediate progress
 * updates (non-terminal `state`) followed by a terminal Task. This row is how the
 * callback recovers where to post (channel/thread) and which 🛑 to clear
 * (`eventId`). Callback rendering identity is resolved from current state at
 * delivery time via `agentRenderIdentity` (the agent row, plus the workspace's
 * admin overrides), never carried over from dispatch.
 *
 * Keyed by the gatekeeper-generated `token` (the value the remote echoes back).
 * The row stays `pending` across intermediate updates and is marked `completed`
 * only by the terminal callback (which then clears the 🛑); rows are swept in the
 * maintenance workflow.
 */
export const agentTasks = sqliteTable(
  "agent_tasks",
  {
    // Gatekeeper-generated per-dispatch push-notification validation token (PK) —
    // the value the remote echoes back so we can correlate the callback.
    token: text("token").primaryKey(),
    // Remote-assigned A2A Task id captured from the accept response (null until
    // the accept returns / for observability + callback dedupe).
    taskId: text("task_id"),
    agentName: text("agent_name")
      .notNull()
      .references(() => agents.name),
    channelId: text("channel_id").notNull(),
    // Slack `ts` of the trigger message — the correlation key a 🛑 stop reaction
    // uses (a reaction event carries only item.channel + item.ts) to find this
    // task's fan-out. NOT NULL: it is the cancel path's only lookup key, so a row
    // without one would be permanently uncancelable.
    messageTs: text("message_ts").notNull(),
    // Thread to reply into; null = post at channel top-level (mirrors replyThreadTs).
    replyThreadTs: text("reply_thread_ts"),
    // Slack event id of the triggering message — used to collect the 🛑 reaction.
    eventId: text("event_id").notNull(),
    // Slack user who started this task: the sender of the message that woke the
    // agent, as the webhook classified it. The one thing it is for is mentioning
    // that person when their agent comes back asking a human to approve
    // something, so the approval reaches whoever asked for the work rather than
    // waiting in a thread nobody is watching (see `requestBlocks` in
    // `src/slack/hitl/render.ts`).
    //
    // It comes from the signature-verified Slack envelope and from nowhere else,
    // never from the agent's own HITL form — so the line the gatekeeper writes in
    // its own voice names somebody the agent did not choose. It is written once,
    // at dispatch, so a task continued by somebody else still mentions the person
    // who started it.
    //
    // NOT NULL: a task nobody started says so with a sentinel
    // (STARTED_BY_PROCESS / STARTED_BY_UNKNOWN) rather than with a null, so every
    // reader gets a string and none has to decide what a missing one means.
    //
    // Required and deliberately **without** a default, for the same reason
    // `agents.task_deadline_seconds` has none: a database default would make the
    // column optional at every insert forever, so a write path that forgot who
    // started the task would quietly store `unknown` instead of failing. Naming
    // nobody is a decision, and the caller makes it — `CreateAgentTaskInput`
    // requires the field. The rows that predate the column were backfilled once,
    // by 0023's rebuild, which is why that value exists in the table at all.
    startedBy: text("started_by").notNull(),
    // `pending` until a terminal callback posts (or classifies no-reply) and marks
    // it `completed`. `awaiting-input` is the parked state while a human-in-the-loop
    // prompt is open (see `hitl_requests`): the row is non-terminal (so the fan-out
    // stays undrained and 🛑 still cancels) but every `pending`-conditional mutator
    // is a safe no-op until `resumeFromInput` flips it back to `pending`.
    // `canceled` is the other terminal state: a stop was issued and honored to the
    // ledger's satisfaction. One value for both triggers — a human's 🛑 and the
    // gatekeeper's own processing-deadline cancel are the same event here; *which*
    // fired is recorded in the `[cancel] canceling task` log line, since the
    // actor is not stored.
    status: text("status", {
      enum: ["pending", "awaiting-input", "completed", "canceled"]
    })
      .notNull()
      .default("pending"),
    // A stop was requested (via the 🛑 reaction) before this task's accept
    // returned its taskId. The dispatch honors it the moment the taskId is known
    // (or skips the send entirely if seen first). 0/1.
    cancelRequested: integer("cancel_requested").notNull().default(0),
    // Last gatekeeper-controlled reason a callback was rejected (auth/malformed),
    // captured for the reaction backstop to surface. Never holds remote payload.
    lastError: text("last_error"),
    // Comma-delimited list of intermediate-update `messageId`s already received
    // from the remote, so an at-least-once push retry doesn't double-post it.
    receivedMessageIds: text("received_message_ids"),
    createdAt: timestamp("created_at"),
    completedAt: integer("completed_at")
  },
  (t) => [
    index("idx_agent_tasks_created_at").on(t.createdAt),
    // Reverse lookup for a stop reaction: (channel, trigger ts) → pending tasks.
    index("idx_agent_tasks_channel_message_ts").on(t.channelId, t.messageTs),
    // Drain check: every task leaving the pending set asks "any sibling left for
    // this event?", so this runs N+1 times per fan-out — the table's hottest read.
    index("idx_agent_tasks_event_id").on(t.eventId)
  ]
);

/**
 * The table HITL prompts lived in before a prompt held a form. Nothing reads or
 * writes it: the Worker live while the migration that created `hitl_forms` runs
 * still does, so it is dropped by a later migration, not that one.
 */
export const hitlRequests = sqliteTable(
  "hitl_requests",
  {
    requestId: text("request_id").primaryKey(),
    token: text("token").notNull(),
    taskId: text("task_id"),
    contextId: text("context_id").notNull(),
    agentName: text("agent_name")
      .notNull()
      .references(() => agents.name),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts"),
    slackMessageTs: text("slack_message_ts"),
    requestKind: text("request_kind", {
      enum: ["approval", "choice"]
    }).notNull(),
    promptText: text("prompt_text").notNull(),
    optionsJson: text("options_json"),
    allowFreeform: integer("allow_freeform").notNull().default(0),
    status: text("status", {
      enum: ["awaiting", "answered", "expired", "canceled"]
    })
      .notNull()
      .default("awaiting"),
    answeredBy: text("answered_by"),
    answeredOptionId: text("answered_option_id"),
    answerText: text("answer_text"),
    createdAt: timestamp("created_at"),
    deadlineAt: integer("deadline_at").notNull(),
    answeredAt: integer("answered_at")
  },
  (t) => [
    index("idx_hitl_requests_token").on(t.token),
    index("idx_hitl_requests_status_deadline").on(t.status, t.deadlineAt),
    index("idx_hitl_requests_created_at").on(t.createdAt)
  ]
);

/**
 * Human-in-the-loop (HITL) prompts — one row per form an agent raised by
 * transitioning its task to `input-required`. This is the correlation store
 * between a Slack prompt and the paused A2A task: when a person answers, the
 * interactivity handler looks the row up by `requestId`, records the answers
 * atomically (first-answer-wins), and resumes the task on the same `token` (so
 * continued callbacks land on the paired `agent_tasks` row).
 *
 * Keyed by the agent-chosen `requestId`. Lifecycle: `awaiting` → `answered`
 * (a person decided) | `expired` (TTL swept) | `canceled` (the task ended first —
 * a 🛑 while parked, or the agent's own final status).
 */
/** One person's way through a paged form: the page they are on, and their answers so far. */
export interface HitlDraft {
  page: number;
  answers: Record<string, HitlAnswer>;
}

export const hitlForms = sqliteTable(
  "hitl_forms",
  {
    // Agent-chosen unique id for this prompt (PK), carried in the Slack controls
    // and echoed back on the interaction. `createHitlForm` is idempotent on it
    // so an at-least-once push redelivery does not double-post the prompt.
    requestId: text("request_id").primaryKey(),
    // The paired agent_tasks correlation token (= A2A push token). Resume reuses
    // it so the continued task's callbacks land on the same agent_tasks row.
    token: text("token").notNull(),
    // A2A Task id being paused (captured from the delivered Task, for the resume).
    taskId: text("task_id"),
    // A2A contextId of the paused task — required to resume on the same thread of
    // conversation (A2A multi-turn continues with the same taskId + contextId).
    contextId: text("context_id").notNull(),
    agentName: text("agent_name")
      .notNull()
      .references(() => agents.name),
    channelId: text("channel_id").notNull(),
    // Thread the prompt was posted into; null = channel top-level.
    threadTs: text("thread_ts"),
    // ts of the posted prompt — used to chat.update it to an answered / expired /
    // canceled state (a Slack response_url expires after ~30 min, and a 7-day TTL
    // far outlives that, so we always update by ts, never response_url).
    slackMessageTs: text("slack_message_ts"),
    // The form as received, sanitized: what every rendering is built from, and
    // what an answer's question and option ids are read back against.
    requestJson: text("request_json", { mode: "json" })
      .$type<HitlRequestData>()
      .notNull(),
    status: text("status", {
      enum: ["awaiting", "answered", "expired", "canceled"]
    })
      .notNull()
      .default("awaiting"),
    // Slack user id of whoever answered (anyone in the thread may).
    answeredBy: text("answered_by"),
    // One answer per question id, as sent to the agent.
    answersJson: text("answers_json", { mode: "json" }).$type<
      Record<string, HitlAnswer>
    >(),
    // A form paged across modals: what each person has entered so far, by Slack
    // user id, kept between its pages until they send it.
    draftsJson: text("drafts_json", { mode: "json" }).$type<
      Record<string, HitlDraft>
    >(),
    createdAt: timestamp("created_at"),
    // Unix-seconds expiry (createdAt + HITL_REQUEST_TTL_SECONDS). The maintenance
    // sweep expires any `awaiting` row past this.
    deadlineAt: integer("deadline_at").notNull(),
    answeredAt: integer("answered_at")
  },
  (t) => [
    // Cancel/expire-by-task: a 🛑 on the trigger message resolves the whole
    // fan-out's open prompts by their shared token.
    index("idx_hitl_forms_token").on(t.token),
    // Expiry sweep: scan open prompts by deadline.
    index("idx_hitl_forms_status_deadline").on(t.status, t.deadlineAt),
    // Retention sweep: delete resolved rows older than the cutoff by createdAt.
    index("idx_hitl_forms_created_at").on(t.createdAt)
  ]
);

/**
 * Per-workspace key/value configuration store. The composite PK
 * `(workspace_id, key)` allows each workspace to hold independent values for
 * the same key (e.g. ws0 stores the global Slack team anchor). The value
 * column is NOT NULL — absence of a key is represented by no row, not a null.
 *
 * System keys (written only by internal code) are exported from
 * `src/db/models/workspace-configs.ts` under `SystemConfigKeys`; ad-hoc
 * admin/operator keys live alongside them without coupling the schema.
 */
export const workspaceConfigs = sqliteTable(
  "workspace_configs",
  {
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at")
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })]
);
