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
import { executeAgentTurn, turnGatewayCall } from "@/agents/shared/loop";
import type { OpenCallStore } from "@/agents/shared/open-call";
import { isCancelRequested } from "@/db/models/agent-tasks";
import { archiveMessages } from "@/agents/shared/recall";
import { recallTools } from "@/agents/shared/recall-tool";
import { verifyRemoteAgentEndpoint } from "@/a2a/card-verify";
import { signGatekeeperToken } from "@/auth/agent-outbound";
import {
  getAllowedRemoteAgentDomains,
  getPublicUrl
} from "@/db/models/workspace-configs";
import { adminSoul, callerContext } from "./prompt";
import {
  adminToolApproval,
  buildAdminTools,
  type AdminToolDeps,
  type EndpointVerifier
} from "./tools";
import { generateAvatar, type GeneratedImage } from "./avatar";

// Re-exported so existing test imports (`@/agents/admin/executor`) keep working.
export type {
  AgentSession,
  ContextLike,
  SessionHost,
  SessionLike
} from "@/agents/shared/session";

/** Test seams — production uses the defaults (real model + Sessions store). */
export interface AdminExecutorOptions extends ModelOverrides {
  createSession?: (wsId: number) => AgentSession;
  /**
   * Persist a generated avatar in the agent's DO storage, returning its key.
   * `name` is `"admin"` (the admin's own avatar) or a custom agent's name, so each
   * agent's icons are pruned independently. Injected by {@link AdminAgent} (bound to
   * its DO storage); when absent, avatar generation is unavailable.
   */
  storeIcon?: (
    img: GeneratedImage,
    name: string
  ) => Promise<{ key: string; contentType: string }>;
  /**
   * Where a turn that stops for a human keeps the call it paused on, until the
   * answer resumes it — a question it asked, or a destructive call awaiting an
   * Approve. Bound to the admin DO storage by {@link AdminAgent}; absent in unit
   * tests that never pause.
   */
  openCalls?: OpenCallStore;
}

/**
 * The admin agent's behavior: a Workers-AI tool loop with per-workspace memory.
 *
 * One `Session` per Durable Object (= one per workspace, `admin:{wsId}`), so a
 * `"soul"` identity block + a writable SQLite `"memory"` scratchpad evolve in
 * isolation. The generic turn mechanics live in `@/agents/shared/loop`; this
 * class only supplies the per-workspace session, the registry/workspace tools,
 * and the caller context.
 */
export class AdminAgentExecutor implements AgentExecutor {
  private built?: AgentSession;

  constructor(
    private readonly agent: SessionHost,
    private readonly options: AdminExecutorOptions = {}
  ) {}

  /** Lazily build the one session for this DO; `wsId` is fixed per instance. */
  private getSession(wsId: number): AgentSession {
    if (!this.built) {
      // Must match `instanceNameFor` in dispatch.ts (the DO instance key).
      const namespace = `admin:${wsId}`;
      // The summarizer's own gateway identity. It is a real cost against the same
      // gateway as the turn, and one that no Slack thread asked for — so it is
      // labelled `compaction` rather than left indistinguishable from a round. Its
      // metadata is fixed per instance, which is why it can be built with the
      // session and a round's cannot. No `channel` and no `eventId`: this Session is
      // shared by every task on this DO, so neither would name the work it summarized.
      const summarizer = chatModel(
        { agent: "admin", phase: "compaction", workspaceId: wsId },
        this.options
      );
      this.built = this.options.createSession
        ? this.options.createSession(wsId)
        : buildAgentSession(this.agent, summarizer, {
            soul: () => adminSoul(wsId),
            memoryDescription:
              "Durable facts about this workspace — who the admins are, conventions, and decisions. Keep it concise.",
            memoryMaxTokens: 1200,
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
      // Per round, not per instance: the model carries this round's identity into
      // the AI Gateway log, and that is the only channel the gateway has for it.
      model: (round) =>
        chatModel(
          turnGatewayCall("admin", requestContext, round),
          this.options
        ),
      // The dispatch token is the A2A messageId, and the gatekeeper records a 🛑
      // against that same token — so the running turn can read its own stop flag.
      isCanceled: isCancelRequested,
      // Terse: this rides on a `failed` task, so the delivery boundary already
      // prefixes "⚠️ *Agent …* (failed):" — the apology belongs in one place.
      unexpectedReply:
        "Couldn't handle that admin request. Check the error logs for details.",
      // This agent changes real state, so "said it did" and "did it" must not be
      // the same outcome. The turn has to end in a `final_reply` call rather than
      // in prose, and the calls it actually made are persisted with the reply so a
      // later turn can see what happened instead of re-confirming a claim.
      requireFinalReply: true,
      recordToolCalls: true,
      openCalls: this.options.openCalls,
      prepare: async (_text, metadata) => {
        // Validate the deserialized wire metadata at this boundary. Both the
        // workspace id and the Slack user are guaranteed preconditions (the
        // classifier drops sender-less events), so treat them as required.
        if (
          metadata.agentKind !== "local" ||
          metadata.tenant !== "admin" ||
          metadata.adminWorkspaceId == null ||
          metadata.user == null
        ) {
          throw new Error(
            "[admin-executor] expected admin metadata with an adminWorkspaceId and user"
          );
        }
        const wsId = metadata.adminWorkspaceId;
        const ctx = metadata.user;
        const { session, context } = this.getSession(wsId);
        const namespace = `admin:${wsId}`;
        const hasArchive = (await session.getCompactions()).length > 0;
        // One `deps` for both the tools and the policy that gates them. On a turn
        // resuming an approval, `ctx` is the *approver*, so the SDK re-running the
        // policy re-checks their permissions rather than the requester's — which is
        // the whole reason an approval by a non-admin cannot carry an action through.
        const deps: AdminToolDeps = {
          ctx,
          wsId,
          verifyEndpoint: this.verifyEndpoint(wsId),
          generateImage: (prompt) => generateAvatar(prompt),
          storeIcon: this.options.storeIcon
        };
        return {
          session,
          context,
          systemSuffix: callerContext(ctx, { workspaceId: wsId }),
          toolApproval: adminToolApproval(deps),
          tools: {
            ...buildAdminTools(deps),
            ...recallTools(namespace, hasArchive)
          }
        };
      }
    });
  };

  /**
   * The card verifier for one workspace, bound to this gatekeeper's signing identity.
   *
   * Used by the tools that verify a card during a turn and by the approval policy,
   * which re-reads the live card at the moment a human clicks Approve — one
   * definition, so the two can never disagree about what "verified" means.
   */
  private verifyEndpoint(wsId: number): EndpointVerifier {
    return async (url, tenantId) => {
      const allowedDomains = await getAllowedRemoteAgentDomains();
      // Reading a tenant's card is an *authenticated* call, so it needs the same
      // issuer dispatch signs with. The admin agent only ever runs in response to
      // a Slack event, and the fetch isolate records the public URL on the first
      // one, so this is set by the time an admin can register anything.
      const issuer = await getPublicUrl();
      if (!issuer) {
        throw new Error(
          "Gatekeeper public URL has not been discovered yet. " +
            "Ensure the worker has received at least one Slack event " +
            "before registering remote agents."
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
            // agent doing the registering.
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

  // A2A cancellation isn't supported for this single-shot loop.
  cancelTask = async (): Promise<void> => {};
}
