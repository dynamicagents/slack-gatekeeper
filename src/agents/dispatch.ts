import {
  Role,
  type Message,
  type TaskPushNotificationConfig
} from "@a2a-js/sdk";
import { buildUserAuthContext, type UserAuthContext } from "@/auth";
import { env } from "cloudflare:workers";
import {
  signGatekeeperToken,
  type RemoteIdentity
} from "@/auth/agent-outbound";
import { getAgent, type AgentRow } from "@/db/models/agents";
import { getWorkspaceByAdminChannel } from "@/db/models/workspaces";
import { resumeFromInput } from "@/db/models/agent-tasks";
import { signalReactionSync } from "@/workflows/reaction-helpers";
import type { HitlRequestRow } from "@/db/models/hitl-requests";
import { buildHitlResponseParts, buildHitlTimeoutParts } from "@/a2a/hitl";
import { buildAgentCard } from "@/a2a/card";
import { buildMessage, textPart } from "@/a2a/parts";
import { localPushNotificationConfig } from "@/a2a/notifications/local";
import { NOTIFICATIONS_PATH } from "@/a2a/notifications/remote";
import { notifyHitlContinuationFailed } from "@/a2a/notifications/hitl";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import {
  sendA2ALocal,
  sendA2ARemote,
  cancelA2ARemote,
  type A2AAccept,
  type CancelOutcome
} from "@/a2a/client";
import { audienceFor, validateRemoteEndpoint } from "@/a2a/endpoint";
import {
  getAllowedRemoteAgentDomains,
  getPublicUrl
} from "@/db/models/workspace-configs";
import { renderTurn, turnContextFromPayload } from "@/agents/shared/messages";

/** The subset of an agent registry row the dispatcher needs (Rpc-serializable). */
export interface DispatchAgentRef {
  name: string;
  kind: AgentRow["kind"];
  a2aEndpoint: string;
  /** Which agent to address at `a2aEndpoint` — see `agents.tenantId`. */
  tenantId: string;
  workspaceId: number;
}

/**
 * The per-agent routing extras carried alongside the caller. The universal
 * `user` lives on {@link DispatchPayload}; this union holds only the fields that
 * differ between agents. The executor narrows on these (it reads deserialized
 * JSON and has no access to {@link DispatchAgentRef}).
 *
 * Both facts travel, mirroring the registry: `agentKind` is *where* the agent
 * runs, `tenant` is *which* agent it is. Carrying only the tenant would not
 * narrow — the remote arm's tenant is an open string, so it overlaps the
 * built-in literals and TypeScript could not tell the members apart.
 */
export type DispatchMetadata =
  | { agentKind: "local"; tenant: "admin"; adminWorkspaceId: number }
  | { agentKind: "local"; tenant: "onboarding" }
  | { agentKind: "remote"; tenant: string; workspaceId: number };

/**
 * What rides on the A2A `message.metadata` and what the executor reads back.
 * Who/where/when is carried in the turn *text* (the Gateway-applied `<turn>`
 * wrapper), not here — this is only the caller (`user`, for authorization) plus
 * the per-kind routing extras.
 */
export type AgentTurnMetadata = { user: UserAuthContext } & DispatchMetadata;

export interface DispatchPayload {
  /**
   * Slack `event_id` of the triggering delivery — the idempotency anchor. Folded
   * with the agent instance into a deterministic {@link buildDispatchId} so a
   * re-dispatch (workflow-step retry) carries the same A2A `messageId` and push
   * `token`; a conformant remote dedupes on the `messageId` instead of appending
   * the turn twice.
   */
  eventId: string;
  /** Original user text. */
  text: string;
  /** Slack channel id — combined with `threadTs` into the A2A `contextId`. */
  channelId: string;
  /** Resolved human channel name (`general`), or null when unresolved / a DM. */
  channelName: string | null;
  /** Thread timestamp (or message `ts` for top-level) — the thread key. */
  threadTs: string;
  /** Slack message timestamp of the originating user turn. */
  messageTs: string;
  /** The caller — ALWAYS present (the classifier boundary guarantees it). */
  user: UserAuthContext;
  /** Only the per-kind extras; merged with `user` onto the wire metadata. */
  metadata: DispatchMetadata;
}

