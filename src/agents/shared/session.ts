import type { LanguageModel, ToolSet } from "ai";
import { generateText } from "ai";
import { Session } from "agents/experimental/memory/session";
import type { SessionMessage } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { CHAT_CALL_OPTIONS } from "@/agents/model";

/**
 * The SQLite-backed host the Sessions API needs — satisfied by the Agents SDK
 * `Agent` (`this.sql`). `env` is passed to executors separately because it's
 * `protected` on `Agent` (only the agent subclass itself can read it).
 */
export interface SessionHost {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

/** The subset of `Session` the agent loop drives — lets tests inject a fake. */
export interface SessionLike {
  appendMessage(
    message: SessionMessage,
    parentId?: string | null
  ): Promise<unknown> | unknown;
  getHistory(): Promise<SessionMessage[]>;
  refreshSystemPrompt(): Promise<string>;
  tools(): Promise<ToolSet>;
  /** Compaction overlays so far — non-empty ⇒ an episodic archive exists. */
  getCompactions(): Promise<unknown[]>;
}

export interface AgentSessionOptions {
  /** Read-only identity block injected into the system prompt every turn. */
  soul: () => string | Promise<string>;
  /** Description of the writable SQLite `"memory"` scratchpad the model self-edits. */
  memoryDescription: string;
  /** Soft cap (tokens) for the `"memory"` block. */
  memoryMaxTokens: number;
  /** History token threshold that triggers compaction. */
  compactAfterTokens: number;
  /**
   * Token budget for the recent tail compaction leaves verbatim. Must stay well
   * below {@link compactAfterTokens} or there is no middle left to summarize —
   * see `COMPACT_TAIL_TOKENS` for why the two are one decision.
   */
  compactTailTokens: number;
  /**
   * Archive the raw messages displaced by each compaction (episodic recall).
   * Best-effort: a throw here must never abort compaction.
   */
  onArchive?: (messages: SessionMessage[]) => Promise<void>;
}

type CompactFn = ReturnType<typeof createCompactFunction>;

/**
 * Wrap a compaction function so the raw messages it folds into a summary are
 * also handed to `onArchive` (which embeds them for later recall). The displaced
 * range is `fromMessageId..toMessageId` of the result, sliced from the `history`
 * the compaction saw. Archival failure is swallowed — compaction must still
 * shorten history even if the recall store is briefly unavailable.
 */
export function archivingCompaction(
  base: CompactFn,
  onArchive?: (messages: SessionMessage[]) => Promise<void>
): CompactFn {
  if (!onArchive) return base;
  return async (history, options) => {
    const result = await base(history, options);
    if (result) {
      const from = history.findIndex((m) => m.id === result.fromMessageId);
      const to = history.findIndex((m) => m.id === result.toMessageId);
      if (from !== -1 && to !== -1) {
        try {
          await onArchive(history.slice(from, to + 1));
        } catch (err) {
          console.error("[recall] archive on compaction failed", err);
        }
      }
    }
    return result;
  };
}

/**
 * The summarizer compaction runs: one plain `generateText` over the agent's own
 * model, carrying the same call options as the turn. A summary written at a
 * different reasoning depth than the conversation it compresses would be a drift
 * nothing reports — and the depth now travels with the *model* rather than in the
 * shared call options, so what keeps the two honest is that the executor builds
 * this one through the same `chatModel()` the turn uses.
 */
export function compactionSummarizer(
  model: LanguageModel
): (prompt: string) => Promise<string> {
  return (prompt) =>
    generateText({ model, prompt, ...CHAT_CALL_OPTIONS }).then((r) => r.text);
}

/**
 * Build the one `Session` an agent Durable Object owns: a read-only `"soul"`
 * identity block + a writable `"memory"` scratchpad, with history compaction
 * summarized by the same model. Shared by the admin and onboarding agents — only
 * the soul/memory text differ.
 */
export function buildAgentSession(
  agent: SessionHost,
  model: LanguageModel,
  opts: AgentSessionOptions
): Session {
  const compact = archivingCompaction(
    createCompactFunction({
      summarize: compactionSummarizer(model),
      tailTokenBudget: opts.compactTailTokens
    }),
    opts.onArchive
  );
  return Session.create(agent)
    .withContext("soul", { provider: { get: async () => opts.soul() } })
    .withContext("memory", {
      description: opts.memoryDescription,
      maxTokens: opts.memoryMaxTokens
    })
    .onCompaction(compact)
    .compactAfter(opts.compactAfterTokens);
}
