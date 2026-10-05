import {
  Role,
  type Message,
  type TaskPushNotificationConfig
} from "@a2a-js/sdk";
import type { UserAuthContext } from "@/auth";
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
import {
  buildHitlResponseParts,
  buildHitlTimeoutParts,
  type HitlAnswerChoice
} from "@/a2a/hitl";
import { buildMessage, textPart } from "@/a2a/parts";
import { NOTIFICATIONS_PATH } from "@/a2a/notifications/remote";
import { notifyHitlContinuationFailed } from "@/a2a/notifications/hitl";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import {
  sendA2ARemote,
  cancelA2ARemote,
  type A2AAccept,
  type A2ARemoteTarget,
  type CancelOutcome
} from "@/a2a/client";
import { audienceFor, validateRemoteEndpoint } from "@/a2a/endpoint";
import {
  getAllowedRemoteAgentDomains,
  getPublicUrl
} from "@/db/models/workspace-configs";
import { renderTurn, turnContextFromPayload } from "@/a2a/turn";
import { isDmChannel } from "@/router/resolve";
import {
  adminIdentity,
  onboardingIdentity,
  type BuiltinTenant
} from "@/agents/identity";
import { agentsWorker, builtinEndpoint } from "@/agents/worker";

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
 * The routing facts that ride on the A2A `message.metadata`. Who/where/when is
 * carried in the turn *text* (the gatekeeper-applied `<turn>` wrapper), and no
 * permission context ever crosses: the signed token is the only authority.
 *
 * Both facts travel, mirroring the registry: `agentKind` is *where* the agent
 * runs, `tenant` is *which* agent it is. Carrying only the tenant would not
 * narrow — the remote arm's tenant is an open string, so it overlaps the
 * built-in literals and TypeScript could not tell the members apart.
 */
export type DispatchMetadata =
  | { agentKind: "local"; tenant: BuiltinTenant }
  | { agentKind: "remote"; tenant: string; workspaceId: number };

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
  /**
   * The person who wrote the turn — ALWAYS present (the classifier boundary
   * guarantees it). Only their name and id cross, inside the `<turn>` wrapper.
   */
  user: UserAuthContext;
  /** The wire metadata. */
  metadata: DispatchMetadata;
}

/**
 * Isolate-level memo of the gatekeeper's public origin (the JWT `iss` + `jku` host).
 * Written to D1 by the fetch isolate on first verified Slack request; the Workflow
 * isolate reads it once here and caches it for its lifetime. Resets on cold start
 * (redeploy / domain change), so a changed origin is picked up by the new isolate.
 */
let cachedIssuer: string | null = null;

/** Reset the isolate-level issuer cache. Only for test isolation. */
export function _resetIssuerCacheForTest(): void {
  cachedIssuer = null;
}

/** Read (and memoize) the gatekeeper issuer origin from D1. */
async function resolveIssuer(): Promise<string | null> {
  if (cachedIssuer !== null) return cachedIssuer;
  const issuer = await getPublicUrl();
  if (issuer) cachedIssuer = issuer;
  return issuer;
}

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