/**
 * Isolate-level memo of the gateway's public origin (the JWT `iss` + `jku` host).
 * Written to D1 by the fetch isolate on first verified Slack request; the Workflow
 * isolate reads it once here and caches it for its lifetime. Resets on cold start
 * (redeploy / domain change), so a changed origin is picked up by the new isolate.
 */
let cachedIssuer: string | null = null;

/** Reset the isolate-level issuer cache. Only for test isolation. */
export function _resetIssuerCacheForTest(): void {
  cachedIssuer = null;
}

/** Read (and memoize) the gateway issuer origin from D1. */
async function resolveIssuer(): Promise<string | null> {
  if (cachedIssuer !== null) return cachedIssuer;
  const issuer = await getPublicUrl();
  if (issuer) cachedIssuer = issuer;
  return issuer;
}

/** Stable per-thread A2A context id, e.g. `"{channelId}:{threadTs}"`. */
export const buildContextId = (channelId: string, threadTs: string): string =>
  `${channelId}:${threadTs}`;

/** Encode bytes as a fixed-length lowercase-alphanumeric (base36) id. */
function base36Id(bytes: Uint8Array, length: number): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(length, "0").slice(-length);
}

/**
 * Deterministic per-dispatch id: `SHA-256({eventId}:{instanceKey})`
 * truncated to 96 bits and base36-encoded → a compact 19-char alphanumeric token
 * (e.g. `k3n7p2q9x4m8r5t6w1a`). Used verbatim as the A2A `messageId` (a conformant
 * remote dedupes on it) and the push `token` (so a retried dispatch reuses one
 * `agent_tasks` row and one callback target). Same inputs ⇒ same id ⇒ safe to
 * re-send; 96 bits makes a collision within the short-lived task set negligible,
 * and hashing means the id exposes neither the Slack event id nor the agent key.
 */
