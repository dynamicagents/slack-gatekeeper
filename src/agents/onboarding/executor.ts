import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext
} from "@a2a-js/sdk/server";
import { COMPACT_AFTER_TOKENS, COMPACT_TAIL_TOKENS } from "@/config";
import { chatModel, type ModelOverrides } from "@/agents/model";
import {
  buildAgentSession,
  type AgentSession,
  type SessionHost
} from "@/agents/shared/session";
import { executeAgentTurn, turnGatewayMetadata } from "@/agents/shared/loop";
import { isCancelRequested } from "@/db/models/agent-tasks";
import { callerContext } from "@/agents/shared/prompt";
import { archiveMessages } from "@/agents/shared/recall";
import { recallTools } from "@/agents/shared/recall-tool";
import { onboardingSoul } from "./prompt";
import { buildOnboardingTools } from "./tools";

/** Test seams — production uses the defaults (real model + Sessions store). */
export interface OnboardingExecutorOptions extends ModelOverrides {
  createSession?: () => AgentSession;
}

/**
 * The onboarding concierge's behavior: a Workers-AI tool loop with per-user
 * memory. One `Session` per Durable Object (= one per user, `onboarding:{userId}`),
 * so a generic concierge `"soul"` + a writable SQLite `"memory"` scratchpad about
 * that user evolve in isolation. The generic turn mechanics live in
 * `@/agents/shared/loop`; this class supplies the session, the read-only
 * `directory_read` tool, and the caller context.
 */
export class OnboardingAgentExecutor implements AgentExecutor {
  private built?: AgentSession;

  constructor(
    private readonly agent: SessionHost,
    private readonly options: OnboardingExecutorOptions = {}
  ) {}

  /** Lazily build the one session for this DO (one per user). */
  private getSession(namespace: string): AgentSession {
    if (!this.built) {
      // Labelled so a compaction summary is distinguishable from a turn in the
      // AI Gateway log. No workspace: this agent runs per user, not per
      // workspace, which is the whole reason its namespace is the user id.
      const summarizer = chatModel(
        { call: "summarize", tenant: "onboarding" },
        this.options
      );
      this.built = this.options.createSession
        ? this.options.createSession()
        : buildAgentSession(this.agent, summarizer, {
            soul: onboardingSoul,
            memoryDescription:
              "Durable facts about this user — their name, role, and what they're trying to set up. Keep it concise.",
            memoryMaxTokens: 1000,
            compactAfterTokens: COMPACT_AFTER_TOKENS,
            compactTailTokens: COMPACT_TAIL_TOKENS,
            onArchive: (msgs) => archiveMessages(namespace, msgs)
          });
    }
    return this.built;
  }

  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    await executeAgentTurn(requestContext, eventBus, {
      // Per turn, not per instance: the model carries this turn's identity into
      // the AI Gateway log, and that is the only channel the gateway has for it.
      model: chatModel(turnGatewayMetadata(requestContext), this.options),
      // The dispatch token is the A2A messageId, and the gatekeeper records a 🛑
      // against that same token — so the running turn can read its own stop flag.
      isCanceled: isCancelRequested,
      // Terse: this rides on a `failed` task, so the delivery boundary already
      // prefixes "⚠️ *Agent …* (failed):" — the apology belongs in one place.
      unexpectedReply: "Something went wrong handling that. Please try again.",
      prepare: async (_text, metadata) => {
        // Validate the deserialized wire metadata at this boundary. The Slack
        // user is a guaranteed precondition (sender-less events are dropped by
        // the classifier), so treat it as required — the same contract the
        // admin agent applies to its workspace id.
        if (
          metadata.agentKind !== "local" ||
          metadata.tenant !== "onboarding" ||
          metadata.user == null
        ) {
          throw new Error(
            "[onboarding-executor] expected onboarding metadata with a user"
          );
        }
        const ctx = metadata.user;
        // Must match `instanceNameFor` in dispatch.ts (the DO instance key).
        const namespace = `onboarding:${ctx.slackUserId}`;
        const { session, context } = this.getSession(namespace);
        const hasArchive = (await session.getCompactions()).length > 0;
        return {
          session,
          context,
          systemSuffix: callerContext(ctx),
          tools: {
            ...buildOnboardingTools({ ctx }),
            ...recallTools(namespace, hasArchive)
          }
        };
      }
    });
  };

  // A2A cancellation isn't supported for this single-shot loop.
  cancelTask = async (): Promise<void> => {};
}