/** Canonical signed identity of the gatekeeper-agent instance calling remotely. */
function buildRemoteIdentity(
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
function buildRemoteContextId(
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
 * Whether an agent is one of this Worker's own core tenants.
 *
 * Two decisions, deliberately kept on two different fields:
 *
 *  - **`kind` decides built-in vs remote.** It is set by the gatekeeper when the
 *    row is created and no admin can choose it.
 *  - **`tenantId` decides which built-in**, the same field that picks which
 *    agent at a remote endpoint, so one column means "which agent" on both
 *    paths.
 *
 * The `kind` guard has to come first and has to stay on `kind`. Routing off
 * `tenantId` alone would let a **remote agent registered with `tenantId:
 * "admin"` be dispatched into this gatekeeper's own admin** — privilege
 * escalation through a field an admin types. `dispatch.spec.ts` asserts that
 * directly, and the mounted tenants refuse any identity but a built-in's on
 * top of it (`src/agents/worker.ts`).
 */
function isBuiltin(agent: Pick<AgentRow, "kind">): boolean {
  return agent.kind === "local";
}

/**
 * The identity a built-in is dispatched as, derived from the channel the turn
 * is in — so a continuation or a cancel, which know the channel and nothing
 * about the person, reach the same instance the dispatch did. Null when the
 * channel no longer names one: an admin channel since reassigned, or a
 * non-DM handed to onboarding.
 */
async function builtinIdentity(
  agent: Pick<DispatchAgentRef, "tenantId" | "workspaceId">,
  channelId: string
): Promise<RemoteIdentity | null> {
  switch (agent.tenantId) {
    case "admin": {
      const workspace = await getWorkspaceByAdminChannel(channelId);
      return workspace ? adminIdentity(workspace.id) : null;
    }
    case "onboarding":
      return isDmChannel(channelId)
        ? onboardingIdentity(channelId, agent.workspaceId)
        : null;
    default:
      return null;
  }
}

/** The gatekeeper's public origin, which every token and callback is minted against. */
async function requireIssuer(): Promise<string> {
  const issuer = await resolveIssuer();
  if (!issuer) {
    throw new Error(
      "Gatekeeper public URL has not been discovered yet. " +
        "Ensure the worker has received at least one Slack event before dispatching to agents."
    );
  }
  return issuer;
}

/**
 * Where, and as whom, a call to an agent goes — one path for every agent.
 *
 * A remote agent is dialed over HTTPS at its registered endpoint, after the
 * SSRF and approved-domain checks. A built-in is a core tenant on this Worker:
 * its endpoint is derived rather than stored, the domain policy does not apply
 * to our own origin, and the request is handed to the mounted A2A handler
 * in-process instead of leaving the isolate. Everything else — the signed
 * token, the tenant, the push callback — is the same on both.
 */
async function targetFor(
  agent: DispatchAgentRef,
  identity: RemoteIdentity,
  acceptTimeoutMs?: number
): Promise<{ target: A2ARemoteTarget; issuer: string }> {
  // A refused endpoint is a verdict, not a missing precondition, so it is
  // checked before anything else can fail.
  if (!isBuiltin(agent)) {
    const allowedDomains = await getAllowedRemoteAgentDomains();
    validateRemoteEndpoint(agent.a2aEndpoint, allowedDomains); // SSRF + approved-domain defense-in-depth
  }
  const issuer = await requireIssuer();
  let endpoint = agent.a2aEndpoint;
  let transport: typeof fetch | undefined;
  if (isBuiltin(agent)) {
    endpoint = builtinEndpoint(issuer);
    transport = ((input: RequestInfo | URL, init?: RequestInit) =>
      agentsWorker(new Request(input, init), env)) as typeof fetch;
  }
  const authToken = await signGatekeeperToken({
    audience: audienceFor(endpoint),
    issuer,
    identity,
    tenant: agent.tenantId
  });
  return {
    target: {
      endpoint,
      authToken,
      tenant: agent.tenantId,
      acceptTimeoutMs,
      transport
    },
    issuer
  };
}

/** The identity an agent is called as, or null for a built-in whose channel names none. */
async function identityFor(
  agent: DispatchAgentRef,
  channelId: string
): Promise<RemoteIdentity | null> {
  return isBuiltin(agent)
    ? builtinIdentity(agent, channelId)
    : buildRemoteIdentity(agent);
}

/**
 * The push-notification config handed to a remote agent: the gatekeeper's public
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
 * reply later to the authenticated push callback. The workflow receives the shared
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
 * fault it is. A built-in's refusal comes from this Worker's own core tenants,
 * so "contact the agent developer" would be wrong.
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
      reason = `${who} doesn't support the message-send operation the gatekeeper uses.`;
      break;
    case A2A_ERROR_CODE.PUSH_NOTIFICATION_NOT_SUPPORTED:
      // Not a "try again later": the gatekeeper is push-only by construction, so
      // this agent cannot deliver a reply through it at all.
      reason =
        `${who} doesn't support push notifications, which the gatekeeper ` +
        `requires to deliver replies — it can't be used with the gatekeeper.`;
      break;
    case A2A_ERROR_CODE.CONTENT_TYPE_NOT_SUPPORTED:
      reason = `${who} doesn't accept plain-text messages.`;
      break;
    case A2A_ERROR_CODE.EXTENSION_SUPPORT_REQUIRED:
      reason = `${who} requires an A2A extension the gatekeeper doesn't implement.`;
      break;
    default:
      reason = `${who} rejected the request (A2A error ${code}).`;
  }
  return isBuiltin(agent)
    ? `${reason} This is a gatekeeper bug — please check the error logs.`
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
        text: isBuiltin(agent)
          ? "Built-in agent did not provide the required task acknowledgment."
          : "Remote agent did not provide the required task acknowledgment."
      };
  }
}

/**
 * Dispatch a user message to an agent over A2A. Every agent — remote, or one of
 * the built-in core tenants on this Worker — is called the same way (see
 * {@link targetFor}): a signed token, an accept-first `SendMessage`, and a
 * reply delivered later to the push callback.
 */
export async function dispatchToAgent(
  agent: DispatchAgentRef,
  payload: DispatchPayload
): Promise<DispatchResult> {
  // Deterministic per-dispatch id → the A2A `messageId` (dedupe key) and the
  // push `token`. Stable across retries so re-delivery is idempotent.
  const dispatchId = await buildDispatchId(payload.eventId, agent);

  // The gatekeeper owns provenance: who/where/when is inlined into the turn
  // text via the `<turn>` wrapper, once, identically for every agent.
  const text = renderTurn(payload.text, turnContextFromPayload(payload));

  const identity = await identityFor(agent, payload.channelId);
  if (!identity) {
    throw new Error(
      `BUG: built-in ${agent.tenantId} resolved for a channel that names no instance of it`
    );
  }
  const { target, issuer } = await targetFor(agent, identity);

  const message = buildMessage({
    // Deterministic id so a retried dispatch is dedupable by the agent rather
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
    // gatekeeper-agent instance, not any Slack user.
    metadata: { ...payload.metadata }
  });

  // Push-notification validation token = the same deterministic dispatch id. The
  // agent echoes it on the callback so the gatekeeper correlates it to the pending
  // task (A2A §13.2); the webhook still verifies the agent's signature against
  // its pinned card key (that JWT is the real authenticator — this token is the
  // correlation/dedupe key, stable across retries so they collapse to one row).
  const accept = await sendA2ARemote(
    target,
    message,
    remotePushNotificationConfig(issuer, dispatchId)
  );
  return dispatchResultFor(accept, agent, dispatchId);
}

/**
 * A human's answer to a HITL prompt, as captured from Slack.
 *
 * The picked option and the typed text come from {@link HitlAnswerChoice}, which
 * requires at least one of them — an answer with neither is a resume the agent
 * cannot act on, and the type is the cheapest place to refuse it.
 */
export type HitlAnswer = HitlAnswerChoice & {
  /** Slack user id of whoever answered. */
  answeredBy: string;
  /** Human-readable answer for the resume TextPart (option label or freeform). */
  humanText: string;
};

/**
 * Whether a parked task was successfully handed back to its agent. `failed`
 * covers every reason the continuation could not be delivered (agent gone, no
 * endpoint, or a non-accept). `detail` carries a gatekeeper-authored sentence when
 * the agent gave an actual A2A verdict, so the notice can say what went wrong
 * instead of guessing "unreachable"; it is absent when there is nothing more
 * specific to report.
 */
type ContinuationOutcome =
  { kind: "resumed" } | { kind: "failed"; detail?: string };

/**
 * Why a continuation could not be handed back, as a gatekeeper-authored sentence,
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

/**
 * Continue a task parked on a human-in-the-loop prompt. Calls the agent the way
 * {@link dispatchToAgent} does but *continues* an existing task rather than
 * starting one: the message carries the paused `taskId` + `contextId` +
 * `referenceTaskIds` (A2A multi-turn), and the push config reuses the original
 * `token` so continued callbacks land on the same `agent_tasks` row. On a
 * successful accept the row is un-parked (`resumeFromInput`) so the resumed
 * turn's callbacks are honored again and `"resumed"` is returned; any failure
 * returns `"failed"` so the caller can tell the user the task did not continue.
 * Shared by the human-answer path ({@link resumeAgentTask}) and the TTL-timeout
 * path ({@link timeoutAgentTask}); the `messageId` is deterministic so a retried
 * continuation dedupes at the agent.
 */
async function sendTaskContinuation(
  row: HitlRequestRow,
  input: {
    parts: Message["parts"];
    messageId: string;
    /** An agent's accept timeout; see `A2ARemoteTarget.acceptTimeoutMs`. */
    acceptTimeoutMs?: number;
  }
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

  const ref: DispatchAgentRef = {
    name: agent.name,
    kind: agent.kind,
    a2aEndpoint: agent.a2aEndpoint,
    tenantId: agent.tenantId,
    workspaceId: agent.workspaceId
  };
  const identity = await identityFor(ref, row.channelId);
  if (!identity) {
    console.error("[hitl] continuation: channel names no instance", {
      agent: agent.name,
      channelId: row.channelId,
      requestId: row.requestId
    });
    return { kind: "failed" };
  }
  const { target, issuer } = await targetFor(
    ref,
    identity,
    input.acceptTimeoutMs
  );
  const message = buildMessage({
    messageId: input.messageId,
    role: Role.ROLE_USER,
    taskId: row.taskId,
    contextId: row.contextId,
    referenceTaskIds: [row.taskId],
    parts: input.parts,
    // Typed explicitly: `buildMessage` takes an open metadata bag, so nothing
    // would have caught this drifting from `DispatchMetadata` otherwise.
    metadata: (isBuiltin(agent)
      ? { agentKind: "local", tenant: agent.tenantId as BuiltinTenant }
      : {
          agentKind: "remote",
          tenant: agent.tenantId,
          workspaceId: agent.workspaceId
        }) satisfies DispatchMetadata
  });
  const accept = await sendA2ARemote(
    target,
    message,
    remotePushNotificationConfig(issuer, row.token)
  );
  if (accept.kind === "accepted") {
    await markResumed(row.token);
    return { kind: "resumed" };
  }
  console.error("[hitl] continuation: agent did not accept", {
    agent: agent.name,
    requestId: row.requestId,
    accept: accept.kind
  });
  return { kind: "failed", detail: continuationFailureDetail(agent, accept) };
}

/**
 * The pauses before the second and third attempt to hand an answer back.
 *
 * The whole ladder runs inside the Slack interaction's `ctx.waitUntil`, which the
 * runtime cancels 30 seconds after the ack — and whatever runs after the last
 * attempt (re-opening the prompt) has to fit in that too, or the answer is lost
 * exactly as it was before there were retries. With
 * {@link RESUME_ACCEPT_TIMEOUT_MS} per attempt the worst case is 5 + 2 + 5 + 5 + 5
 * = 22 seconds.
 */
const RESUME_RETRY_DELAYS_MS = [2_000, 5_000] as const;

/**
 * An agent's accept timeout on an answer. Accepting one is recording it and
 * waking the parked run, not generating, so this can be a sixth of a dispatch's —
 * and has to be, for three attempts to fit {@link RESUME_RETRY_DELAYS_MS}' budget.
 */
const RESUME_ACCEPT_TIMEOUT_MS = 5_000;

/**
 * How handing a human's answer back to its task ended.
 *
 * - `resumed` — the agent accepted it.
 * - `refused` — the agent gave a verdict retrying cannot change (or there is no
 *   agent or task to send it to). The thread has been told; the answer stands.
 * - `undelivered` — every attempt failed without a verdict (network, timeout,
 *   5xx, `INTERNAL_ERROR`). Nothing has been told; the caller decides whether
 *   the question can be asked again.
 */
export type ResumeOutcome = "resumed" | "refused" | "undelivered";

/**
 * Resume a parked task with a human's answer. Anyone in the thread may answer:
 * being in the channel is the permission, for an answer as for a request.
 *
 * A failure that could be transient is retried after each of
 * {@link RESUME_RETRY_DELAYS_MS}. That is safe because the `messageId` is the same
 * on every attempt and the agent takes the first answer to a question, so a
 * retry after an accept whose response was lost gets the task back and changes
 * nothing. A refusal is not retried: the same request earns the same verdict.
 */
export async function resumeAgentTask(
  row: HitlRequestRow,
  answer: HitlAnswer
): Promise<ResumeOutcome> {
  // Spread, not a field-by-field rebuild: listing `optionId` and `text`
  // separately widens both back to `string | undefined` and loses the
  // guarantee that one of them is present.
  const parts = buildHitlResponseParts({ ...answer, requestId: row.requestId });
  const messageId = `${row.token}:r:${row.requestId}`;

  for (let attempt = 1; ; attempt++) {
    let outcome: ContinuationOutcome;
    try {
      outcome = await sendTaskContinuation(row, {
        parts,
        messageId,
        acceptTimeoutMs: RESUME_ACCEPT_TIMEOUT_MS
      });
    } catch (err) {
      const delay: number | undefined = RESUME_RETRY_DELAYS_MS[attempt - 1];
      console.error("[hitl] continuation attempt failed", {
        requestId: row.requestId,
        attempt,
        lastAttempt: delay === undefined,
        err: err instanceof Error ? err.message : String(err)
      });
      if (delay === undefined) return "undelivered";
      await scheduler.wait(delay);
      continue;
    }

    if (outcome.kind === "resumed") return "resumed";
    await notifyHitlContinuationFailed(row, outcome.detail);
    return "refused";
  }
}

/**
 * End a parked task whose HITL prompt hit its TTL: send a timeout signal so the
 * agent can finalize gracefully. If the timeout signal can't be
 * delivered (the agent is unreachable), post a thread notice so the user learns
 * the agent is down and can fix it — the expiry note alone wouldn't reveal that.
 */
export async function timeoutAgentTask(row: HitlRequestRow): Promise<void> {
  const outcome = await sendTaskContinuation(row, {
    parts: buildHitlTimeoutParts(row.requestId),
    messageId: `${row.token}:t:${row.requestId}`
  });
  if (outcome.kind === "failed") {
    await notifyHitlContinuationFailed(row, outcome.detail);
  }
}

/**
 * Ask an agent to cancel an in-flight task via the standard A2A `tasks/cancel`,
 * called the way {@link dispatchToAgent} calls it (see {@link targetFor}). The
 * response is authoritative — the gatekeeper reconciles from it and expects no
 * push callback afterwards.
 *
 * `channelId` is the channel the task was dispatched in, which is what names a
 * built-in's instance. A built-in really stops: core terminates the task's
 * workflow and aborts the turn in flight.
 */
export async function cancelAgentTask(
  agent: DispatchAgentRef,
  taskId: string,
  channelId: string
): Promise<CancelOutcome> {
  const identity = await identityFor(agent, channelId);
  if (!identity) {
    return {
      kind: "error",
      message: `no ${agent.tenantId} instance for channel ${channelId}`
    };
  }
  const { target } = await targetFor(agent, identity);
  return cancelA2ARemote(target, taskId);
}
