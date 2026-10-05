import type { AgentManifest } from "@dynamicagents/core/a2a";

/** The transport-independent half of the onboarding concierge's AgentCard. */
export const manifest: AgentManifest = {
  name: "Onboarding Agent",
  description:
    "Dynamic Agents onboarding concierge — explains the system, routes users, and surfaces health.",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "concierge",
      name: "Concierge",
      description:
        "Explain how Dynamic Agents works, point people to the right channel or agent, and report their status.",
      tags: ["onboarding", "directory"],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: []
    }
  ]
};
