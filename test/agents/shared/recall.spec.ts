import { describe, it, expect, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { SessionMessage } from "agents/sessions";
import { EMBED_INPUT_MAX_BYTES } from "@/config";
import { archiveMessages, recall } from "@/agents/shared/recall";
import { recallTools } from "@/agents/shared/recall-tool";

afterEach(() => vi.restoreAllMocks());

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: Date | string | undefined = new Date("2025-01-15T10:00:00.000Z")
): SessionMessage {
  return {
    id,
    role,
    createdAt: createdAt as Date,
    parts: [{ type: "text", text }]
  };
}

/** A message with no text part (e.g. a tool step) — should be skipped. */
const toolOnly = {
  id: "tool1",
  role: "assistant",
  parts: [{ type: "tool-call", toolCallId: "x", toolName: "y", input: {} }]
} as unknown as SessionMessage;

/**
 * Spy on the global `env` AI + VECTORIZE bindings. Recall code reads them off
 * `cloudflare:workers`, so tests stub the real bindings rather than inject a
 * fake env. Restored by the top-level `afterEach`.
 */
function fakeEnv() {
  const upsert = vi.spyOn(env.VECTORIZE, "upsert").mockImplementation((async (
    vectors: unknown[]
  ) => ({
    mutationId: "m",
    count: vectors.length
  })) as never);
  const query = vi
    .spyOn(env.VECTORIZE, "query")
    .mockImplementation((async () => ({
      count: 1,
      matches: [
        {
          id: "a",
          score: 0.91,
          metadata: {
            role: "user",
            text: "deploy plan",
            createdAt: "2025-01-15T10:00:00.000Z"
          }
        }
      ]
    })) as never);
  // One vector per input text; value encodes batch position so order is checkable.
  const run = vi.spyOn(env.AI, "run").mockImplementation((async (
    model: string,
    input: { text: string[] }
  ) => ({
    data: input.text.map((_, i) => [i, i + 1, i + 2])
  })) as never);
  return { upsert, query, run };
}

