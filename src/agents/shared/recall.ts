import type { SessionMessage } from "agents/sessions";
import { embedMany } from "ai";
import { env } from "cloudflare:workers";
import { EMBED_INPUT_MAX_BYTES } from "@/config";
import { embeddingModel } from "@/agents/model";
import { parseTurn, sessionText } from "@/agents/shared/messages";

/**
 * Episodic recall store. Isolates the embedding model + Vectorize I/O (mirrors
 * how `@/agents/model` isolates the LLM), so the rest of the agent never touches
 * a binding directly and this stays unit-testable with stub `AI`/`VECTORIZE`.
 *
 * The corpus is sourced *only* from an agent's own compacted-away history (see
 * `@/agents/shared/session`), partitioned per instance by `namespace` — so an
 * agent can only ever recall what it already saw (permission-safe by construction).
 */

export interface RecallHit {
  role: string;
  text: string;
  score: number;
  createdAt: string; // ISO-8601; always present
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Cut `text` to {@link EMBED_INPUT_MAX_BYTES} UTF-8 bytes, on a character boundary.
 *
 * The budget is in bytes because that is what bounds the model's token count — see
 * {@link EMBED_INPUT_MAX_BYTES}. Slicing bytes can land mid-sequence, so the tail is
 * decoded leniently and the replacement character that leaves behind is dropped
 * rather than embedded.
 */
function capForEmbedding(text: string): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= EMBED_INPUT_MAX_BYTES) return text;
  return decoder
    .decode(bytes.subarray(0, EMBED_INPUT_MAX_BYTES))
    .replace(/�+$/, "");
}

/**
 * Embed texts via Workers AI. Returns one vector per input, in order.
 *
 * Batching, ordering and retries belong to `embedMany` and to the model's own
 * settings ({@link file://../model.ts model.ts}) — the request size and the
 * one-call-at-a-time shape are declared there, not looped here. The truncation is
 * ours: the binding's `truncate_inputs` cannot be reached through the provider, so
 * an over-long message is cut rather than failing the whole batch. Only the vector
 * is affected; metadata still holds the full text.
 */
async function embed(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: embeddingModel(),
    values: texts.map(capForEmbedding),
    telemetry: { isEnabled: false }
  });
  return embeddings;
}

/**
 * Archive the raw messages displaced by a compaction into the instance's
 * namespace. The vector `id` is the `SessionMessage.id`, so re-archiving an
 * overlapping range is idempotent (an upsert overwrites the same vector). The
 * **full** text is stored in metadata even though the embedding is capped at
 * {@link EMBED_INPUT_MAX_BYTES} — recall returns the exact quote, not a truncation.
 *
 * User turns carry a Gatekeeper-authored `<turn>` wrapper; we parse it back out
 * (the single source of who/where/when) into structured `channel`/`author`/`at`
 * metadata so future recall can filter a channel's history by speaker or origin.
 */
export async function archiveMessages(
  namespace: string,
  messages: SessionMessage[]
): Promise<void> {
  const entries = messages.flatMap((m) => {
    const text = sessionText(m).trim();
    if (!text) return [];
    const createdAt =
      m.createdAt instanceof Date
        ? m.createdAt.toISOString()
        : m.createdAt
          ? String(m.createdAt) // ISO string after JSON round-trip
          : null;
    if (!createdAt) {
      console.warn(`[recall] skipping message ${m.id}: missing createdAt`);
      return [];
    }
    return [
      {
        id: m.id,
        role: m.role,
        text,
        createdAt,
        turn: m.role === "user" ? parseTurn(text) : null
      }
    ];
  });
  if (entries.length === 0) return;

  const values = await embed(entries.map((e) => e.text));
  await env.VECTORIZE.upsert(
    entries.map((e, i) => ({
      id: e.id,
      values: values[i],
      namespace,
      metadata: {
        role: e.role,
        text: e.text,
        createdAt: e.createdAt,
        ...(e.turn && {
          channel: e.turn.channel,
          author: e.turn.id,
          at: e.turn.at
        })
      }
    }))
  );
}

/** Semantic search over this instance's archived history. Scoped to `namespace`. */
export async function recall(
  namespace: string,
  query: string,
  topK = 5
): Promise<RecallHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const [vector] = await embed([trimmed]);
  const res = await env.VECTORIZE.query(vector, {
    namespace,
    topK,
    returnMetadata: "all"
  });
  return res.matches.map((m) => ({
    role: String(m.metadata?.role ?? ""),
    text: String(m.metadata?.text ?? ""),
    score: m.score,
    createdAt: String(m.metadata?.createdAt ?? "")
  }));
}
