import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext
} from "@a2a-js/sdk/server";
import { COMPACT_AFTER_TOKENS, COMPACT_TAIL_TOKENS } from "@/config";
import { createModelPair, type ModelOverrides } from "@/agents/model";
import {
  buildAgentSession,
  type SessionHost,
  type SessionLike
} from "@/agents/shared/session";
import { executeAgentTurn } from "@/agents/shared/loop";
import { isCancelRequested } from "@/db/models/agent-tasks";
import { callerContext } from "@/agents/shared/prompt";
import { archiveMessages } from "@/agents/shared/recall";
import { recallTools } from "@/agents/shared/recall-tool";
import { onboardingSoul } from "./prompt";
import { buildOnboardingTools } from "./tools";

/** Test seams — production uses the defaults (real model + Sessions store). */
export interface OnboardingExecutorOptions extends ModelOverrides {
  createSession?: () => SessionLike;
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
  private session?: SessionLike;
  private readonly models: ReturnType<typeof createModelPair>;

  constructor(
    private readonly agent: SessionHost,
    private readonly options: OnboardingExecutorOptions = {}
  ) {
    this.models = createModelPair(this.options);
  }

  /** Lazily build the one Session for this DO (one per user). */
  private getSession(namespace: string): SessionLike {
    if (!this.session) {
      this.session = this.options.createSession
        ? this.options.createSession()
        : buildAgentSession(this.agent, this.models.primary(), {
            soul: onboardingSoul,
            memoryDescription:
              "Durable facts about this user — their name, role, and what they're trying to set up. Keep it concise.",
            memoryMaxTokens: 1000,
            compactAfterTokens: COMPACT_AFTER_TOKENS,
            compactTailTokens: COMPACT_TAIL_TOKENS,
            onArchive: (msgs) => archiveMessages(namespace, msgs)
          });
    }
    return this.session;
  }

  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    await executeAgentTurn(requestContext, eventBus, {
      models: this.models,
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
        const session = this.getSession(namespace);
        const hasArchive = (await session.getCompactions()).length > 0;
        return {
          session,
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
