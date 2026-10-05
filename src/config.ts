import type { WorkersAIModelOptions } from "@dynamicagents/core/model";

/** Name of the Slack channel whose members are org-level admins. */
export const ORG_ADMIN_CHANNEL_NAME = "da-org-admin";

/**
 * The one chat model every in-repo agent runs on, and the reasoning budget that
 * belongs to that model. Must support function calling.
 *
 * `reasoningEffort` is paired with its `id` rather than standing alone because it
 * is a property of that model, not a global preference: Cloudflare declares a
 * different `reasoning_effort` enum per model and they do not overlap above
 * `high`.
 *
 * **Nothing will tell you when it is wrong.** Workers AI coerces an unknown
 * effort instead of rejecting it: a shared `"medium"` was once aimed at GLM-5.2,
 * whose enum has no `medium` at all, and every AI Gateway request body showed it
 * arriving as `high`. So when you change the model here, read that model's enum
 * off `worker-configuration.d.ts` — `wrangler types` writes one input type per
 * catalog model, and it is the copy that moves when the catalog does — record it
 * in the comment below, and set `reasoningEffort` to the highest that both the
 * model and core's `workersAIModel` accept. Left to the default depth, GLM has
 * answered registry questions from the conversation instead of calling the tool
 * that would have checked.
 *
 * `satisfies` checks the level against both: the model's enum as the generated
 * types declare it, and core's option type, which is `workers-ai-provider`'s
 * `low | medium | high` — a generation behind the runtime, which is why `max`
 * is out of reach here even where a model offers it.
 */
export const CHAT_MODEL = {
  // @cf/zai-org/glm-5.3-flash — reasoning_effort: low | high | max
  id: "@cf/zai-org/glm-5.3-flash",
  reasoningEffort: "high"
} as const satisfies {
  id: keyof AiModels;
  reasoningEffort: NonNullable<
    AiModels["@cf/zai-org/glm-5.3-flash"]["inputs"]["reasoning_effort"]
  > &
    NonNullable<WorkersAIModelOptions["reasoningEffort"]>;
};

/**
 * Workers AI text-to-image model for admin avatar generation. FLUX.2 [klein] 9B —
 * a first-party `@cf/` catalog model that returns a base64-encoded JPEG in `{ image }`,
 * which we decode to bytes before storing.
 */
export const AVATAR_IMAGE_MODEL_ID = "@cf/black-forest-labs/flux-2-klein-9b";

/** Cloudflare AI Gateway slug — "default" auto-provisions a gateway on first request. */
export const AI_GATEWAY_ID = "default";

/**
 * History token estimate past which a built-in agent compacts, and the recent
 * tail compaction keeps verbatim — core's `compactAfterTokens` and
 * `keepRecentTokens`. One policy for every built-in.
 *
 * **The two constants move together.** Compaction summarizes what lies before
 * the tail, so a threshold not comfortably above the tail leaves nothing to
 * summarize and every later turn pays for a wasted summarizer call. A tail of
 * roughly a third of the threshold keeps the middle worth compressing.
 *
 * The whole history is re-sent on every tool step, so this ceiling — not the
 * model's context window, which is far larger — is what per-turn latency and
 * cost scale with.
 */
export const COMPACT_AFTER_TOKENS = 12_000;
export const COMPACT_TAIL_TOKENS = 4_000;

/**
 * How long a human-in-the-loop prompt (an `input-required` task parked on a
 * Slack approval/question) stays open before the maintenance sweep expires it,
 * updates the Slack message, and signals a timeout back onto the A2A task so the
 * agent can finalize. 7 days: long enough that a genuine escalation is never
 * dropped over a weekend, bounded so parked rows don't linger indefinitely.
 */
export const HITL_REQUEST_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long an agent has to finish **one processing leg** — from the moment it is
 * handed the turn to the moment it delivers — before the gatekeeper cancels the task
 * itself and tells the user. The 🛑 stop reaction lives for exactly this long, so
 * the human keeps a working stop control for the whole run.
 *
 * **The default only, and the only place the number is written.** The budget is
 * per agent: every `agents` row carries its own `task_deadline_seconds`
 * (required, and with no database default), and this is the value
 * `registerAgent` writes when a caller registers an agent without naming one.
 * Changing it here is the whole change — the schema holds no default, so there
 * is nothing to update in the database, and the only `3600` in SQL is
 * migration 0021's one-time backfill of the rows that predate the column.
 *
 * A *leg*, not a task lifetime. The clock runs only while a task is `pending`;
 * parking on a human-in-the-loop prompt stops it (that stretch is human time,
 * bounded by {@link HITL_REQUEST_TTL_SECONDS} instead), and a human answer starts
 * a fresh leg of that agent's budget. Charging a slow human to the agent's budget
 * would kill approvals left over a weekend, which is the case that TTL exists for.
 *
 * Built-ins are held to it like any other agent, and are unmodifiable through
 * the admin tools, so they keep this value for good.
 */
export const DEFAULT_TASK_DEADLINE_SECONDS = 60 * 60;

/**
 * How long a completed `agent_tasks` correlation row is kept in D1 before the
 * maintenance sweep removes it. The built-ins' own A2A tasks are core's, which
 * keeps them on a retention policy of its own.
 *
 * Must stay comfortably longer than {@link HITL_REQUEST_TTL_SECONDS}: a prompt
 * parked for the full 7 days must still find its row.
 */
export const TASK_RETENTION_SECONDS = 30 * 24 * 60 * 60;
