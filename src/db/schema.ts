import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  check
} from "drizzle-orm/sqlite-core";

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
 * migrations/0001_seed_builtins.sql at deploy time. CRUD is Phase 4.
 */
export const agents = sqliteTable(
  "agents",
  {
    name: text("name").primaryKey(),
    // Where this agent runs, and nothing else. `local` is reached in-process
    // through a Durable Object stub; `remote` over HTTP at `a2aEndpoint`.
    // *Which* agent it is — including which built-in — is `tenantId`, on both
    // paths. The gatekeeper sets this itself; no admin chooses it, which is what
    // keeps a registered agent from claiming to be in-process.
    kind: text("kind", { enum: ["local", "remote"] }).notNull(),
    displayName: text("display_name"),
    // Optional gatekeeper-hosted, admin-generated avatar URL (never from the AgentCard).
    iconUrl: text("icon_url"),
    // Always set: custom agents carry a real HTTP endpoint; built-ins use an
    // `http://{name}.local` sentinel. Whether an agent is local is decided by
    // `kind`, not by this value.
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
    // same thing in every row — see `localNamespaceFor`, which routes on it.
    tenantId: text("tenant_id").notNull(),
    // Pinned AgentCard signing identity for custom agents (Trust-On-First-Use).
    // Verified at registration; a later card signed by a different key is
    // rejected. Null for built-in local agents (admin/onboarding are unsigned).
    cardSigningJku: text("card_signing_jku"),
    cardSigningKid: text("card_signing_kid"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // When the agent is woken: `mention` = only on a name mention (machine or
    // display name); `channel_messages` = every channel message. Required (no
    // default) so a missing value is rejected, not silently coerced.
    notifyOn: text("notify_on", {
      enum: ["mention", "channel_messages"]
    }).notNull(),
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
 * Human-in-the-loop (HITL) prompts — one row per open approval/question an agent
 * raised by transitioning its task to `input-required`. This is the correlation
 * store between a Slack interactive message and the paused A2A task: when a human
 * clicks a button (or submits the freeform modal), the interactivity handler
 * looks the row up by `requestId` (the value encoded into the Slack action id),
 * records the answer atomically (first-click-wins), and resumes the task on the
 * same `token` (so continued callbacks land on the paired `agent_tasks` row).
 *
 * Keyed by the agent-chosen `requestId`. Lifecycle: `awaiting` → `answered`
 * (a human decided) | `expired` (TTL swept) | `canceled` (🛑 while parked).
 */
export const hitlRequests = sqliteTable(
  "hitl_requests",
  {
    // Agent-chosen unique id for this prompt (PK). Encoded into the Slack action
    // ids by inputRequestToSlackBlocks, echoed back on the interaction, and used
    // to correlate the answer to this row. `createHitlRequest` is idempotent on
    // it so an at-least-once push redelivery does not double-post the prompt.
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
    // ts of the posted Block Kit prompt — used to chat.update it to an answered /
    // expired / canceled state (a Slack response_url expires after ~30 min, and a
    // 7-day TTL far outlives that, so we always update by ts, never response_url).
    slackMessageTs: text("slack_message_ts"),
    requestKind: text("request_kind", {
      enum: ["approval", "choice"]
    }).notNull(),
    promptText: text("prompt_text").notNull(),
    // JSON-encoded SlackInputOption[] as rendered — the source of truth for the
    // answered-state label and for validating/looking up the chosen optionId.
    optionsJson: text("options_json"),
    allowFreeform: integer("allow_freeform").notNull().default(0),
    status: text("status", {
      enum: ["awaiting", "answered", "expired", "canceled"]
    })
      .notNull()
      .default("awaiting"),
    // Slack user id of whoever answered (anyone in the thread may).
    answeredBy: text("answered_by"),
    answeredOptionId: text("answered_option_id"),
    answerText: text("answer_text"),
    createdAt: timestamp("created_at"),
    // Unix-seconds expiry (createdAt + HITL_REQUEST_TTL_SECONDS). The maintenance
    // sweep expires any `awaiting` row past this.
    deadlineAt: integer("deadline_at").notNull(),
    answeredAt: integer("answered_at")
  },
  (t) => [
    // Cancel/expire-by-task: a 🛑 on the trigger message resolves the whole
    // fan-out's open prompts by their shared token.
    index("idx_hitl_requests_token").on(t.token),
    // Expiry sweep: scan open prompts by deadline.
    index("idx_hitl_requests_status_deadline").on(t.status, t.deadlineAt),
    // Retention sweep: delete resolved rows older than the cutoff by createdAt.
    index("idx_hitl_requests_created_at").on(t.createdAt)
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