export async function buildDispatchId(
  eventId: string,
  agent: Pick<DispatchAgentRef, "kind" | "workspaceId" | "name">
): Promise<string> {
  const input = `${eventId}:${buildAgentInstanceKey(agent)}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  );
  return base36Id(digest.subarray(0, 12), 19);
}

/**
 * Stable remote caller key derived from the registered agent row. The endpoint
 * is intentionally excluded so multiple logical agents can safely share it.
 *
 * A remote agent names its Durable Object from this, so the string is durable
 * state on the *other* side of the wire: changing its shape re-keys every remote
 * agent and their per-caller memory starts empty. `kind` moving from `custom` to
 * `remote` did exactly that, once, deliberately — see `dispatch.spec.ts`, which
 * pins the format so a later edit has to be a decision rather than an accident.
 */
export function buildAgentInstanceKey(
  agent: Pick<DispatchAgentRef, "kind" | "workspaceId" | "name">
): string {
  return `${agent.kind}:${agent.workspaceId}:${agent.name}`;
}

/** Canonical signed identity of the gateway-agent instance calling remotely. */
export function buildRemoteIdentity(
  agent: Pick<DispatchAgentRef, "kind" | "workspaceId" | "name">
): RemoteIdentity {
  return {
    key: buildAgentInstanceKey(agent),
    name: agent.name,
    kind: agent.kind,
    workspaceId: agent.workspaceId
  };
}

/**
 * Remote context id namespaces channel/thread history by the calling agent
 * instance so sibling agents sharing one endpoint never collide.
 */
export function buildRemoteContextId(
  identity: Pick<RemoteIdentity, "key">,
  channelId: string,
  threadTs: string
): string {
  return (
    `agent=${encodeURIComponent(identity.key)}` +
    `&channel=${encodeURIComponent(channelId)}` +
    `&thread=${encodeURIComponent(threadTs)}`
  );
}

/**
 * The Durable Object namespace for a built-in local agent, or `undefined` for
 * remote agents (reached over HTTP at their `a2aEndpoint`).
 *
 * Two decisions, deliberately kept on two different fields:
 *
 *  - **`kind` decides local vs remote.** It is set by the gateway when the row
 *    is created and no admin can choose it.
 *  - **`tenantId` decides which local agent**, the same field that picks which
 *    agent at a remote endpoint. So one column means "which agent" on both
 *    paths, and a locally-generated agent later becomes a tenant resolved from
 *    a table rather than a new arm of this `switch`.
 *
 * The `kind` guard has to come first and has to stay on `kind`. Routing
 * local-vs-remote off `tenantId` alone would let a **remote agent registered
 * with `tenantId: "admin"` be dispatched into this gateway's own AdminAgent** —
 * privilege escalation through a field an org admin types. `dispatch.spec.ts`
 * asserts that directly.
 *
 * Direct `env` access keeps the binding types intact — renaming a binding fails
 * to compile here rather than string-indexing `env` and casting the type away.
 */
function localNamespaceFor(
  agent: Pick<AgentRow, "kind" | "tenantId">
): DurableObjectNamespace | undefined {
  if (agent.kind === "remote") return undefined;
  switch (agent.tenantId) {
    case "admin":
      return env.AdminAgent;
    case "onboarding":
      return env.OnboardingAgent;
    default:
      return undefined;
  }
}

/**
 * Durable Object instance name for a local agent. The admin agent runs **one
 * instance per workspace** (`admin:0` = org, `admin:1`, …) and the onboarding
 * concierge runs **one instance per user** (`onboarding:{slackUserId}`), so each
 * has its own SQLite — isolated Sessions + memory.
 *
 * Keyed on the tenant, the same field `localNamespaceFor` picks the class with,
 * so one value chooses both. The strings it produces are unchanged, which is why
 * built-ins keep their existing Durable Objects across the `kind` rename.
 */
export function instanceNameFor(metadata: AgentTurnMetadata): string {
  if (metadata.agentKind !== "local") {
    throw new Error("unreachable: instanceNameFor called for a remote agent");
  }
  switch (metadata.tenant) {
    case "admin":
      return `admin:${metadata.adminWorkspaceId}`;
    case "onboarding":
      return `onboarding:${metadata.user.slackUserId}`;
    default:
      throw new Error("unreachable: no local agent for that tenant");
  }
}

/**
 * The push-notification config handed to a remote agent: the gateway's public
 * callback URL plus the per-task validation token it must echo back. v1.0
 * flattened v0.3's nested config into `TaskPushNotificationConfig`; `id` and
 * `taskId` are assigned by the agent when it registers the config, so they go
 * out empty. The callback's real authenticator is the remote's signed JWT (see
 * `handleRemoteAgentNotification`) — `token` is the correlation key.
 */
function remotePushNotificationConfig(
  issuer: string,
  token: string
): TaskPushNotificationConfig {
  return {
    tenant: "",
    id: "",
    taskId: "",
    url: `${issuer}${NOTIFICATIONS_PATH}`,
    token,
    authentication: undefined
  };
}

/**
 * The outcome of a dispatch. All agents accept a Task here and deliver their real
 * reply later: remote agents call the authenticated public callback, while local
 * built-ins use a trusted in-process sender. The workflow receives the shared
 * correlation `token` and the assigned `taskId`; a contract violation (a reply
 * that isn't a Task acceptance) is surfaced as a visible error reply.
 */
export type DispatchResult =
  | { kind: "error_reply"; text: string }
  | { kind: "accepted"; token: string; taskId: string };

/**
 * User-facing explanation of a deterministic A2A protocol refusal. Each code is
 * a spec-defined verdict about the request, so the user gets the actual reason
 * instead of the generic "couldn't be reached" a retry-exhaustion would produce.
 *
 * The copy lives here rather than in `@/a2a/errors` because `a2a/` owns protocol
 * facts while dispatch owns what a user is told — and only dispatch knows whose
 * fault it is. On the *local* path the refusal comes from the gateway's own A2A
 * server (`src/a2a/serve.ts`), so "contact the agent developer" would be wrong.
 */
function protocolErrorText(
  agent: Pick<DispatchAgentRef, "name" | "kind" | "tenantId">,
  code: number
): string {
  const who = `The agent *${agent.name}*`;
  let reason: string;
  switch (code) {
    case A2A_ERROR_CODE.VERSION_NOT_SUPPORTED:
      reason = `${who} rejected the request because it doesn't speak A2A v1.0.`;
      break;
    case A2A_ERROR_CODE.INVALID_PARAMS:
    case A2A_ERROR_CODE.PARSE_ERROR:
    case A2A_ERROR_CODE.INVALID_REQUEST:
      reason = `${who} rejected the request as malformed.`;
      break;
    case A2A_ERROR_CODE.UNSUPPORTED_OPERATION:
    case A2A_ERROR_CODE.METHOD_NOT_FOUND:
      reason = `${who} doesn't support the message-send operation the gateway uses.`;
      break;
    case A2A_ERROR_CODE.PUSH_NOTIFICATION_NOT_SUPPORTED:
      // Not a "try again later": the gateway is push-only by construction, so
      // this agent cannot deliver a reply through it at all.
      reason =
        `${who} doesn't support push notifications, which the gateway ` +
        `requires to deliver replies — it can't be used with the gateway.`;
      break;
    case A2A_ERROR_CODE.CONTENT_TYPE_NOT_SUPPORTED:
      reason = `${who} doesn't accept plain-text messages.`;
      break;
    case A2A_ERROR_CODE.EXTENSION_SUPPORT_REQUIRED:
      reason = `${who} requires an A2A extension the gateway doesn't implement.`;
      break;
    default:
      reason = `${who} rejected the request (A2A error ${code}).`;
  }
  return localNamespaceFor(agent)
    ? `${reason} This is a gateway bug — please check the error logs.`
    : `${reason} Please contact the agent developer.`;
}