describe("archiveMessages", () => {
  it("upserts one vector per non-empty message, keyed by message id, scoped to namespace", async () => {
    const { upsert, run } = fakeEnv();
    await archiveMessages("admin:7", [
      msg("a", "user", "hello"),
      msg("b", "assistant", "  "), // whitespace → skipped
      toolOnly, // no text → skipped
      msg("c", "user", "world")
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    const vectors = upsert.mock.calls[0][0] as Array<{
      id: string;
      values: number[];
      namespace: string;
      metadata: { role: string; text: string; createdAt: string };
    }>;
    expect(vectors.map((v) => v.id)).toEqual(["a", "c"]);
    expect(vectors.every((v) => v.namespace === "admin:7")).toBe(true);
    expect(vectors[0].metadata).toEqual({
      role: "user",
      text: "hello",
      createdAt: "2025-01-15T10:00:00.000Z"
    });
    expect(vectors[1].metadata.text).toBe("world");
    expect(vectors[0].values.length).toBeGreaterThan(0);
  });

  it("enriches metadata with channel/author/at parsed from a wrapped turn", async () => {
    const { upsert } = fakeEnv();
    const wrapped =
      '<turn from="Grace" id="U2" channel="general" ' +
      'at="2026-06-25T14:30:00.000Z">deploy the bot</turn>';
    await archiveMessages("admin:0", [msg("w", "user", wrapped)]);

    const vectors = upsert.mock.calls[0][0] as Array<{
      metadata: Record<string, unknown>;
    }>;
    // The embedded text stays the full wrapper; the structured fields are
    // extracted for future channel/author-filtered recall.
    expect(vectors[0].metadata).toEqual({
      role: "user",
      text: wrapped,
      createdAt: "2025-01-15T10:00:00.000Z",
      channel: "general",
      author: "U2",
      at: "2026-06-25T14:30:00.000Z"
    });
  });

  it("no-ops on an empty / all-skipped batch (no AI or Vectorize calls)", async () => {
    const { upsert, run } = fakeEnv();
    await archiveMessages("admin:0", [toolOnly, msg("x", "user", "   ")]);
    expect(run).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("preserves a string createdAt after JSON round-trip", async () => {
    const { upsert } = fakeEnv();
    // After getHistory() round-trip, createdAt is a string, not a Date.
    await archiveMessages("admin:0", [
      msg("r", "user", "round-trip", "2024-11-01T09:00:00.000Z")
    ]);
    const vectors = upsert.mock.calls[0][0] as unknown as Array<{
      metadata: { createdAt: string };
    }>;
    expect(vectors[0].metadata.createdAt).toBe("2024-11-01T09:00:00.000Z");
  });

  it("skips messages that have no createdAt (no upsert)", async () => {
    const { upsert, run } = fakeEnv();
    // Build directly — the msg() helper always sets a default createdAt.
    const noTs = {
      id: "x",
      role: "user",
      parts: [{ type: "text", text: "has text" }]
    } as unknown as SessionMessage;
    await archiveMessages("admin:0", [noTs]);
    expect(run).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("batches embeddings under the per-call cap but upserts once", async () => {
    const { upsert, run } = fakeEnv();
    const many = Array.from({ length: 150 }, (_, i) =>
      msg(`m${i}`, "user", `t${i}`)
    );
    await archiveMessages("admin:0", many);
    expect(run).toHaveBeenCalledTimes(2);
    // 100 then 50, one call at a time. Both halves are declared on the model
    // rather than looped here: the per-call cap, and `supportsParallelCalls:
    // false`, which is what stops `embedMany` firing the chunks concurrently.
    expect(
      run.mock.calls.map((c) => (c[1] as { text: string[] }).text.length)
    ).toEqual([100, 50]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0][0] as unknown[]).length).toBe(150);
  });

  it("caps an over-long message for embedding but archives it whole", async () => {
    const { upsert, run } = fakeEnv();
    const long = "x".repeat(EMBED_INPUT_MAX_BYTES + 500);

    await archiveMessages("admin:0", [msg("long", "user", long)]);

    const input = run.mock.calls[0][1] as {
      text: string[];
      truncate_inputs?: boolean;
    };
    // ASCII, so one byte per character.
    expect(input.text[0]).toHaveLength(EMBED_INPUT_MAX_BYTES);
    // The binding's own `truncate_inputs` is unreachable through the provider,
    // which is why the cap above exists at all.
    expect(input.truncate_inputs).toBeUndefined();
    const vectors = upsert.mock.calls[0][0] as Array<{
      metadata: Record<string, unknown>;
    }>;
    expect(vectors[0].metadata.text).toBe(long);
  });

  it("measures the cap in bytes, and cuts on a character boundary", async () => {
    const { run } = fakeEnv();
    // Three bytes per character, offset by one ASCII character so the budget falls
    // mid-sequence: a naive byte slice would leave half a character behind.
    const long = "a" + "あ".repeat(EMBED_INPUT_MAX_BYTES);

    await archiveMessages("admin:0", [msg("cjk", "user", long)]);

    const sent = (run.mock.calls[0][1] as { text: string[] }).text[0];
    expect(new TextEncoder().encode(sent).length).toBeLessThanOrEqual(
      EMBED_INPUT_MAX_BYTES
    );
    // A character count alone would have sailed past the byte budget, which is what
    // the model's token window actually reacts to.
    expect(sent.length).toBeLessThan(EMBED_INPUT_MAX_BYTES);
    expect(sent).not.toContain("�");
    expect(sent.startsWith("aあ")).toBe(true);
  });
});

describe("recall", () => {
  it("queries within the namespace and maps matches to hits", async () => {
    const { query } = fakeEnv();
    const hits = await recall("admin:7", "how did we deploy?", 3);
    expect(query).toHaveBeenCalledTimes(1);
    const opts = query.mock.calls[0][1] as {
      namespace: string;
      topK: number;
      returnMetadata: string;
    };
    expect(opts.namespace).toBe("admin:7");
    expect(opts.topK).toBe(3);
    expect(opts.returnMetadata).toBe("all");
    expect(hits).toEqual([
      {
        role: "user",
        text: "deploy plan",
        score: 0.91,
        createdAt: "2025-01-15T10:00:00.000Z"
      }
    ]);
  });

  it("short-circuits an empty query without touching AI or Vectorize", async () => {
    const { query, run } = fakeEnv();
    expect(await recall("admin:0", "   ")).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("recallTools (gating)", () => {
  it("omits the recall tool before the first compaction", () => {
    expect(Object.keys(recallTools("admin:0", false))).toEqual([]);
  });

  it("exposes a single recall tool once an archive exists", async () => {
    fakeEnv();
    const tools = recallTools("admin:7", true);
    expect(Object.keys(tools)).toEqual(["recall"]);

    const execute = tools.recall.execute as (
      args: { query: string; topK?: number },
      opts?: unknown
    ) => Promise<{ hits: unknown[]; note?: string }>;
    const out = await execute({ query: "deploy" }, {});
    expect(out.hits).toHaveLength(1);
  });

  it("returns a note when the archive has no matching results", async () => {
    vi.spyOn(env.AI, "run").mockImplementation((async () => ({
      data: [[1, 2, 3]]
    })) as never);
    vi.spyOn(env.VECTORIZE, "query").mockImplementation((async () => ({
      count: 0,
      matches: []
    })) as never);
    const tools = recallTools("admin:0", true);
    const execute = tools.recall.execute as (
      args: { query: string },
      opts?: unknown
    ) => Promise<{ hits: unknown[]; note?: string }>;

    const out = await execute({ query: "something obscure" }, {});
    expect(out.hits).toHaveLength(0);
    expect(out.note).toMatch(/no relevant/i);
  });
});
