import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  type Client
} from "@a2a-js/sdk/client";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import type {
  AgentCard,
  Message,
  SendMessageRequest,
  Task,
  TaskPushNotificationConfig
} from "@a2a-js/sdk";
import { buildAgentCard } from "@/a2a/card";
import { isMessageResult } from "@/a2a/parts";
import { classifyA2AError, isPermanentProtocolError } from "@/a2a/errors";
import { sanitizeSlackText } from "@/util/slack-text";

/**
 * Where to send an A2A message:
 * - `local`  — a known card + a `fetchImpl` bound to a Durable Object `stub.fetch`,
 *   so card discovery is skipped and the call runs in-process (no network hop).
 *   Local agents return a Task acceptance and deliver replies through a trusted
 *   in-process push sender.
 * - `remote` — a base URL; the card is discovered over real HTTP, every request
 *   carries the gatekeeper identity JWT (`authToken`). Remote agents reply
 *   *asynchronously* via push notification — {@link sendA2ARemote} only waits
 *   for the accept (a Task ack), never for generation.
 */
export interface A2ALocalTarget {
  card: AgentCard;
  fetchImpl: typeof fetch;
  /**
   * Which agent this is. Local dispatch resolves the Durable Object namespace
   * before getting here, so nothing routes on it — it travels so the request on
   * the wire is the same shape either path builds, and so a built-in that
   * later moves out of process needs no change at the call site.
   */
  tenant: string;
}
export interface A2ARemoteTarget {
  endpoint: string;
  authToken?: string;
  /**
   * Which agent at `endpoint` to address — the remote refuses a request that
   * names none, since one endpoint may serve several and none is the default.
   */
  tenant: string;
}

/**
 * Abort a remote *accept* that hangs. This only covers the initial handshake
 * (the remote must return a `submitted`/`working` Task immediately, A2A §7.2), not
 * generation — so it can be short. The reply itself arrives later via the
 * push-notification callback, so no gatekeeper request ever blocks on the model.
 */
const ACCEPT_TIMEOUT_MS = 30_000;

/** Hard cap on an agent reply before it reaches Slack (untrusted output). */
const MAX_REPLY_CHARS = 16_000;

/**
 * Build a `fetchImpl` for a remote target: injects the gatekeeper JWT as a Bearer
 * token on every request and enforces the short accept timeout. Reuses the same
 * `fetchImpl` override seam the local (DO stub) path uses.
 */