/**
 * Fold an {@link A2AAccept} into the workflow-facing {@link DispatchResult}.
 * Shared by both dispatch branches so local and remote agents report a
 * non-accept identically, differing only in the copy each earns.
 */
function dispatchResultFor(
  accept: A2AAccept,
  agent: Pick<DispatchAgentRef, "name" | "kind" | "tenantId">,
  token: string
): DispatchResult {
  switch (accept.kind) {
    case "accepted":
      return { kind: "accepted", token, taskId: accept.taskId };
    case "protocol_error":
      return {
        kind: "error_reply",
        text: protocolErrorText(agent, accept.code)
      };
    case "contract_violation":
      return {
        kind: "error_reply",
        text: localNamespaceFor(agent)
          ? "Local agent did not provide the required task acknowledgment."
          : "Remote agent did not provide the required task acknowledgment."
      };
  }
}

/**
 * Dispatch a user message to an agent over A2A. Routing is by `agent.kind`:
 * built-in local agents are reached in-process via their DO `stub.fetch`; custom
 * agents go over real HTTP at their `a2aEndpoint`. Both return task acceptance
 * and deliver status snapshots through their respective push-notification path.
 */
export async function dispatchToAgent(
  agent: DispatchAgentRef,
  payload: DispatchPayload
): Promise<DispatchResult> {
  const localContextId = buildContextId(payload.channelId, payload.threadTs);
  const ns = localNamespaceFor(agent);

  // Deterministic per-dispatch id → the A2A `messageId` (dedupe key) and, for
  // remotes, the push `token`. Stable across retries so re-delivery is idempotent.
  const dispatchId = await buildDispatchId(payload.eventId, agent);

  // The Gateway owns provenance: who/where/when is inlined into the turn text via
  // the `<turn>` wrapper, once, identically for local and remote agents. Nothing
  // structured rides alongside — downstream agents (and the recall archiver) read
  // it back from the text. See renderTurn / parseTurn in shared/messages.
  const text = renderTurn(payload.text, turnContextFromPayload(payload));

  if (!ns) {
    // Custom agent → real HTTP. The caller's identity travels in a short-lived,
    // EdDSA-signed gateway JWT (verified by the remote against our public JWKS),
    // NOT as plaintext `message.metadata` — so a remote agent can neither read
    // the full `UserAuthContext` nor forge the caller's permissions.
    const allowedDomains = await getAllowedRemoteAgentDomains();
    validateRemoteEndpoint(agent.a2aEndpoint, allowedDomains); // SSRF + approved-domain defense-in-depth

    const identity = buildRemoteIdentity(agent);
    const issuer = await resolveIssuer();
    if (!issuer) {
      throw new Error(
        "Gateway public URL has not been discovered yet. " +
          "Ensure the worker has received at least one Slack event before registering remote agents."
      );
    }
    const gatewayToken = await signGatekeeperToken({
      audience: audienceFor(agent.a2aEndpoint),
      issuer,
      identity,
      tenant: agent.tenantId
    });

    const remoteMessage = buildMessage({
      // Deterministic id so a retried dispatch is dedupable by the remote rather
      // than appended as a fresh turn (A2A `messageId` is the sender-set dedupe key).
      messageId: dispatchId,
      role: Role.ROLE_USER,
      parts: [textPart(text)],
      contextId: buildRemoteContextId(
        identity,
        payload.channelId,
        payload.threadTs
      ),
      // The signed token is the only authority — it names the calling
      // gateway-agent instance, not any Slack user. The turn's who/where/when
      // lives in the `<turn>` text; no gateway authorization or permission
      // context ever crosses this boundary.
      metadata: { ...payload.metadata }
    });

    // Push-notification validation token = the same deterministic dispatch id. The
    // remote echoes it on the callback so the gateway correlates it to the pending
    // task (A2A §13.2); the webhook still verifies the remote's signature against
    // its pinned card key (that JWT is the real authenticator — this token is the
    // correlation/dedupe key, stable across retries so they collapse to one row).
    const accept = await sendA2ARemote(
      {
        endpoint: agent.a2aEndpoint,
        authToken: gatewayToken,
        tenant: agent.tenantId
      },
      remoteMessage,
      remotePushNotificationConfig(issuer, dispatchId)
    );
    return dispatchResultFor(accept, agent, dispatchId);
  }

  // Local agent → in-process via DO stub.fetch. Trusted same-worker dispatch, so
  // the full caller context rides on the message metadata (for authorization);
  // provenance still travels in the `<turn>` text like every other agent.
  const metadata: AgentTurnMetadata = {
    user: payload.user,
    ...payload.metadata
  };
  const message = buildMessage({
    // Deterministic id (same dedupe rationale as the remote path).
    messageId: dispatchId,
    role: Role.ROLE_USER,
    parts: [textPart(text)],
    contextId: localContextId,
    metadata: { ...metadata }
  });

  const instanceName = instanceNameFor(metadata);

  const stub = ns.get(ns.idFromName(instanceName));
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    stub.fetch(input as RequestInfo, init)) as typeof fetch;
  const card = buildAgentCard({
    name: agent.name,
    description: `Local ${agent.kind} agent`,
    pushNotifications: true
  });

  const accept = await sendA2ALocal(
    { card, fetchImpl, tenant: agent.tenantId },
    message,
    localPushNotificationConfig(dispatchId)
  );
  return dispatchResultFor(accept, agent, dispatchId);
}

