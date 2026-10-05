import type { ThinkModel } from "@cloudflare/think";
import { StepAgent } from "@dynamicagents/core/agent";
import type { ContextConfig } from "agents/context";
import type { LanguageModel, ToolSet } from "ai";
import { turnAuthorId } from "@/a2a/turn";
import { buildUserAuthContext } from "@/auth";
import { COMPACT_AFTER_TOKENS, COMPACT_TAIL_TOKENS } from "@/config";
import { agentModel } from "../model";
import { ONBOARDING_MEMORY, ONBOARDING_SOUL } from "./soul";
import { buildOnboardingTools } from "./tools";

/**
 * The onboarding concierge: one per direct-message channel
 * (`onboarding:{dmChannelId}`), which is one per person. The job, the turn and the A2A task are core's; this is its
 * soul, its memory of the person, and the directory tools.
 */
export class OnboardingStepAgent extends StepAgent<Env> {
  protected readonly compactAfterTokens = COMPACT_AFTER_TOKENS;
  protected readonly keepRecentTokens = COMPACT_TAIL_TOKENS;

  override getModel(): ThinkModel {
    return agentModel(this.env, this.name, {
      agent: "onboarding",
      taskId: this.turnTaskId(),
      phase: "turn"
    });
  }

  /** Compaction runs over a history every task shares, so it has no task. */
  protected override compactionModel(): LanguageModel {
    return agentModel(this.env, this.name, {
      agent: "onboarding",
      phase: "compaction"
    });
  }

  override configureContext(): ContextConfig[] {
    return [
      { label: "soul", provider: { get: async () => ONBOARDING_SOUL } },
      { label: "memory", description: ONBOARDING_MEMORY, maxTokens: 1000 },
      ...super.configureContext()
    ];
  }

  override getTools(): ToolSet {
    return {
      ...super.getTools(),
      ...buildOnboardingTools({
        // The person, from the `<turn>` wrapper the gatekeeper put on the job
        // this turn runs — read when a tool runs, which is inside the turn.
        caller: async () => {
          const author = turnAuthorId(this.turnStepJob()?.input ?? "");
          return author ? buildUserAuthContext(author) : null;
        }
      })
    };
  }
}
