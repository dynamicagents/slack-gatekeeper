import {
  Role,
  TaskState,
  taskStateToJSON,
  type Message,
  type Part,
  type Task
} from "@a2a-js/sdk";

/**
 * Constructors and readers for A2A v1.0 message content.
 *
 * The v1.0 data model is generated from the protobuf schema, so the wire types
 * are "all fields present": a `Part` carries a `content` oneof discriminated by
 * `$case` (plus `filename`/`mediaType`), and a `Message` carries empty strings
 * and empty arrays rather than omitted optionals. Hand-writing those literals at
 * every call site is noisy and easy to get subtly wrong, so every part/message
 * the gatekeeper emits is built through the helpers here.
 */

/** Media type stamped on the text parts the gatekeeper emits. */
const TEXT_MEDIA_TYPE = "text/plain";
/** Media type stamped on the structured (HITL) data parts the gatekeeper emits. */
const DATA_MEDIA_TYPE = "application/json";

/**
 * Terminal A2A task states — those after which no further push notifications
 * arrive. `SUBMITTED` / `WORKING` are still in flight, and `INPUT_REQUIRED` /
 * `AUTH_REQUIRED` are *interrupted* states a task can still be resumed from.
 */
const TERMINAL_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED
]);

/** Whether a task state is terminal (no further updates expected). */
export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * A task state rendered for humans (`TASK_STATE_INPUT_REQUIRED` →
 * `input-required`). v1.0 states are numeric enum members, so anything
 * user-visible has to go through the protobuf JSON name first.
 */
export function taskStateLabel(state: TaskState): string {
  return taskStateToJSON(state)
    .replace(/^TASK_STATE_/, "")
    .toLowerCase()
    .replace(/_/g, "-");
}

/** A `text` part carrying `text`. */
export function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: TEXT_MEDIA_TYPE
  };
}

/** A `data` part carrying an arbitrary JSON value (the HITL wire contract). */
export function dataPart(data: unknown): Part {
  return {
    content: { $case: "data", value: data },
    metadata: undefined,
    filename: "",
    mediaType: DATA_MEDIA_TYPE
  };
}

/** The structured payload of a `data` part, or `undefined` for other kinds. */
export function dataOf(part: Part): unknown {
  return part.content?.$case === "data" ? part.content.value : undefined;
}

/** The fields a gatekeeper-authored A2A message needs; the rest get proto defaults. */
export interface MessageInput {
  messageId: string;
  role: Role;
  parts: Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  referenceTaskIds?: string[];
}

/**
 * Build an A2A v1.0 `Message`, filling the proto-required fields the gatekeeper
 * never sets (`extensions`, and the empty-string forms of the optional ids).
 */
export function buildMessage(input: MessageInput): Message {
  return {
    messageId: input.messageId,
    role: input.role,
    parts: input.parts,
    contextId: input.contextId ?? "",
    taskId: input.taskId ?? "",
    metadata: input.metadata,
    extensions: [],
    referenceTaskIds: input.referenceTaskIds ?? []
  };
}

/** Concatenate the text of every `text` part, trimming surrounding whitespace. */
export function partsText(parts: Part[] | undefined): string {
  if (!parts) return "";
  let out = "";
  for (const part of parts) {
    if (part.content?.$case === "text") out += part.content.value;
  }
  return out.trim();
}

/** The plain-text content of an inbound A2A message (what the user said). */
export function textOf(message: Message): string {
  return partsText(message.parts);
}

/**
 * Whether a `SendMessage` result is the immediate Message form rather than a
 * Task. v1.0 dropped the `kind` discriminator from both types, so the two are
 * told apart structurally — only a `Message` carries a `messageId`.
 */
export function isMessageResult(result: Message | Task): result is Message {
  return "messageId" in result;
}