/** A human's answer to a HITL prompt, as captured from Slack. */
export interface HitlAnswer {
  /** The chosen option id (absent for a pure freeform answer). */
  optionId?: string;
  /** Freeform text the human typed, if any. */
  text?: string;
  /** Slack user id of whoever answered. */
  answeredBy: string;
  /** Human-readable answer for the resume TextPart (option label or freeform). */
  humanText: string;
}

/**
 * The caller a system-initiated continuation (a HITL timeout) authorizes as when
 * there is no human answerer. Zero permissions: a timed-out prompt should let a
 * local agent finalize, never perform a privileged write on nobody's behalf.
 */
const SYSTEM_CALLER: UserAuthContext = {
  slackUserId: "gateway",
  displayName: "gateway",
  isPrimaryOwner: false,
  isOrgAdmin: false,
  adminWorkspaces: []
};

/**
 * Whether a parked task was successfully handed back to its agent. `failed`
 * covers every reason the continuation could not be delivered (agent gone, no
 * endpoint, or a non-accept). `detail` carries a gateway-authored sentence when
 * the agent gave an actual A2A verdict, so the notice can say what went wrong
 * instead of guessing "unreachable"; it is absent when there is nothing more
 * specific to report.
 */
type ContinuationOutcome =
  { kind: "resumed" } | { kind: "failed"; detail?: string };

