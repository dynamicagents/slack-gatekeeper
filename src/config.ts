/** Name of the Slack channel whose members are org-level admins. */
export const ORG_ADMIN_CHANNEL_NAME = "da-org-admin";

/** A chat model and the reasoning budget that belongs to that model. */
interface ChatModel {
  /** A Workers AI model id. Must support function calling. */
  readonly id: string;
  /**
   * The highest `reasoning_effort` **this model's own documentation** defines.
   * Not shared with any other model — see {@link CHAT_MODELS}.
   */
  readonly reasoningEffort: string;
}

/**
 * The chat models all in-repo agents run on, in the order they are tried: the
 * primary first, then the fallback the middleware reaches for when the primary
 * fails or answers in prose under an enforced tool choice. Both must support
 * function calling.
 *
 * ## A model and its reasoning budget are one decision
 *
 * They are paired here rather than declared as separate constants because
 * **`reasoningEffort` is a property of the model beside it, not a global
 * preference**. Cloudflare documents a different `reasoning_effort` enum per
 * model, and they do not overlap above `high` — so "turn it up as far as it
 * goes" is a different word for each. Swap an `id` without re-reading that
 * model's enum and you are sending a level it does not define.
 *
 * **Nothing will tell you.** Workers AI coerces an unknown effort instead of
 * rejecting it, which is exactly how this went wrong before: a single shared
 * `"medium"` was aimed at GLM-5.2, whose enum has no `medium` at all, and every
 * AI Gateway request body showed it arriving as `high`. The constant said one
 * thing, the wire said another, and the comment justifying the choice described
 * levels that model never offered.
 *
 * So when you change a model here, change the line above it too: check the
 * model's page for its `reasoning_effort` enum, record it in the comment, and
 * **set `reasoningEffort` to the highest that model offers**. GLM reasons by
 * default, but left to the provider's own depth it has answered registry
 * questions straight from the conversation instead of calling the tool that
 * would have checked.
 *
 * ## The two efforts do not travel the same way
 *
 * The primary's rides as a model setting. The fallback's cannot, because
 * `workers-ai-provider` types `reasoning_effort` as `"low" | "medium" | "high"`
 * — the flash models' enum rather than the whole catalog's — so a value like
 * `max` does not typecheck there even though `binding.run` forwards it
 * untouched. It goes through `providerOptions["workers-ai"]` instead, the
 * provider's documented escape for values its typed surface does not cover and
 * the key it reads ahead of any setting, applied by the fallback middleware
 * where "we are now on the other model" is already known.
 *
 * A consequence worth knowing while editing: the **primary's** effort is
 * typechecked against the provider's declared enum and the **fallback's** is
 * not. If a new primary's ceiling is a word the provider does not declare, that
 * is a compile error, not a silent coercion — which is the good direction for
 * the failure to point.
 */
export const CHAT_MODELS = [
  // @cf/zai-org/glm-5.3-flash — reasoning_effort: low | medium | high
  { id: "@cf/zai-org/glm-5.3-flash", reasoningEffort: "high" },
  // @cf/zai-org/glm-5.2 — reasoning_effort: none | high | max
  { id: "@cf/zai-org/glm-5.2", reasoningEffort: "max" }
  // `satisfies` rather than an annotation: it makes the pairing structural — an
  // entry added with an `id` and no `reasoningEffort` will not compile — while
  // `as const` keeps both as literals, which is what lets the provider accept the
  // id and typecheck the primary's effort against its declared enum.
] as const satisfies readonly ChatModel[];

/** The model a turn is run on, and the fallback tried within the failing call. */
export const [CHAT_PRIMARY, CHAT_FALLBACK] = CHAT_MODELS;

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

/**
 * How many texts one embedding request carries. The provider would default to 3000;
 * this keeps the request the size the recall store has always sent.
 */
export const EMBED_MAX_PER_CALL = 100;

/**
 * UTF-8 **bytes** an input is truncated to before it is embedded.
 *
 * Stands in for the binding's `truncate_inputs`, which cannot be reached through the
 * provider: it spreads extra settings into `binding.run`'s *options*, while Cloudflare
 * declares `truncate_inputs` on the model's *inputs*, and `AiOptions` is a closed type
 * with nowhere to smuggle it through. That flag defaults to `false`, so without a cap
 * of our own one over-long message errors the whole batch instead of being shortened.
 *
 * Bytes rather than characters because only bytes bound the *tokens*
 * {@link EMBED_MODEL_ID} actually counts against its 60,000-token window. Its
 * SentencePiece vocabulary spends at least one byte per token — a learned piece, an
 * `<unk>`, or a byte fallback — so the encoded length is an upper bound on the token
 * count. A character count is not: one uncommon character can cost several tokens, so
 * a character cap that looks safe for Latin text can still overflow on rarer scripts
 * and reject the whole batch.
 *
 * 48,000 leaves headroom under the window. Ordinary messages are untouched — Slack's
 * own per-message ceiling is 40,000 characters, which is 40,000 bytes of ASCII — and
 * the bound holds whatever the script.
 *
 * Only the vector is affected either way: Vectorize still stores the full text as
 * metadata, so recall keeps quoting messages exactly.
 */
export const EMBED_INPUT_MAX_BYTES = 48_000;

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
