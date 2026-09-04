import type { AgentExecutor, ExecutionEventBus } from "@a2a-js/sdk/server";
import { RequestContext } from "@a2a-js/sdk/server";
import { textPart } from "@/a2a/parts";
import { COMPACT_AFTER_TOKENS, COMPACT_TAIL_TOKENS } from "@/config";
import { createModelPair, type ModelOverrides } from "@/agents/model";
import {
  buildAgentSession,
  type SessionHost,
  type SessionLike
} from "@/agents/shared/session";
import { executeAgentTurn } from "@/agents/shared/loop";
import { isCancelRequested } from "@/db/models/agent-tasks";
import { archiveMessages } from "@/agents/shared/recall";
import { recallTools } from "@/agents/shared/recall-tool";
import { verifyRemoteAgentEndpoint } from "@/a2a/card-verify";
import { signGatekeeperToken } from "@/auth/agent-outbound";
import {
  getAllowedRemoteAgentDomains,
  getPublicUrl
} from "@/db/models/workspace-configs";
import {
  HITL_APPROVE_OPTION_ID,
  parseHitlResponse,
  parseHitlTimeout
} from "@/a2a/hitl";
import type { AgentTurnMetadata } from "@/agents/dispatch";
import { adminSoul, callerContext } from "./prompt";
import { buildAdminTools, type EndpointVerifier } from "./tools";
import {
  describeGatedAction,
  runGatedAction,
  type GatedAction
} from "./approvals";
import { generateAvatar, type GeneratedImage } from "./avatar";

// Re-exported so existing test imports (`@/agents/admin/executor`) keep working.
export type { SessionHost, SessionLike } from "@/agents/shared/session";

/** Test seams — production uses the defaults (real model + Sessions store). */
export interface AdminExecutorOptions extends ModelOverrides {
  createSession?: (wsId: number) => SessionLike;
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
   * Persist / retrieve a destructive action deferred behind a human approval,
   * keyed by the HITL `requestId`. `take` reads-and-deletes so an action runs at
   * most once. Bound to the admin DO storage by {@link AdminAgent}; absent in
   * unit tests that don't exercise approvals.
   */
  storePendingAction?: (
    requestId: string,
    action: GatedAction
  ) => Promise<void>;
  takePendingAction?: (requestId: string) => Promise<GatedAction | null>;
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
  private session?: SessionLike;
  private readonly models: ReturnType<typeof createModelPair>;

  constructor(
    private readonly agent: SessionHost,
    private readonly options: AdminExecutorOptions = {}
  ) {
    this.models = createModelPair(this.options);
  }

  /** Lazily build the one Session for this DO; `wsId` is fixed per instance. */
  private getSession(wsId: number): SessionLike {
    if (!this.session) {
      // Must match `instanceNameFor` in dispatch.ts (the DO instance key).
      const namespace = `admin:${wsId}`;
      this.session = this.options.createSession
        ? this.options.createSession(wsId)
        : buildAgentSession(this.agent, this.models.primary(), {
            soul: () => adminSoul(wsId),
            memoryDescription:
              "Durable facts about this workspace — who the admins are, conventions, and decisions. Keep it concise.",
            memoryMaxTokens: 1200,
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
    // A resumed turn may carry the answer to a destructive-action approval. If so,
    // carry the action out (or skip it) here and hand the loop a synthetic message
    // stating the outcome, so the model just confirms it in-persona. All other
    // resumes (an `ask_user` answer, or a fresh message) pass through untouched.
    const turnContext = await this.applyPendingApproval(requestContext);
    await executeAgentTurn(turnContext, eventBus, {
      models: this.models,
      // The dispatch token is the A2A messageId, and the gateway records a 🛑
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
      prepare: async (_text, metadata, turn) => {
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
        const session = this.getSession(wsId);
        const namespace = `admin:${wsId}`;
        const hasArchive = (await session.getCompactions()).length > 0;
        return {
          session,
          systemSuffix: callerContext(ctx, { workspaceId: wsId }),
          tools: {
            ...buildAdminTools({
              ctx,
              wsId,
              verifyEndpoint: this.verifyEndpoint(wsId),
              generateImage: (prompt) => generateAvatar(prompt),
              storeIcon: this.options.storeIcon,
              park: turn.park,
              storePendingAction: this.options.storePendingAction
            }),
            ...recallTools(namespace, hasArchive)
          }
        };
      }
    });
  };

  /**
   * The card verifier for one workspace, bound to this gateway's signing identity.
   *
   * Shared by the tools that verify a card during a turn and by the approval resume
   * below, which re-verifies at the moment a human clicks Approve — one definition,
   * so the two can never disagree about what "verified" means.
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
          "Gateway public URL has not been discovered yet. " +
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

  /**
   * If this turn resumes a parked destructive-action approval, take the pending
   * action and reflect the human's decision: run it on Approve, skip it on Reject
   * / timeout / an unauthorized approver, then return a new {@link RequestContext}
   * whose text states the outcome for the model to confirm. Returns the original
   * context unchanged for every other message (including `ask_user` answers, whose
   * chosen label is already the user text the model should continue from).
   */
  private async applyPendingApproval(
    rc: RequestContext
  ): Promise<RequestContext> {
    const response = parseHitlResponse(rc.userMessage);
    const timeout = parseHitlTimeout(rc.userMessage);
    const requestId = response?.requestId ?? timeout?.requestId;
    if (!requestId || !this.options.takePendingAction) return rc;

    const action = await this.options.takePendingAction(requestId);
    if (!action) return rc; // an ask_user answer, or an action already handled

    const what = describeGatedAction(action);
    let outcome: string;
    if (timeout) {
      outcome = `The approval request to ${what} expired with no response, so it was NOT performed. Let the user know they can ask again if they still want it.`;
    } else {
      const metadata = (rc.userMessage.metadata ??
        {}) as Partial<AgentTurnMetadata>;
      const approver = metadata.user;
      if (response?.optionId === HITL_APPROVE_OPTION_ID && approver) {
        const result = await runGatedAction(action, approver, {
          verifyEndpoint: this.verifyEndpoint(action.wsId)
        });
        outcome = result.ok
          ? `The user approved. I have ${result.summary}. Confirm this succinctly to the user.`
          : `The user approved, but the action could not be completed: ${result.summary}. Explain this plainly to the user.`;
      } else {
        outcome = `The user declined the request to ${what}. It was NOT performed. Acknowledge this briefly.`;
      }
    }

    // v1.0's RequestContext wraps the whole inbound SendMessageRequest rather
    // than a loose message, so the rewritten turn is threaded back through
    // `request.message` — keeping the original configuration and request
    // metadata intact for anything downstream that reads them.
    return new RequestContext(
      {
        ...rc.request,
        message: {
          ...rc.userMessage,
          parts: [textPart(`[system] ${outcome}`)]
        }
      },
      rc.taskId,
      rc.contextId,
      rc.context,
      rc.task,
      rc.referenceTasks
    );
  }

  // A2A cancellation isn't supported for this single-shot loop.
  cancelTask = async (): Promise<void> => {};
}