/**
 * Why a continuation could not be handed back, as a gateway-authored sentence,
 * or `undefined` when the generic unreachable notice is the honest answer.
 *
 * `TASK_NOT_FOUND` is meaningful on this path and nowhere else: the agent is
 * reachable and speaking A2A, it has simply forgotten the parked task — which is
 * the opposite of what "looks unreachable" would tell the user.
 */
function continuationFailureDetail(
  agent: Pick<DispatchAgentRef, "name" | "kind" | "tenantId">,
  accept: A2AAccept
): string | undefined {
  if (accept.kind !== "protocol_error") return undefined;
  if (accept.code === A2A_ERROR_CODE.TASK_NOT_FOUND) {
    return `The agent *${agent.name}* no longer has this task.`;
  }
  return protocolErrorText(agent, accept.code);
}

/**
 * Continue a task parked on a human-in-the-loop prompt. Mirrors
 * {@link dispatchToAgent}'s two branches but *continues* an existing task rather
 * than starting one: the message carries the paused `taskId` + `contextId` +
 * `referenceTaskIds` (A2A multi-turn), and the push config reuses the original
 * `token` so continued callbacks land on the same `agent_tasks` row. On a
 * successful accept the row is un-parked (`resumeFromInput`) so the resumed
 * turn's callbacks are honored again and `"resumed"` is returned; any failure
 * returns `"failed"` so the caller can tell the user the task did not continue.
 * Shared by the human-answer path ({@link resumeAgentTask}) and the TTL-timeout
 * path ({@link timeoutAgentTask}); the `messageId` is deterministic so a retried
 * continuation dedupes at the agent.
 */
/**
 * Un-park the task row and wake the ReactionWorkflow, because this is the start
 * of a fresh processing leg and the workflow measures legs with its own timer
 * rather than a stored timestamp — parking only ever *extends* its wait, so this
 * is the one transition it has to be told about. Without the nudge it would sit
 * on the parked wait (the full HITL TTL) instead of the agent's hour.
 */
async function markResumed(token: string): Promise<void> {
  const eventId = await resumeFromInput(token);
  if (eventId) await signalReactionSync(eventId);
}

