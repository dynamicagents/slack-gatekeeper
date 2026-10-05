import { A2A_PROTOCOL_VERSION, type AgentCard } from "@a2a-js/sdk";

/**
 * Placeholder endpoint for a card built without a `url`. Dispatch always passes
 * the agent's real endpoint; the default only has to parse, for a card that is
 * never dialed.
 */
const PLACEHOLDER_BASE_URL = "https://agent.local";
const A2A_ENDPOINT_PATH = "/a2a";

export interface AgentCardInput {
  name: string;
  description: string;
  /** The endpoint URL. Defaults to a placeholder that is never dialed. */
  url?: string;
  /**
   * Which agent at `url`, when the host serves several behind one endpoint.
   *
   * Only a *default* on the client side: the SDK's tenant decorator resolves
   * `tenant || defaultTenant`, so an explicitly-passed tenant still wins. Set it
   * anyway so the synthesized card describes the agent it is actually for.
   */
  tenant?: string;
  /** Whether this agent accepts A2A push-notification configuration. */
  pushNotifications?: boolean;
}

/**
 * Build a minimal A2A v1.0 AgentCard for an agent at its already-resolved
 * endpoint, so a client can be built without a discovery round trip. JSON-RPC
 * is the only transport, and streaming is off.
 *
 * v1.0 replaced the card's flat `url` / `preferredTransport` pair with an
 * ordered `supportedInterfaces` list, where each entry pins its own protocol
 * binding *and* protocol version — that per-interface `protocolVersion` is what
 * a client's transport factory matches on, so it must be the real one (`"1.0"`)
 * rather than the card-level version string v0.3 used.
 */
export function buildAgentCard(input: AgentCardInput): AgentCard {
  return {
    name: input.name,
    description: input.description,
    version: "0.1.0",
    supportedInterfaces: [
      {
        url: input.url ?? `${PLACEHOLDER_BASE_URL}${A2A_ENDPOINT_PATH}`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: input.tenant ?? ""
      }
    ],
    provider: undefined,
    documentationUrl: undefined,
    capabilities: {
      streaming: false,
      pushNotifications: input.pushNotifications ?? false,
      extendedAgentCard: false,
      extensions: []
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "chat",
        name: "Chat",
        description: input.description,
        tags: ["chat"],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: []
      }
    ],
    signatures: [],
    iconUrl: undefined
  };
}
