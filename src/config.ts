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
 * `reasoningEffort` is paired with its `id` because it is a property of that
 * model, not a global preference: Cloudflare documents a different
 * `reasoning_effort` enum per model and they do not overlap above `high`.
 *
 * **Nothing will tell you when it is wrong.** Workers AI coerces an unknown
 * effort instead of rejecting it: a single shared `"medium"` was once aimed at
 * GLM-5.2, whose enum has no `medium` at all, and every AI Gateway request body
 * showed it arriving as `high`. So when you change a model here, check its page
 * for its `reasoning_effort` enum, record it in the comment above the entry, and
 * set `reasoningEffort` to the highest that model offers — left to the
 * provider's default depth, GLM has answered registry questions from the
 * conversation instead of calling the tool that would have checked.
 *
 * The two efforts do not travel the same way. The primary's rides as a model
 * setting; the fallback's cannot, because `workers-ai-provider` types
 * `reasoning_effort` as the flash models' `"low" | "medium" | "high"`, so `max`
 * does not typecheck there even though `binding.run` forwards it untouched. It
 * goes through `providerOptions["workers-ai"]` instead, applied by the fallback
 * middleware. One consequence while editing: the primary's effort is typechecked
 * against that enum and the fallback's is not, so a primary ceiling the provider
 * does not declare is a compile error rather than a silent coercion.
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
 * **Bytes rather than characters**, because only bytes bound the *tokens*
 * {@link EMBED_MODEL_ID} counts against its 60,000-token window: its SentencePiece
 * vocabulary spends at least one byte per token, so the encoded length is an upper
 * bound on the token count. A character count is not — one uncommon character can cost
 * several tokens, so a character cap that looks safe for Latin text can still overflow
 * on rarer scripts and reject the whole batch.
 *
 * 48,000 leaves headroom under the window, and leaves ordinary messages untouched:
 * Slack's own per-message ceiling is 40,000 characters. Only the vector is affected —
 * Vectorize still stores the full text as metadata, so recall quotes messages exactly.
 */
export const EMBED_INPUT_MAX_BYTES = 48_000;

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
 * How long a completed agent task is kept before it is swept, covering both the
 * `agent_tasks` correlation rows in D1 (remote agents) and the A2A Tasks a local
 * agent persists in its own Durable Object storage — one policy, because
 * retention should not depend on which side of that boundary an agent runs on.
 *
 * Must stay comfortably longer than {@link HITL_REQUEST_TTL_SECONDS}: a prompt
 * parked for the full 7 days must still find its task on the other side.
 */
export const TASK_RETENTION_SECONDS = 30 * 24 * 60 * 60;
