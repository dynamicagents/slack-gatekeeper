import {
  Role,
  StreamResponse,
  TaskState,
  type Message,
  type Part,
  type Task,
  type TaskStatusUpdateEvent
} from "@a2a-js/sdk";
import { buildMessage, textPart } from "@/a2a/parts";
import { snapshotOf, type TaskSnapshot } from "@/a2a/snapshot";

/**
 * A2A v1.0 fixture builders.
 *
 * The v1.0 wire types come from protobuf, so a literal has to carry every field
 * (empty strings, empty arrays, numeric enums). These builders keep the specs
 * readable and, crucially, keep the *wire* fixtures honest: a push-notification
 * body is produced by the generated `toJSON` rather than hand-written, so a
 * test can't accidentally assert against a shape a real v1.0 agent would never
 * send.
 */

/** An agent-authored message with a single text part. */
export function agentMessage(
  text: string,
  opts: { messageId?: string; contextId?: string; taskId?: string } = {}
): Message {
  return buildMessage({
    messageId: opts.messageId ?? "r1",
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    contextId: opts.contextId ?? "c1",
    taskId: opts.taskId ?? ""
  });
}

/** A user-authored message with a single text part. */
export function userMessage(
  text: string,
  opts: {
    messageId?: string;
    contextId?: string;
    taskId?: string;
    metadata?: Record<string, unknown>;
  } = {}
): Message {
  return buildMessage({
    messageId: opts.messageId ?? "m1",
    role: Role.ROLE_USER,
    parts: [textPart(text)],
    contextId: opts.contextId ?? "c1",
    taskId: opts.taskId ?? "",
    metadata: opts.metadata
  });
}

export interface TaskFixture {
  id?: string;
  contextId?: string;
  state: TaskState;
  /** Status-message text; omit for a status with no message at all. */
  text?: string;
  messageId?: string;
  /** Overrides `text` when the status message needs non-text parts (HITL). */
  parts?: Part[];
}

/** A whole `Task`, as an agent's `SendMessage` result or a push payload. */
export function makeTask(fixture: TaskFixture): Task {
  const contextId = fixture.contextId ?? "c1";
  const parts =
    fixture.parts ??
    (fixture.text === undefined ? undefined : [textPart(fixture.text)]);
  return {
    id: fixture.id ?? "task-1",
    contextId,
    status: {
      state: fixture.state,
      message: parts
        ? buildMessage({
            messageId: fixture.messageId ?? "r1",
            role: Role.ROLE_AGENT,
            parts,
            contextId
          })
        : undefined,
      timestamp: undefined
    },
    artifacts: [],
    history: [],
    metadata: undefined
  };
}

/** A `TaskStatusUpdateEvent` delta — what an agent streams mid-task. */
export function makeStatusUpdate(fixture: TaskFixture): TaskStatusUpdateEvent {
  const task = makeTask(fixture);
  return {
    taskId: task.id,
    contextId: task.contextId,
    status: task.status,
    metadata: undefined
  };
}

/** The `StreamResponse` envelope a v1.0 push notification carries. */
export function taskEnvelope(task: Task): StreamResponse {
  return { payload: { $case: "task", value: task } };
}

export function statusEnvelope(update: TaskStatusUpdateEvent): StreamResponse {
  return { payload: { $case: "statusUpdate", value: update } };
}

/**
 * The on-the-wire body of a push notification: the protobuf-JSON encoding of a
 * `StreamResponse`, exactly as the SDK's `V1PushNotificationSerializer` emits it.
 */
export function notificationBody(response: StreamResponse): unknown {
  return StreamResponse.toJSON(response);
}

/** The gatekeeper's flattened view of a task, for delivery-boundary tests. */
export function makeSnapshot(fixture: TaskFixture): TaskSnapshot {
  const snapshot = snapshotOf(taskEnvelope(makeTask(fixture)));
  if (!snapshot) throw new Error("fixture produced no snapshot");
  return snapshot;
}
