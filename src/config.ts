/** Name of the Slack channel whose members are org-level admins. */
export const ORG_ADMIN_CHANNEL_NAME = "da-org-admin";

/**
 * The one chat model every in-repo agent runs on, and the reasoning budget that
 * belongs to that model. Must support function calling.
 *
 * `reasoningEffort` is paired with its `id` rather than standing alone because it
 * is a property of that model, not a global preference: Cloudflare documents a
 * different `reasoning_effort` enum per model and they do not overlap above
 * `high`.
 *
 * **Nothing will tell you when it is wrong.** Workers AI coerces an unknown
 * effort instead of rejecting it: a shared `"medium"` was once aimed at GLM-5.2,
 * whose enum has no `medium` at all, and every AI Gateway request body showed it
 * arriving as `high`. So when you change the model here, check its page for its
 * `reasoning_effort` enum, record it in the comment below, and set
 * `reasoningEffort` to the highest that model offers — left to the provider's
 * default depth, GLM has answered registry questions from the conversation
 * instead of calling the tool that would have checked.
 *
 * `as const` keeps both as literals, which is what lets the provider accept the
 * id and typecheck the effort against the enum it declares for *this* model — so
 * a ceiling the provider does not know about is a compile error at the model
 * settings rather than a silent coercion on every call.
 */
export const CHAT_MODEL = {
  // @cf/zai-org/glm-5.3-flash — reasoning_effort: low | medium | high
  id: "@cf/zai-org/glm-5.3-flash",
  reasoningEffort: "high"
} as const;

/**
 * Workers AI text-to-image model for admin avatar generation. FLUX.2 [klein] 9B —
 * a first-party `@cf/` catalog model that returns a base64-encoded JPEG in `{ image }`,
 * which we decode to bytes before storing.
 */
export const AVATAR_IMAGE_MODEL_ID = "@cf/black-forest-labs/flux-2-klein-9b";

/** Cloudflare AI Gateway slug — "default" auto-provisions a gateway on first request. */
export const AI_GATEWAY_ID = "default";

/**
 * History token estimate that triggers Session compaction, and the token budget
 * for the verbatim tail that compaction leaves untouched.
 *
 * One policy for every in-repo agent. (The `memory` block size *is* tuned per
 * agent; this is not.)
 *
 * **The two constants move together.** Compaction summarizes the span between
 * the protected head and the tail, so a threshold that is not comfortably above
 * the tail budget leaves nothing to summarize: the compaction function returns
 * null, history is never shortened, and every later message pays for a wasted
 * summarizer call. A tail of roughly a third of the threshold keeps the middle
 * worth compressing. Raise one and you must raise the other.
 *
 * The AI SDK re-sends the whole history on every tool step, so this ceiling —
 * not the model's context window, which is far larger — is what per-turn latency
 * and cost scale with.
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
 * Only remote agents can reach this. A built-in runs inside a Durable Object held
 * alive by `SETTLE_TIMEOUT_MS` (8 minutes) — see `a2a/notifications/local.ts`,
 * which explains why that one must *not* be raised to match. Built-ins are also
 * unmodifiable through the admin tools, so they keep this value for good.
 */
export const DEFAULT_TASK_DEADLINE_SECONDS = 60 * 60;

/**
 * How long a completed agent task is kept before it is swept, covering both the
 * `agent_tasks` correlation rows in D1 (remote agents) and the A2A Tasks a local
 * agent persists in its own Durable Object storage — one policy, because
 * retention should not depend on which side of that boundary an agent runs on.
 *
 * Must stay comfortably longer than {@link HITL_REQUEST_TTL_SECONDS}: a prompt
 * parked for the full 7 days must still find its task on the other side.
 */
export const TASK_RETENTION_SECONDS = 30 * 24 * 60 * 60;
