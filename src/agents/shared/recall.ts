import type { SessionMessage } from "agents/experimental/memory/session";
import { env } from "cloudflare:workers";
import { AI_GATEWAY_ID, EMBED_MODEL_ID } from "@/config";
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

/** Workers AI batches embeddings; keep requests under the per-call input cap. */
const EMBED_BATCH = 100;

export interface RecallHit {
  role: string;
  text: string;
  score: number;
  createdAt: string; // ISO-8601; always present
}

/** Embed texts via Workers AI, batched. Returns one vector per input, in order. */
async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    // truncate_inputs: a single over-long message is truncated for embedding (the
    // full text is still stored in metadata) rather than failing the whole batch.
    const res = (await env.AI.run(
      EMBED_MODEL_ID,
      {
        text: batch,
        truncate_inputs: true
      },
      { gateway: { id: AI_GATEWAY_ID } }
    )) as { data: number[][] };
    out.push(...res.data);
  }
  return out;
}

/**
 * Archive the raw messages displaced by a compaction into the instance's
 * namespace. The vector `id` is the `SessionMessage.id`, so re-archiving an
 * overlapping range is idempotent (an upsert overwrites the same vector). The
 * **full** text is stored in metadata even though the embedding truncates at the
 * model's token limit — recall returns the exact quote, not a truncation.
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
