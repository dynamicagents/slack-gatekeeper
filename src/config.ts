/** Name of the Slack channel whose members are org-level admins. */
export const ORG_ADMIN_CHANNEL_NAME = "looping-org-admin";

/** Workers AI model used by all in-repo agents. Must support function calling. */
export const CHAT_MODEL_ID = "@cf/zai-org/glm-5.2";

/** Fallback model tried when the primary model throws an error. */
export const CHAT_FALLBACK_MODEL_ID = "@cf/zai-org/glm-4.7-flash";

/**
 * Reasoning budget asked of both chat models. GLM reasons by default, but with
 * no budget attached the depth is the provider's — and left to itself it has
 * answered registry questions straight from the conversation instead of calling
 * the tool that would have checked. `medium` is the middle of the three levels
 * the provider accepts: enough deliberation to decide a tool call is needed,
 * without paying `high` on every Slack turn. `null` would disable thinking.
 *
 * Applied as a model *setting* rather than a per-call `providerOptions`, so it
 * covers the tool loop and the Sessions compaction summarizer alike — both run
 * on the same model instance.
 */
export const CHAT_REASONING_EFFORT = "medium";

/**
 * Workers AI text-to-image model for admin avatar generation. FLUX.2 [klein] 9B —
 * a first-party `@cf/` catalog model that returns a base64-encoded JPEG in `{ image }`,
 * which we decode to bytes before storing.
 */
export const AVATAR_IMAGE_MODEL_ID = "@cf/black-forest-labs/flux-2-klein-9b";

/**
 * Workers AI embedding model for episodic recall (archived compacted history).
 * bge-m3 — multilingual (Slack channels are not English-only) with a long context
 * window. 1024-dimensional — must match the `agent-recall` Vectorize index dims.
 */
export const EMBED_MODEL_ID = "@cf/baai/bge-m3";

/** Cloudflare AI Gateway slug — "default" auto-provisions a gateway on first request. */
export const AI_GATEWAY_ID = "default";

/**
 * History token estimate that triggers Session compaction, and the token budget
 * for the verbatim tail that compaction leaves untouched.
 *
 * One policy for every in-repo agent. History holds only the user turn and the
 * assistant's final text — intra-turn tool steps never reach the store — so a
 * turn costs a couple hundred tokens and both agents accumulate at the same
 * rate. (The `memory` block size *is* tuned per agent; this is not.)
 *
 * The two constants move together. Compaction summarizes the span between the
 * protected head and the tail, so a threshold that is not comfortably above the
 * tail budget leaves nothing to summarize: the compaction function returns null,
 * history is never shortened, and every later message pays for a wasted
 * summarizer call. A tail of roughly a third of the threshold keeps the middle
 * worth compressing. Raise one and you must raise the other.
 *
 * 12k/4k puts the floor near 5-6k and the ceiling at 12k: the model sees ~10-20
 * recent exchanges verbatim, and older context reaches it through the rolling
 * summary, the writable `memory` block, and Vectorize recall. The AI SDK
 * re-sends the whole history on every tool step, so this ceiling — not the
 * model's context window, which is far larger — is what per-turn latency and
 * cost scale with.
 */
export const COMPACT_AFTER_TOKENS = 12_000;
export const COMPACT_TAIL_TOKENS = 4_000;

/**
 * How long a human-in-the-loop prompt (an `input-required` task parked on a
 * Slack approval/question) stays open before the gatekeeper expires it. On expiry
 * the maintenance sweep marks the request `expired`, updates the Slack message
 * to an expired state, and signals a timeout back onto the A2A task so the agent
 * can finalize. Fixed at 7 days: long enough that a genuine escalation is never
 * dropped over a weekend, bounded so parked rows don't linger indefinitely.
 */
export const HITL_REQUEST_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long an agent has to finish **one processing leg** — from the moment it is
 * handed the turn to the moment it delivers — before the gatekeeper cancels the task
 * itself and tells the user. The 🛑 stop reaction lives for exactly this long, so
 * the human keeps a working stop control for the whole run.
 *
 * A *leg*, not a task lifetime. The clock runs only while a task is `pending`;
 * parking on a human-in-the-loop prompt stops it (that stretch is human time,
 * bounded by {@link HITL_REQUEST_TTL_SECONDS} instead), and a human answer starts
 * a fresh hour. Charging a slow human to the agent's budget would kill approvals
 * left over a weekend, which is the case that TTL exists for.
 *
 * Only remote agents can reach this. A built-in runs inside a Durable Object held
 * alive by `SETTLE_TIMEOUT_MS` (8 minutes) — see `a2a/notifications/local.ts`,
 * which explains why that one must *not* be raised to match.
 */
export const TASK_DEADLINE_SECONDS = 60 * 60;

/**
 * How long a completed agent task is kept before it is swept, for both halves of
 * the split: the `agent_tasks` correlation rows in D1 (remote agents) and the A2A
 * Tasks a local agent persists in its own Durable Object storage. One constant
 * because it is one policy — a task's retention should not depend on which side
 * of the local/remote boundary the agent runs on.
 *
 * Comfortably longer than {@link HITL_REQUEST_TTL_SECONDS}: a prompt parked for
 * the full 7 days must still find its task on the other side.
 */
export const TASK_RETENTION_SECONDS = 30 * 24 * 60 * 60;
