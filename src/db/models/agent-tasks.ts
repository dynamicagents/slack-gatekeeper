import { and, eq, lt, notInArray, sql } from "drizzle-orm";
import { getDb } from "../client";
import * as schema from "../schema";
import { TASK_RETENTION_SECONDS } from "@/config";

export type AgentTaskRow = typeof schema.agentTasks.$inferSelect;

/**
 * Statuses a task can never leave. Everything else (`pending`, `awaiting-input`)
 * is still in flight: it keeps the fan-out undrained, keeps the 🛑 alive, and
 * still accepts callbacks.
 *
 * Read this as the definition of "done" — the pending-task queries below exclude
 * it, and the notification boundaries drop any callback that arrives against it.
 * Adding a terminal state means adding it here and nowhere else.
 */
export const TERMINAL_TASK_STATUSES: AgentTaskRow["status"][] = [
  "completed",
  "canceled"
];

/**
 * Whether a task is over. The notification boundaries ask this before routing a
 * callback: a reply that arrives after the task was delivered, stopped, or timed
 * out is dropped rather than posted.
 */
export function isTerminalTaskStatus(status: AgentTaskRow["status"]): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** Everything captured at dispatch so the async callback can correlate, route, and collect. */
export interface CreateAgentTaskInput {
  /** Gatekeeper-generated push-notification validation token (PK, echoed by the remote). */
  token: string;
  /** Agent-assigned A2A Task id from the accept response (null if omitted). */
  taskId: string | null;
  agentName: string;
  channelId: string;
  /** Slack `ts` of the trigger message — the correlation key for a 🛑 stop reaction. */
  messageTs: string;
  /** Thread to reply into; null = post at channel top-level. */
  replyThreadTs: string | null;
  eventId: string;
}

/**
 * Record a pending agent task at dispatch time. Idempotent on the `token` PK so
 * the workflow's `record-task` step can retry (or a duplicate dispatch land)
 * without erroring or clobbering an already-recorded row.
 */
export async function createAgentTask(
  input: CreateAgentTaskInput
): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.agentTasks)
    .values({
      token: input.token,
      taskId: input.taskId,
      agentName: input.agentName,
      channelId: input.channelId,
      messageTs: input.messageTs,
      replyThreadTs: input.replyThreadTs,
      eventId: input.eventId
    })
    .onConflictDoNothing();
}

/**
 * Not-yet-completed tasks triggered by a specific Slack message, looked up by
 * `(channelId, messageTs)`. This is the reverse index a 🛑 stop reaction uses:
 * the reaction event carries only the reacted message's channel and ts, and one
 * trigger message can fan out to several agents (all sharing the same trigger
 * ts), so this returns the whole fan-out to cancel together. Includes
 * `awaiting-input` tasks so a 🛑 can still stop a run parked on a human prompt.
 */
export async function getPendingAgentTasksByChannelAndTs(
  channelId: string,
  messageTs: string
): Promise<AgentTaskRow[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.agentTasks)
    .where(
      and(
        eq(schema.agentTasks.channelId, channelId),
        eq(schema.agentTasks.messageTs, messageTs),
        notInArray(schema.agentTasks.status, TERMINAL_TASK_STATUSES)
      )
    );
}

/** Look up a pending/known task by its validation token (the callback's correlation key). */
export async function getAgentTaskByToken(
  token: string
): Promise<AgentTaskRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.agentTasks)
    .where(eq(schema.agentTasks.token, token))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Whether a 🛑 stop has been recorded for this task.
 *
 * Two readers, both needing the same answer at different moments: the dispatch's
 * pre-send guard (never wake an agent that was already stopped), and a *running*
 * local turn, which re-reads this between steps. The cancel workflow runs on its
 * own request and can't reach into a Durable Object mid-turn, so this row is the
 * only channel it has to the agent — see the stop condition in `shared/loop`.
 */
export async function isCancelRequested(token: string): Promise<boolean> {
  const row = await getAgentTaskByToken(token);
  return Boolean(row?.cancelRequested);
}

/**
 * Not-yet-completed tasks for a Slack trigger event — the drain check and the
 * reaction backstop read these. Includes `awaiting-input` so a task parked on a
 * human prompt keeps the fan-out from draining early (the 🛑 lingers while any
 * sibling is still working or awaiting an answer).
 */
export async function getPendingAgentTasksByEventId(
  eventId: string
): Promise<AgentTaskRow[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.agentTasks)
    .where(
      and(
        eq(schema.agentTasks.eventId, eventId),
        notInArray(schema.agentTasks.status, TERMINAL_TASK_STATUSES)
      )
    );
}

