import { A2A_PROTOCOL_VERSION, type AgentCard } from "@a2a-js/sdk";

/**
 * Placeholder JSON-RPC endpoint path baked into locally-built agent cards. When
 * an agent is reached in-process via a Durable Object `stub.fetch`, the host is
 * irrelevant — the DO answers every POST as JSON-RPC regardless of path — so any
 * absolute URL parses fine and routes correctly. Remote agents supply their own
 * real card via discovery instead.
 */
const PLACEHOLDER_BASE_URL = "https://agent.local";
const A2A_ENDPOINT_PATH = "/a2a";

export interface AgentCardInput {
  name: string;
  description: string;
  /** Override the endpoint URL (remote agents). Defaults to the local placeholder. */
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
 * Build a minimal A2A v1.0 AgentCard. Used for a local in-repo agent, and for a
 * remote one at its already-resolved endpoint — in both cases so a client can be
 * built without a discovery round trip. JSON-RPC is the only transport.
 * Streaming is off; built-ins opt into push notifications.
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
