import type { LanguageModel, ToolSet } from "ai";
import { generateText } from "ai";
import type {
  AppendOptions,
  CompactionFunction,
  SessionMessage,
  Sessions
} from "agents/sessions";
import { createCompactFunction } from "agents/sessions";
import type { SqlProvider } from "agents/context";
import { AgentContextProvider, ContextBlocks } from "agents/context";
import { CHAT_CALL_OPTIONS } from "@/agents/model";

/**
 * The Durable Object an agent session is built on: the `Sessions` capability its
 * lifecycle installs (durable history) plus the SQLite handle the writable
 * context blocks store themselves in. Both are satisfied by the Agents SDK
 * `Agent` — see {@link file://../base.ts `A2AAgent`}, which installs the
 * capability in its constructor because a capability has to be registered before
 * the lifecycle starts. `env` is passed to executors separately because it's
 * `protected` on `Agent` (only the agent subclass itself can read it).
 */
export interface SessionHost extends SqlProvider {
  readonly sessions: Sessions;
}

/** The subset of `Session` the agent loop drives — lets tests inject a fake. */
export interface SessionLike {
  appendMessage(
    message: SessionMessage,
    options?: AppendOptions
  ): Promise<unknown> | unknown;
  getHistory(): Promise<SessionMessage[]>;
  /** Compaction overlays so far — non-empty ⇒ an episodic archive exists. */
  getCompactions(): Promise<unknown[]>;
}

/**
 * The subset of `ContextBlocks` the agent loop drives. The system prompt and the
 * `set_context` tool live here rather than on the session: history and the blocks
 * rendered above it are two stores, and only the second one the model can edit.
 */
export interface ContextLike {
  refreshSystemPrompt(): Promise<string>;
  tools(): Promise<ToolSet>;
}

/**
 * What one agent Durable Object owns: its durable history and the context blocks
 * its system prompt is rendered from. Built together by
 * {@link buildAgentSession} and handed to the turn as a pair.
 */
export interface AgentSession {
  session: SessionLike;
  context: ContextLike;
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

/**
 * Wrap a compaction function so the raw messages it folds into a summary are
 * also handed to `onArchive` (which embeds them for later recall). The displaced
 * range is `fromMessageId..toMessageId` of the result, sliced from the `history`
 * the compaction saw. Archival failure is swallowed — compaction must still
 * shorten history even if the recall store is briefly unavailable.
 */
export function archivingCompaction(
  base: CompactionFunction,
  onArchive?: (messages: SessionMessage[]) => Promise<void>
): CompactionFunction {
  if (!onArchive) return base;
  return async (history) => {
    const result = await base(history);
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
 * Build the one session an agent Durable Object owns: the history handle its
 * `Sessions` capability hands out, plus a read-only `"soul"` identity block and a
 * writable `"memory"` scratchpad, with history compaction summarized by the same
 * model. Shared by the admin and onboarding agents — only the soul/memory text
 * differ.
 *
 * The default (empty) session id is the only one used: one Durable Object is one
 * conversation here, so the DO instance key *is* the session boundary.
 *
 * The `"memory"` block is declared without a provider and picks up the default —
 * SQLite in this DO, under the block's own label. `"soul"` supplies its own
 * read-only provider, so it is rendered but never writable by the model.
 */
export function buildAgentSession(
  agent: SessionHost,
  model: LanguageModel,
  opts: AgentSessionOptions
): AgentSession {
  const compact = archivingCompaction(
    createCompactFunction({
      summarize: compactionSummarizer(model),
      keepRecentTokens: opts.compactTailTokens
    }),
    opts.onArchive
  );
  const session = agent.sessions
    .session()
    .onCompaction(compact)
    .compactAfter(opts.compactAfterTokens);
  const context = new ContextBlocks(
    [
      { label: "soul", provider: { get: async () => opts.soul() } },
      {
        label: "memory",
        description: opts.memoryDescription,
        maxTokens: opts.memoryMaxTokens
      }
    ],
    // No prompt store: the turn calls `refreshSystemPrompt()` every time, so a
    // frozen snapshot would only ever be read back stale.
    undefined,
    (label) => new AgentContextProvider(agent, label)
  );
  return { session, context };
}