/**
 * Fill in the A2A Task id once the accept response is known, and atomically
 * report whether a stop was requested in the meantime. The row is written before
 * dispatch (with `taskId` null) to close the accept→record race, so this
 * backfills the id afterwards. Conditional on `pending` so a task the callback
 * already completed is untouched.
 *
 * Returns `true` iff the row was still pending **and** `cancel_requested` was
 * already set — i.e. a 🛑 landed during the send and the caller must now honor it
 * by issuing `tasks/cancel`. This single atomic `UPDATE … RETURNING` pairs with
 * {@link markCancelRequested}: SQLite serializes the two, so whichever commits
 * second observes both the taskId and the intent, and exactly one path cancels.
 */
export async function updateAgentTaskTaskId(
  token: string,
  taskId: string
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(schema.agentTasks)
    .set({ taskId })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        eq(schema.agentTasks.status, "pending")
      )
    )
    .returning({ cancelRequested: schema.agentTasks.cancelRequested });
  return rows.length > 0 && rows[0].cancelRequested === 1;
}

/** Outcome of flagging a stop on a task row. */
export interface MarkCancelResult {
  /** A pending row was matched (false = already completed/purged — nothing to do). */
  matched: boolean;
  /** The task's A2A id if the accept already returned it (else null → intent recorded). */
  taskId: string | null;
}

/**
 * Flag that a stop was requested for a task, and atomically report the current
 * `taskId`. Conditional on `pending` so a completed/purged task is a no-op
 * (`matched: false`). Pairs with {@link updateAgentTaskTaskId} as the race
 * handshake (§ the two atomic statements): if this returns a non-null `taskId`,
 * the accept already committed and the caller cancels directly; if null, the
 * intent is now recorded and the dispatch's accept path honors it.
 */
export async function markCancelRequested(
  token: string
): Promise<MarkCancelResult> {
  const db = getDb();
  const rows = await db
    .update(schema.agentTasks)
    .set({ cancelRequested: 1 })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        eq(schema.agentTasks.status, "pending")
      )
    )
    .returning({ taskId: schema.agentTasks.taskId });
  if (rows.length === 0) return { matched: false, taskId: null };
  return { matched: true, taskId: rows[0].taskId };
}

/**
 * Record why a callback was rejected, so the reaction backstop can surface the
 * reason instead of silence. Conditional on `pending` so a completed task is
 * never reopened. `message` must be a gatekeeper-controlled string — never remote
 * payload — since it can be posted to Slack verbatim.
 */
export async function recordAgentTaskError(
  token: string,
  message: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agentTasks)
    .set({ lastError: message })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        eq(schema.agentTasks.status, "pending")
      )
    );
}

/**
 * Record that an intermediate update's `messageId` has been received (and its
 * text posted to Slack) for a task, so an at-least-once push retry does not
 * double-post the same progress message. The append-if-absent is a single
 * atomic UPDATE (no app-side read-modify-write, so concurrent callbacks can't
 * race): it only appends when the id is not already present in the
 * comma-delimited `received_message_ids` set. Returns `true` when a row was
 * updated (this update was new → the caller should post it); `false` when the
 * id was already recorded or the task is no longer `pending`. Membership is an
 * exact, literal `instr` substring search over the comma-wrapped set (not
 * `LIKE`, whose `%`/`_` would be interpreted as wildcards in the
 * remote-controlled `messageId`).
 *
 * Commas and whitespace are stripped from `messageId` before use: the comma is
 * the set delimiter (a raw one would corrupt membership tests) and whitespace
 * carries no meaning in an opaque id. The remote id format is not guaranteed,
 * so we sanitize rather than reject.
 */
export async function recordReceivedMessageId(
  token: string,
  messageId: string
): Promise<boolean> {
  const db = getDb();
  const id = messageId.replace(/[\s,]/g, "");
  const rows = await db
    .update(schema.agentTasks)
    .set({
      receivedMessageIds: sql`case
        when ${schema.agentTasks.receivedMessageIds} is null
          or ${schema.agentTasks.receivedMessageIds} = ''
        then ${id}
        else ${schema.agentTasks.receivedMessageIds} || ',' || ${id}
      end`
    })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        eq(schema.agentTasks.status, "pending"),
        // Exact, comma-delimited set membership via `instr` (a literal substring
        // search). `LIKE` is unusable here: `messageId` is remote-controlled and
        // its `%`/`_` would act as wildcards, so an id could falsely match a
        // different stored id and drop a genuine update.
        sql`instr(
          ',' || coalesce(${schema.agentTasks.receivedMessageIds}, '') || ',',
          ',' || ${id} || ','
        ) = 0`
      )
    )
    .returning({ token: schema.agentTasks.token });
  return rows.length > 0;
}

