import type { AgentManifest, TaskAgent } from "@dynamicagents/core/a2a";
import {
  createA2AWorker,
  defineAgent,
  type MountedAgent
} from "@dynamicagents/core/worker";
import { endpointUrl } from "@dynamicagents/g2a-protocol";
import type { JWK } from "jose";
import { manifest as adminManifest } from "./admin/manifest";
import { manifest as onboardingManifest } from "./onboarding/manifest";
import { isBuiltinIdentity, type BuiltinTenant } from "./identity";

/**
 * Where the built-in tenants answer, on this gatekeeper's own origin.
 *
 * Under `/agents/` rather than core's defaults, because both defaults are taken
 * here: `/.well-known/jwks.json` is the gatekeeper's own token key, and `/a2a/…`
 * is where agents call back. Dispatch derives a built-in's endpoint from
 * {@link AGENTS_RPC_PATH} rather than reading it off the registry.
 */
export const AGENTS_RPC_PATH = "/agents/a2a";
export const AGENTS_JWKS_PATH = "/agents/jwks.json";

/** The built-ins' endpoint, which is also the `aud` dispatch mints for them. */
export function builtinEndpoint(issuer: string): string {
  return endpointUrl(issuer, AGENTS_RPC_PATH);
}

/** The `jku` every built-in's callback token names. */
export function builtinJwksUrl(issuer: string): string {
  return endpointUrl(issuer, AGENTS_JWKS_PATH);
}

/**
 * The public half of the built-ins' signing key: what their callbacks verify
 * against, read straight off the secret rather than fetched from our own
 * `jku`.
 */
export function builtinPublicJwk(env: Env): JWK & { kid: string } {
  const { d: _d, ...pub } = JSON.parse(env.A2A_SIGNING_KEY) as JWK & {
    kid?: string;
  };
  void _d;
  if (!pub.kid) throw new Error("A2A_SIGNING_KEY must include a `kid`");
  return { ...pub, kid: pub.kid };
}

/**
 * The stub card served at `/.well-known/agent-card.json`. It describes the
 * deployment, not an agent, so it names every tenant for a human reading it.
 */
const hostManifest: AgentManifest = {
  name: "slack-gatekeeper",
  description:
    "The Dynamic Agents gatekeeper's built-in agents. Call GetExtendedAgentCard " +
    "with a tenant id for an agent's own card. Tenants: `admin` (the agent " +
    "registry, per workspace), `onboarding` (the direct-message concierge). " +
    "They accept tokens minted by this gatekeeper for them, and no other.",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
};

/**
 * Mount a built-in, refusing any caller the gatekeeper did not mint for it.
 *
 * Core already refuses a token another gatekeeper signed (`GATEKEEPER_ORIGINS`)
 * or one minted for another tenant. What it cannot know is that *this*
 * gatekeeper also mints for remote agents — and a remote row registered against
 * this origin, with tenant `admin`, would carry a valid token here. Its
 * identity says `kind: "remote"`, so this is where it stops.
 */
function builtin<TAgent extends TaskAgent & Rpc.DurableObjectBranded>(
  tenant: BuiltinTenant,
  manifest: AgentManifest,
  agent: (env: Env) => DurableObjectNamespace<TAgent>
): MountedAgent<Env> {
  const mounted = defineAgent<Env, TAgent>({ tenant, manifest, agent });
  return {
    ...mounted,
    resolveAgent(env, identity) {
      if (!isBuiltinIdentity(tenant, identity)) {
        throw new Error(
          `the ${tenant} tenant accepts only the gatekeeper's own ${tenant} identity`
        );
      }
      return mounted.resolveAgent(env, identity);
    }
  };
}

/**
 * The built-in tenants' A2A endpoint: core's edge, with its JWT and tenant
 * checks, mounted on this Worker. Dispatch calls it in-process; core's task
 * hosts call back over HTTP to `/a2a/notifications` like any remote agent.
 */
export const agentsWorker = createA2AWorker<Env>({
  manifest: hostManifest,
  agents: [
    builtin("admin", adminManifest, (env) => env.AdminHost),
    builtin("onboarding", onboardingManifest, (env) => env.OnboardingHost)
  ],
  rpcPath: AGENTS_RPC_PATH,
  jwksPath: AGENTS_JWKS_PATH
});

/**
 * Whether a request is for the built-ins' endpoint. Exact paths only: core
 * matches its card by suffix, and a suffix match here would answer under any
 * prefix — `/icons/…/.well-known/agent-card.json` included.
 */
export function isAgentsRoute(url: URL): boolean {
  return (
    url.pathname === AGENTS_RPC_PATH ||
    url.pathname === AGENTS_JWKS_PATH ||
    url.pathname === AGENT_CARD_PATH
  );
}

/** The well-known path of the stub card. */
const AGENT_CARD_PATH = "/.well-known/agent-card.json";
