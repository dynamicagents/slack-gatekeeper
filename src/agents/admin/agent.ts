import type { ThinkModel } from "@cloudflare/think";
import { StepAgent } from "@dynamicagents/core/agent";
import type { ContextConfig } from "agents/context";
import type { LanguageModel, ToolSet } from "ai";
import { verifyRemoteAgentEndpoint } from "@/a2a/card-verify";
import { InvalidEndpointError, originOf } from "@/a2a/endpoint";
import { signGatekeeperToken } from "@/auth/agent-outbound";
import {
  getAllowedRemoteAgentDomains,
  getPublicUrl
} from "@/db/models/workspace-configs";
import { COMPACT_AFTER_TOKENS, COMPACT_TAIL_TOKENS } from "@/config";
import { avatarStoreFor } from "../avatar-store";
import { adminWorkspaceOf } from "../identity";
import { agentModel } from "../model";
import { generateAvatar } from "./avatar";
import { ADMIN_MEMORY, adminSoul } from "./soul";
import { buildAdminTools, type EndpointVerifier } from "./tools";

/**
 * The admin agent: one per workspace (`admin:{wsId}`), managing that
 * workspace's registry from its admin channel.
 *
 * The job, the turn and the A2A task are core's. What is actually this agent is
 * the members below: its soul, its memory, and the registry tools.
 */
export class AdminStepAgent extends StepAgent<Env> {
  protected readonly compactAfterTokens = COMPACT_AFTER_TOKENS;
  protected readonly keepRecentTokens = COMPACT_TAIL_TOKENS;

  /** The workspace this instance manages, read off its own name. */
  private get wsId(): number {
    const wsId = adminWorkspaceOf(this.name);
    if (wsId === null) {
      throw new Error(
        `AdminStepAgent: not an admin instance name: ${this.name}`
      );
    }
    return wsId;
  }

  override getModel(): ThinkModel {
    return agentModel(this.env, this.name, {
      agent: "admin",
      taskId: this.turnTaskId(),
      phase: "turn"
    });
  }

  /** Compaction runs over a history every task shares, so it has no task. */
  protected override compactionModel(): LanguageModel {
    return agentModel(this.env, this.name, {
      agent: "admin",
      phase: "compaction"
    });
  }

  override configureContext(): ContextConfig[] {
    const soul = adminSoul(this.wsId);
    return [
      { label: "soul", provider: { get: async () => soul } },
      { label: "memory", description: ADMIN_MEMORY, maxTokens: 1200 },
      ...super.configureContext()
    ];
  }

  override getTools(): ToolSet {
    const wsId = this.wsId;
    return {
      ...super.getTools(),
      ...buildAdminTools({
        wsId,
        verifyEndpoint: endpointVerifier(wsId),
        generateImage: (prompt) => generateAvatar(prompt),
        storeIcon: (img, name) =>
          avatarStoreFor(this.env, wsId).putIcon(
            img.data,
            img.contentType,
            name
          )
      })
    };
  }
}

/**
 * The card verifier for one workspace, bound to this gatekeeper's signing
 * identity: reading a tenant's card is an authenticated call, so it signs as
 * the admin doing the registering.
 *
 * It refuses an endpoint on this gatekeeper's own origin. The built-in tenants
 * live there, and an agent registered against them would be a way to put the
 * admin's tools in a channel that is not an admin channel.
 */
function endpointVerifier(wsId: number): EndpointVerifier {
  return async (url, tenantId) => {
    const allowedDomains = await getAllowedRemoteAgentDomains();
    // The admin only runs in response to a Slack event, and the fetch isolate
    // records the public URL on the first one, so this is set by now.
    const issuer = await getPublicUrl();
    if (!issuer) {
      throw new Error(
        "Gatekeeper public URL has not been discovered yet. " +
          "Ensure the worker has received at least one Slack event " +
          "before registering remote agents."
      );
    }
    if (URL.canParse(url) && originOf(url) === originOf(issuer)) {
      throw new InvalidEndpointError(
        "that is this gatekeeper's own address — its built-in agents cannot be registered as custom agents"
      );
    }
    return verifyRemoteAgentEndpoint({
      url,
      tenantId,
      allowedDomains,
      authToken: (audience, tenant) =>
        signGatekeeperToken({
          audience,
          issuer,
          tenant,
          // Registration has no agent row yet, so the caller is the admin
          // doing the registering.
          identity: {
            key: `admin:${wsId}:admin`,
            name: "admin",
            kind: "admin",
            workspaceId: wsId
          }
        })
    });
  };
}
