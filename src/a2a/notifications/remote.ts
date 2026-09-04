import { NOTIFICATION_TOKEN_HEADER } from "@dynamicagents/g2a-protocol";
import { getAgent } from "@/db/models/agents";
import {
  getAgentTaskByToken,
  isTerminalTaskStatus,
  recordAgentTaskError
} from "@/db/models/agent-tasks";
import {
  getPublicUrl,
  getAllowedRemoteAgentDomains
} from "@/db/models/workspace-configs";
import {
  verifyAgentCallbackToken,
  AgentCallbackAuthError
} from "@/auth/agent-inbound";
import { parseStreamResponse, snapshotOf } from "@/a2a/snapshot";
import { deliverTaskToSlack, TaskDeliveryValidationError } from "./shared";

/**
 * Header carrying the per-task validation token set in pushNotificationConfig.
 *
 * From `@dynamicagents/g2a-protocol`, which the remote agent also reads it from —
 * it used to be declared here and again in `@dynamicagents/core`, each pointing a
 * comment at the other. Slightly different from the claim names: the value is
 * `@a2a-js/sdk`'s own default for `tokenHeaderName`, but the SDK never exports
 * it, so neither side could import it and both wrote it down.
 *
 * Re-exported so the rest of the gateway keeps importing it from here.
 */
export { NOTIFICATION_TOKEN_HEADER } from "@dynamicagents/g2a-protocol";

/**
 * The gateway path remote agents POST A2A Task snapshots to.
 *
 * Deliberately **not** in the protocol package. It is not a shared constant at
 * all: the gateway hands each agent the full callback URL in the
 * `taskPushNotificationConfig`, and the agent POSTs to whatever it was given. No
 * remote ever spells this path, so nothing can drift from it.
 */
export const NOTIFICATIONS_PATH = "/a2a/notifications";

const OK = () => new Response("ok", { status: 200 });

/** Record a gateway-controlled callback rejection for the reaction backstop. */
async function captureCallbackError(
  token: string,
  message: string
): Promise<void> {
  try {
    await recordAgentTaskError(token, message);
  } catch (err) {
    console.error("[remote-notifications] failed to record callback error", {
      err: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Handle a remote agent's authenticated push-notification callback. The token
 * and pinned card key are verified here, before shared delivery reads the
 * notification body or posts any agent-controlled output to Slack.
 */
export async function handleRemoteAgentNotification(
  request: Request
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const notificationToken = request.headers.get(NOTIFICATION_TOKEN_HEADER);
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!notificationToken || !bearer) {
    return new Response("missing credentials", { status: 401 });
  }

  const row = await getAgentTaskByToken(notificationToken);
  if (!row) return new Response("unknown task", { status: 404 });
  if (isTerminalTaskStatus(row.status)) {
    // The task is over: delivered already, or stopped by a 🛑 or by its processing
    // deadline. Either way this reply is discarded rather than posted. A 200 (not
    // an error) is deliberate — it retires the remote's retry ladder instead of
    // inviting it to keep hammering a decision that will not change.
    console.log("[notifications] dropping callback for a finished task", {
      agent: row.agentName,
      taskId: row.taskId,
      status: row.status
    });
    return OK();
  }

  const agent = await getAgent(row.agentName);
  if (!agent) {
    await captureCallbackError(
      notificationToken,
      "the agent's registration could not be found, so its callback could not be verified"
    );
    return new Response("agent not verifiable", { status: 401 });
  }
  // Only custom (remote) agents are reachable through this public callback.
  // Built-in agents deliver in-process via the trusted local sender and never
  // hold a card signing key, so a token that maps to one here is illegitimate —
  // reject it explicitly rather than leaning on the missing-key check below.
  if (agent.kind !== "remote") {
    console.error("[remote-notifications] built-in agent token on callback", {
      agent: row.agentName,
      kind: agent.kind
    });
    await captureCallbackError(
      notificationToken,
      "this task is delivered internally and cannot be completed through the public callback"
    );
    return new Response("not a remote agent", { status: 401 });
  }
  if (!agent.cardSigningJku || !agent.cardSigningKid) {
    console.error("[remote-notifications] agent missing or unsigned", {
      agent: row.agentName
    });
    await captureCallbackError(
      notificationToken,
      "the agent's registration is missing its card signing key, so its callback could not be verified"
    );
    return new Response("agent not verifiable", { status: 401 });
  }

  const issuer = await getPublicUrl();
  const audience = `${issuer ?? new URL(request.url).origin}${NOTIFICATIONS_PATH}`;
  const allowedDomains = await getAllowedRemoteAgentDomains();

  try {
    await verifyAgentCallbackToken({
      token: bearer,
      pin: {
        cardSigningJku: agent.cardSigningJku,
        cardSigningKid: agent.cardSigningKid
      },
      audience,
      allowedDomains
    });
  } catch (err) {
    if (err instanceof AgentCallbackAuthError) {
      console.warn("[remote-notifications] callback auth rejected", {
        agent: row.agentName,
        err: err.message
      });
      await captureCallbackError(
        notificationToken,
        `the callback signature could not be verified (${err.message})`
      );
      return new Response("invalid callback token", { status: 401 });
    }
    throw err;
  }

  // A2A v1.0 push notifications carry the protobuf-JSON of a `StreamResponse`
  // (the same envelope the streaming transports use), not the bare `Task` v0.3
  // POSTed. Parse it through the generated decoder so enum names and part
  // shapes are normalized, then flatten to the gateway's task view — an
  // envelope that advances no task lifecycle (an artifact delta, or a
  // stand-alone message) carries nothing this callback can deliver.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const streamResponse = parseStreamResponse(body);
  const snapshot = streamResponse ? snapshotOf(streamResponse) : null;
  if (!snapshot) {
    await captureCallbackError(
      notificationToken,
      "the callback body was not a valid A2A task notification"
    );
    return new Response("expected a Task or status-update notification", {
      status: 400
    });
  }

  try {
    await deliverTaskToSlack(notificationToken, row, agent, snapshot);
  } catch (err) {
    if (err instanceof TaskDeliveryValidationError) {
      await captureCallbackError(notificationToken, err.message);
      return new Response(
        "non-terminal task updates require a status.message.messageId for deduplication",
        { status: 400 }
      );
    }
    throw err;
  }
  return OK();
}