function remoteFetchImpl(authToken?: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (authToken) headers.set("authorization", `Bearer ${authToken}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACCEPT_TIMEOUT_MS);
    try {
      return await fetch(input as RequestInfo, {
        ...init,
        headers,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

/**
 * Sanitize an agent reply before it reaches Slack: {@link sanitizeSlackText}
 * (strip control characters, neutralize channel-wide mentions in both spellings so
 * a hostile agent can't notify everyone) plus a length cap so it can't flood Slack.
 * Applied at every delivery boundary — the remote push-notification callback and
 * the local in-process sender alike — because even a built-in agent relays
 * untrusted model output.
 */
export function sanitizeAgentReply(text: string): string {
  const safe = sanitizeSlackText(text);
  return safe.length > MAX_REPLY_CHARS
    ? `${safe.slice(0, MAX_REPLY_CHARS)}…`
    : safe;
}

/** Build a local A2A client using an in-process Durable Object fetch impl. */
async function buildLocalClient(target: A2ALocalTarget): Promise<Client> {
  const options = ClientFactoryOptions.createFrom(
    ClientFactoryOptions.default,
    {
      transports: [new JsonRpcTransportFactory({ fetchImpl: target.fetchImpl })]
    }
  );
  const factory = new ClientFactory(options);
  return factory.createFromAgentCard(target.card);
}

/**
 * Build a remote A2A client that talks to the endpoint we already resolved.
 *
 * Built `createFromAgentCard` over a locally-synthesized card — the same shape
 * {@link buildLocalClient} uses — rather than `createFromUrl`, which would
 * re-download the agent's card on **every send** and POST to whatever that live
 * document happens to advertise. Three things were wrong with that:
 *
 *  - The audience is computed from the stored endpoint while the request went to
 *    the card's URL, so the two silently disagreed for any agent whose card did
 *    not advertise the exact path an admin had typed. That is a 401 on every
 *    dispatch, from a mismatch nothing surfaced.
 *  - `validateRemoteEndpoint` ran against the stored value, not the URL actually
 *    dialed, so the SSRF policy guarded a string we were no longer using.
 *  - The card was re-fetched unverified, so the signing key pinned at
 *    registration constrained registration and nothing else.
 *
 * `verifyRemoteAgentEndpoint` resolves the endpoint from the signed card once,
 * at registration, and it is stored. Using it verbatim here makes the POST
 * target, the stored row and the `aud` one value, and costs one fewer network
 * round trip per turn.
 */
async function buildRemoteClient(target: A2ARemoteTarget): Promise<Client> {
  const options = ClientFactoryOptions.createFrom(
    ClientFactoryOptions.default,
    {
      transports: [
        new JsonRpcTransportFactory({
          fetchImpl: remoteFetchImpl(target.authToken)
        })
      ]
    }
  );
  const factory = new ClientFactory(options);
  return factory.createFromAgentCard(
    buildAgentCard({
      name: "Remote",
      description: "remote agent at its registered endpoint",
      url: target.endpoint,
      tenant: target.tenant,
      pushNotifications: true
    })
  );
}

/**
 * Send one A2A message to a **local** (in-process) agent. The request asks to
 * return immediately, so the SDK answers as soon as the agent accepts the turn
 * rather than awaiting generation — the same accept-only shape
 * {@link sendA2ARemote} has, just in-process without the HTTP/JWT hop. Generation and the Slack delivery run
 * asynchronously inside the agent DO, which keeps itself alive until the terminal
 * delivery settles via a `ctx.waitUntil` liveness barrier. The caller only forwards
 * the task id for correlation and never handles model text directly.
 */
export async function sendA2ALocal(
  target: A2ALocalTarget,
  message: Message,
  taskPushNotificationConfig: TaskPushNotificationConfig
): Promise<A2AAccept> {
  const client = await buildLocalClient(target);
  return acceptOrProtocolError(
    () =>
      client.sendMessage(
        sendRequest(message, taskPushNotificationConfig, target.tenant)
      ),
    message
  );
}

/**
 * Build the v1.0 `SendMessageRequest` both dispatch paths share.
 *
 * `returnImmediately: true` is v1.0's replacement for v0.3's `blocking: false`
 * (the semantics are inverted): the agent must answer as soon as it has
 * accepted the turn — the initial `submitted` Task, carrying the real
 * SDK-assigned task id — instead of holding the request open until generation
 * finishes. The reply arrives later on the push-notification callback, so no
 * gatekeeper request ever blocks on a model.
 *
 * `tenant` names which agent at the endpoint the turn is for. A host may serve
 * several over one endpoint, so the endpoint alone does not identify one, and
 * spec §8.3.2 requires the value the selected interface declared — which is
 * what registration recorded on the agent row.
 */
function sendRequest(
  message: Message,
  taskPushNotificationConfig: TaskPushNotificationConfig,
  tenant: string
): SendMessageRequest {
  return {
    tenant,
    message,
    configuration: {
      acceptedOutputModes: ["text/plain"],
      taskPushNotificationConfig,
      historyLength: undefined,
      returnImmediately: true
    },
    metadata: undefined
  };
}

/** Result of accepting a message onto an A2A agent's task queue. */
export type A2AAccept =
  | {
      /** Remote accepted the turn and returned its Task id. */
      kind: "accepted";
      taskId: string;
    }
  | {
      /** Remote omitted the required async Task acceptance/id. */
      kind: "contract_violation";
    }
  | {
      /**
       * The agent answered with a deterministic A2A protocol refusal — a
       * JSON-RPC error envelope with any code but `INTERNAL_ERROR`. Retrying is
       * pointless (see {@link isPermanentProtocolError}), so this is returned
       * rather than thrown: the caller turns it into a specific user-facing
       * notice instead of letting a workflow step retry into a generic
       * "unreachable".
       */
      kind: "protocol_error";
      code: number;
      reason: string;
    };

/**
 * Run one `sendMessage` and fold a permanent protocol refusal into the
 * {@link A2AAccept} union. Transport faults and `INTERNAL_ERROR` rethrow
 * unchanged so the caller's retry path is untouched.
 *
 * Only the send itself is wrapped — client construction (card discovery over
 * HTTP for a remote) stays outside, since a discovery failure is a transport
 * fault that must remain retryable.
 */
async function acceptOrProtocolError(
  send: () => Promise<Awaited<ReturnType<Client["sendMessage"]>>>,
  message: Message
): Promise<A2AAccept> {
  try {
    return acceptedTask(await send(), message);
  } catch (err) {
    const info = classifyA2AError(err);
    if (info.kind === "protocol" && isPermanentProtocolError(info.code)) {
      console.error("[a2a] agent refused the request with an A2A error", {
        contextId: message.contextId,
        code: info.code,
        reason: info.reason,
        message: info.message
      });
      return { kind: "protocol_error", code: info.code, reason: info.reason };
    }
    // Rethrow the *original* error object, not a wrapper: the unreachable notice
    // surfaces `err.message` to the user and the stack is what makes a transport
    // fault diagnosable in logs.
    throw err;
  }
}

function acceptedTask(
  result: Awaited<ReturnType<Client["sendMessage"]>>,
  message: Message
): A2AAccept {
  if (!isMessageResult(result) && result.id.trim().length > 0) {
    return { kind: "accepted", taskId: result.id };
  }
  console.error(
    "[a2a] agent accept response missing required Task acceptance " +
      "(submitted/working Task with non-empty id); push-notification contract " +
      "not honored",
    { contextId: message.contextId }
  );
  return { kind: "contract_violation" };
}

/**
 * Send one A2A message to a **remote** agent for asynchronous processing. The
 * gatekeeper supplies a `pushNotificationConfig` (webhook URL + validation token);
 * the remote MUST return immediately with a `submitted`/`working` Task and later
 * POST the terminal Task back to the webhook. We only wait for — and return — the
 * accept, never the generation. If the remote response does not contain the
 * required Task acceptance (including a non-empty Task id), we log and return a
 * contract-violation outcome for the caller to surface.
 */
export async function sendA2ARemote(
  target: A2ARemoteTarget,
  message: Message,
  taskPushNotificationConfig: TaskPushNotificationConfig
): Promise<A2AAccept> {
  const client = await buildRemoteClient(target);
  return acceptOrProtocolError(
    () =>
      client.sendMessage(
        sendRequest(message, taskPushNotificationConfig, target.tenant)
      ),
    message
  );
}

/**
 * Outcome of asking a remote agent to cancel a task (A2A `tasks/cancel`).
 * Cancellation is *attempted*, not guaranteed (A2A §7.5): the terminal outcomes
 * below all mean "stop trying" from the gatekeeper's side.
 * - `canceled`      — the agent transitioned the task to a terminal `canceled`.
 * - `not_cancelable`— the task was already terminal (e.g. it just completed);
 *                     `TaskNotCancelableError` (-32002). Idempotent no-op.
 * - `not_found`     — the agent has no such task (-32001). Idempotent no-op.
 * - `unsupported`   — the agent doesn't implement cancellation (-32004); the task
 *                     keeps running and the gatekeeper should say so.
 * - `error`         — transport/other failure; the caller may surface or retry.
 */
export type CancelOutcome =
  | { kind: "canceled"; task: Task }
  | { kind: "not_cancelable" }
  | { kind: "not_found" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

/**
 * Ask a **remote** agent to cancel a task via the standard A2A `tasks/cancel`
 * method. Synchronous by contract — the agent returns the updated Task
 * immediately — so the gatekeeper self-reconciles from this response and does NOT
 * wait for a push callback (a conformant agent sends none after cancellation).
 * The SDK maps A2A error codes to typed errors, which we fold into a
 * {@link CancelOutcome} the caller can act on without touching the SDK surface.
 */
export async function cancelA2ARemote(
  target: A2ARemoteTarget,
  taskId: string
): Promise<CancelOutcome> {
  const client = await buildRemoteClient(target);
  try {
    const task = await client.cancelTask({
      tenant: target.tenant,
      id: taskId,
      metadata: undefined
    });
    return { kind: "canceled", task };
  } catch (err) {
    const info = classifyA2AError(err);
    if (info.kind === "protocol") {
      switch (info.code) {
        case A2A_ERROR_CODE.TASK_NOT_CANCELABLE:
          return { kind: "not_cancelable" };
        case A2A_ERROR_CODE.TASK_NOT_FOUND:
          return { kind: "not_found" };
        case A2A_ERROR_CODE.UNSUPPORTED_OPERATION:
          return { kind: "unsupported" };
      }
    }
    // Every other code falls through to `error` on purpose: only the three
    // outcomes above mean the agent will send no further callback, so only they
    // may complete the ledger row (see `cancelAndReconcile`). On anything else
    // the task may still be running and its callback must still route to Slack.
    return { kind: "error", message: info.message };
  }
}
