import {
  StreamResponse,
  type Artifact,
  type Message,
  type TaskState
} from "@a2a-js/sdk";
import { partsText } from "@/a2a/parts";

/**
 * The gatekeeper's normalized view of "where a task stands right now".
 *
 * In A2A v1.0 a push notification carries a {@link StreamResponse} — the same
 * envelope the streaming transports use — rather than the full `Task` snapshot
 * v0.3 delivered. That envelope has four shapes: a whole `Task`, a
 * `TaskStatusUpdateEvent` delta, a `TaskArtifactUpdateEvent` delta, or a
 * stand-alone `Message`. The first two are the only ones that advance a task's
 * lifecycle, and both carry everything the Slack delivery boundary needs, so
 * they are flattened into the shape below and every downstream consumer works
 * off it instead of branching on the envelope.
 *
 * Artifact updates and stand-alone messages produce no snapshot: the gatekeeper
 * delivers replies from the status message, and a message with no task
 * association can't be correlated to a pending `agent_tasks` row.
 */
export interface TaskSnapshot {
  taskId: string;
  contextId: string;
  state: TaskState;
  /** The agent's message for this state, when it published one. */
  statusMessage?: Message;
  /** Only populated by whole-`Task` payloads; deltas carry no artifacts. */
  artifacts: Artifact[];
}

/**
 * Flatten a push-notification / stream envelope into a {@link TaskSnapshot},
 * or `null` when it carries no task lifecycle state (artifact deltas,
 * stand-alone messages, or a task payload with no status).
 */
export function snapshotOf(response: StreamResponse): TaskSnapshot | null {
  const payload = response.payload;
  if (!payload) return null;

  switch (payload.$case) {
    case "task": {
      const task = payload.value;
      if (!task.status) return null;
      return {
        taskId: task.id,
        contextId: task.contextId,
        state: task.status.state,
        statusMessage: task.status.message,
        artifacts: task.artifacts ?? []
      };
    }
    case "statusUpdate": {
      const update = payload.value;
      if (!update.status) return null;
      return {
        taskId: update.taskId,
        contextId: update.contextId,
        state: update.status.state,
        statusMessage: update.status.message,
        artifacts: []
      };
    }
    default:
      return null;
  }
}

/**
 * Parse an untrusted push-notification body into a {@link StreamResponse}.
 * v1.0 senders POST the protobuf-JSON encoding of the envelope, so the parse
 * goes through the generated `fromJSON` (which normalizes enum names to their
 * numeric members and part shapes to the `$case` oneof) rather than a cast.
 * Returns `null` when the body is not a recognizable envelope.
 */
export function parseStreamResponse(body: unknown): StreamResponse | null {
  if (!body || typeof body !== "object") return null;
  let parsed: StreamResponse;
  try {
    parsed = StreamResponse.fromJSON(body);
  } catch {
    return null;
  }
  return parsed.payload ? parsed : null;
}

/**
 * The agent's reply text for a snapshot: the status message if it carries any,
 * else the first artifact with text. Returns "" if nothing textual was produced.
 */
export function snapshotText(snapshot: TaskSnapshot): string {
  const statusText = partsText(snapshot.statusMessage?.parts);
  if (statusText) return statusText;

  for (const artifact of snapshot.artifacts) {
    const text = partsText(artifact.parts);
    if (text) return text;
  }
  return "";
}