async function sendTaskContinuation(
  row: HitlRequestRow,
  input: { parts: Message["parts"]; messageId: string; caller: UserAuthContext }
): Promise<ContinuationOutcome> {
  const agent = await getAgent(row.agentName);
  if (!agent) {
    console.error("[hitl] continuation: agent no longer registered", {
      agent: row.agentName,
      requestId: row.requestId
    });
    return { kind: "failed" };
  }
  if (!row.taskId) {
    // A parked task always has a taskId (it was accepted before it could park),
    // so this is defensive — without one there is nothing to continue.
    console.error("[hitl] continuation: request has no taskId", {
      requestId: row.requestId
    });
    return { kind: "failed" };
  }

  const ns = localNamespaceFor(agent);

  if (!ns) {
    // Custom agent → real HTTP, same identity/endpoint checks as dispatch.
    const allowedDomains = await getAllowedRemoteAgentDomains();
    validateRemoteEndpoint(agent.a2aEndpoint, allowedDomains);
    const issuer = await resolveIssuer();
    if (!issuer) {
      console.error("[hitl] continuation: gateway public URL not discovered", {
        requestId: row.requestId
      });
      return { kind: "failed" };
    }
    const ref: DispatchAgentRef = {
      name: agent.name,
      kind: agent.kind,
      a2aEndpoint: agent.a2aEndpoint,
      tenantId: agent.tenantId,
      workspaceId: agent.workspaceId
    };
    const gatewayToken = await signGatekeeperToken({
      audience: audienceFor(agent.a2aEndpoint),
      issuer,
      identity: buildRemoteIdentity(ref),
      tenant: agent.tenantId
    });
    const message = buildMessage({
      messageId: input.messageId,
      role: Role.ROLE_USER,
      taskId: row.taskId,
      contextId: row.contextId,
      referenceTaskIds: [row.taskId],
      parts: input.parts,
      // Typed explicitly: `buildMessage` takes an open metadata bag, so nothing
      // would have caught this drifting from `DispatchMetadata` otherwise.
      metadata: {
        agentKind: "remote",
        tenant: agent.tenantId,
        workspaceId: agent.workspaceId
      } satisfies DispatchMetadata
    });
    const accept = await sendA2ARemote(
      {
        endpoint: agent.a2aEndpoint,
        authToken: gatewayToken,
        tenant: agent.tenantId
      },
      message,
      remotePushNotificationConfig(issuer, row.token)
    );
    if (accept.kind === "accepted") {
      await markResumed(row.token);
      return { kind: "resumed" };
    }
    console.error("[hitl] continuation: remote did not accept", {
      agent: agent.name,
      requestId: row.requestId,
      accept: accept.kind
    });
    return { kind: "failed", detail: continuationFailureDetail(agent, accept) };
  }

  // Local built-in → in-process via DO stub.fetch. The DO instance is
  // reconstructed from the caller/channel — the same keys the message workflow
  // used (admin: the channel's workspace; onboarding: the DM's user).
  let metadata: AgentTurnMetadata;
  if (agent.tenantId === "admin") {
    const workspace = await getWorkspaceByAdminChannel(row.channelId);
    if (!workspace) {
      console.error("[hitl] continuation: admin channel has no workspace", {
        channelId: row.channelId,
        requestId: row.requestId
      });
      return { kind: "failed" };
    }
    metadata = {
      user: input.caller,
      agentKind: "local",
      tenant: "admin",
      adminWorkspaceId: workspace.id
    };
  } else {
    metadata = {
      user: input.caller,
      agentKind: "local",
      tenant: "onboarding"
    };
  }

  const message = buildMessage({
    messageId: input.messageId,
    role: Role.ROLE_USER,
    taskId: row.taskId,
    contextId: row.contextId,
    referenceTaskIds: [row.taskId],
    parts: input.parts,
    metadata: { ...metadata }
  });
  const instanceName = instanceNameFor(metadata);
  const stub = ns.get(ns.idFromName(instanceName));
  const fetchImpl = ((input2: RequestInfo | URL, init?: RequestInit) =>
    stub.fetch(input2 as RequestInfo, init)) as typeof fetch;
  const card = buildAgentCard({
    name: agent.name,
    description: `Local ${agent.kind} agent`,
    pushNotifications: true
  });
  const accept = await sendA2ALocal(
    { card, fetchImpl, tenant: agent.tenantId },
    message,
    localPushNotificationConfig(row.token)
  );
  if (accept.kind === "accepted") {
    await markResumed(row.token);
    return { kind: "resumed" };
  }
  console.error("[hitl] continuation: local agent did not accept", {
    agent: agent.name,
    requestId: row.requestId,
    accept: accept.kind
  });
  return { kind: "failed", detail: continuationFailureDetail(agent, accept) };
}