/**
 * Park a task while a human-in-the-loop prompt is open: `pending` →
 * `awaiting-input`. Non-terminal, so the fan-out stays undrained (🛑 still
 * cancels), but every `pending`-conditional mutator becomes a safe no-op until
 * {@link resumeFromInput}. Conditional on `pending` so a task the callback
 * already completed (or a duplicate `input-required` push) is untouched.
 */
export async function suspendForInput(token: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(schema.agentTasks)
    .set({ status: "awaiting-input" })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        eq(schema.agentTasks.status, "pending")
      )
    )
    .returning({ token: schema.agentTasks.token });
  return rows.length > 0;
}

/**
 * Un-park a task after its human answer is sent back onto it: `awaiting-input`
 * → `pending`, so the resumed turn's callbacks (progress + terminal) are honored
 * again. Conditional on `awaiting-input` so an already-resumed/cancelled row is a
 * no-op.
 *
 * Returns the row's `eventId` when it un-parked, so the caller can wake the
 * ReactionWorkflow: this is the start of a fresh processing leg, and the workflow
 * measures legs with its own timer rather than a stored timestamp, so it has to
 * be told. Null means nothing was un-parked and there is nothing to signal.
 */
export async function resumeFromInput(token: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .update(schema.agentTasks)
    .set({ status: "pending" })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        eq(schema.agentTasks.status, "awaiting-input")
      )
    )
    .returning({ eventId: schema.agentTasks.eventId });
  return rows[0]?.eventId ?? null;
}

/**
 * Mark a task completed. Conditional on it not already being terminal so a
 * duplicate or replayed callback flips exactly one row — the returned count is
 * the caller's idempotency signal (1 = we own this callback; 0 = already
 * handled). Completes from `pending` (the normal terminal callback) or from
 * `awaiting-input` (a task parked on a human prompt that then finished).
 *
 * The terminal guard is what stops a late callback from reopening a task the
 * gatekeeper already gave up on: a `canceled` row stays canceled.
 */
export async function completeAgentTask(token: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(schema.agentTasks)
    .set({ status: "completed", completedAt: sql`(unixepoch())` })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        notInArray(schema.agentTasks.status, TERMINAL_TASK_STATUSES)
      )
    )
    .returning({ token: schema.agentTasks.token });
  return rows.length > 0;
}

/**
 * Mark a task canceled — the terminal state for a stop, whoever issued it: a
 * human tapping 🛑, or the gatekeeper hitting `TASK_DEADLINE_SECONDS` on a leg that
 * never delivered. The two are indistinguishable to the ledger; the actor is
 * captured in the `[cancel] canceling task` log line instead.
 *
 * Unlike the old behaviour, this is applied on *every* cancel outcome — including
 * an agent that answered `unsupported` and is still running. Its eventual
 * callback is dropped at the notification boundary rather than posted, so a
 * stopped run stays stopped from the user's point of view.
 *
 * Same conditional and same idempotency contract as {@link completeAgentTask}:
 * cancels from `pending` or from `awaiting-input` (a 🛑 on a parked task), and is
 * a no-op against an already-terminal row.
 */
export async function markAgentTaskCanceled(token: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(schema.agentTasks)
    .set({ status: "canceled", completedAt: sql`(unixepoch())` })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        notInArray(schema.agentTasks.status, TERMINAL_TASK_STATUSES)
      )
    )
    .returning({ token: schema.agentTasks.token });
  return rows.length > 0;
}

/**
 * Delete a task row by its token PK. Used to clean up a row written *before*
 * dispatch when the dispatch does not end in `accepted` (policy rejection or
 * exhausted retries) — no remote callback will ever arrive for it, so it must
 * not linger as a stale `pending` row for the reaction backstop to scan.
 */
export async function deleteAgentTask(token: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.agentTasks).where(eq(schema.agentTasks.token, token));
}

/**
 * Delete rows older than `olderThanSeconds` (default
 * {@link TASK_RETENTION_SECONDS}). Called by the nightly maintenance workflow to
 * keep the table from growing unbounded. The local-agent equivalent is
 * `DurableTaskStore.sweep`, on the same retention.
 */
export async function sweepStaleAgentTasks(
  olderThanSeconds = TASK_RETENTION_SECONDS
): Promise<number> {
  const db = getDb();
  const cutoff = sql`(unixepoch() - ${olderThanSeconds})`;
  const rows = await db
    .delete(schema.agentTasks)
    .where(lt(schema.agentTasks.createdAt, cutoff))
    .returning({ token: schema.agentTasks.token });
  return rows.length;
}
