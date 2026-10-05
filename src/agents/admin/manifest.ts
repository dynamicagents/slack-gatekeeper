import type { AgentManifest } from "@dynamicagents/core/a2a";

/** The transport-independent half of the admin agent's AgentCard. */
export const manifest: AgentManifest = {
  name: "Admin Agent",
  description:
    "Dynamic Agents admin agent — manages the agent registry and workspaces.",
  version: "1.0.0",
  // `extensions` is a required (repeated) protobuf field in v1.0 — no protocol
  // extensions are declared, so it stays empty.
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "admin",
      name: "Administration",
      description:
        "Register, update and remove agents, attach them to channels, and — for the org — manage workspaces.",
      tags: ["admin", "registry"],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: []
    }
  ]
};