/**
 * Resume a parked task with a human's answer. The answerer becomes the caller
 * (anyone in the thread may answer), so a resumed local turn authorizes as them.
 * The answer is already recorded and its Slack prompt already shows the answered
 * state; if the handoff fails the answer still stands, so we only post a thread
 * notice that the agent couldn't be reached — the user knows to go fix it.
 */
export async function resumeAgentTask(
  row: HitlRequestRow,
  answer: HitlAnswer
): Promise<void> {
  const caller = await buildUserAuthContext(answer.answeredBy);
  const outcome = await sendTaskContinuation(row, {
    parts: buildHitlResponseParts({
      requestId: row.requestId,
      optionId: answer.optionId,
      text: answer.text,
      answeredBy: answer.answeredBy,
      humanText: answer.humanText
    }),
    messageId: `${row.token}:r:${row.requestId}`,
    caller
  });
  if (outcome.kind === "failed") {
    await notifyHitlContinuationFailed(row, outcome.detail);
  }
}

/**
 * End a parked task whose HITL prompt hit its TTL: send a timeout signal so the
 * agent can finalize gracefully. Authorizes as the zero-permission
 * {@link SYSTEM_CALLER} since no human answered. If the timeout signal can't be
 * delivered (the agent is unreachable), post a thread notice so the user learns
 * the agent is down and can fix it — the expiry note alone wouldn't reveal that.
 */
export async function timeoutAgentTask(row: HitlRequestRow): Promise<void> {
  const outcome = await sendTaskContinuation(row, {
    parts: buildHitlTimeoutParts(row.requestId),
    messageId: `${row.token}:t:${row.requestId}`,
    caller: SYSTEM_CALLER
  });
  if (outcome.kind === "failed") {
    await notifyHitlContinuationFailed(row, outcome.detail);
  }
}

/**
 * Ask an agent to cancel an in-flight task via the standard A2A `tasks/cancel`.
 * Mirrors the remote branch of {@link dispatchToAgent}: SSRF/allowlist validation
 * plus a freshly signed gateway-identity JWT (audience = the endpoint origin),
 * then the cancel call. The response is authoritative — the gateway reconciles
 * from it and expects no push callback afterwards.
 *
 * Local built-ins now run their turn in the background (accept-first), and the
 * gateway stops them via the in-loop `isCancelRequested(token)` poll rather than
 * A2A `tasks/cancel` — so `tasks/cancel` stays a no-op here, reported as
 * `not_cancelable` so the caller still reconciles its ledger row without
 * contacting anything.
 */
export async function cancelAgentTask(
  agent: DispatchAgentRef,
  taskId: string
): Promise<CancelOutcome> {
  if (localNamespaceFor(agent)) {
    return { kind: "not_cancelable" };
  }

  const allowedDomains = await getAllowedRemoteAgentDomains();
  validateRemoteEndpoint(agent.a2aEndpoint, allowedDomains);

  const issuer = await resolveIssuer();
  if (!issuer) {
    throw new Error(
      "Gateway public URL has not been discovered yet; cannot sign a cancel request."
    );
  }
  const gatewayToken = await signGatekeeperToken({
    audience: audienceFor(agent.a2aEndpoint),
    issuer,
    identity: buildRemoteIdentity(agent),
    tenant: agent.tenantId
  });

  return cancelA2ARemote(
    {
      endpoint: agent.a2aEndpoint,
      authToken: gatewayToken,
      tenant: agent.tenantId
    },
    taskId
  );
}
