import type { AgentCard } from "@a2a-js/sdk";
import type { AgentExecutor } from "@a2a-js/sdk/server";
import { buildAgentCard } from "@/a2a/card";
import { A2AAgent } from "../base";
import { OnboardingAgentExecutor } from "./executor";

/**
 * Onboarding (DM) concierge. One Durable Object instance per user
 * (`onboarding:{slackUserId}`), each with isolated Sessions + memory. Runs a
 * read-only Workers-AI tool loop that explains how Dynamic Agents works, routes users to
 * the right channel/agent name, and surfaces registry health — all over direct
 * message.
 */
export class OnboardingAgent extends A2AAgent {
  protected card(): AgentCard {
    return buildAgentCard({
      name: "Onboarding Agent",
      description:
        "Dynamic Agents onboarding concierge — explains the system, routes users, and surfaces health.",
      pushNotifications: true
    });
  }

  protected builtinTenant(): "onboarding" {
    return "onboarding";
  }

  protected executor(): AgentExecutor {
    return new OnboardingAgentExecutor(this);
  }
}
