import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { HitlAnswer, HitlRequestData } from "@dynamicagents/g2a-protocol";
import { getDb } from "../client";
import * as schema from "../schema";

const ONE_MONTH_SECONDS = 30 * 24 * 60 * 60;

export type HitlFormRow = typeof schema.hitlForms.$inferSelect;
export type { HitlDraft } from "../schema";

/** Everything captured when a HITL prompt is first rendered to Slack. */
export interface CreateHitlFormInput {
  requestId: string;
  token: string;
  taskId: string | null;
  contextId: string;
  agentName: string;
  channelId: string;
  threadTs: string | null;
  /** The form as received, sanitized. */
  request: HitlRequestData;
  /** Unix-seconds expiry (createdAt + HITL_REQUEST_TTL_SECONDS). */
  deadlineAt: number;
}

/**
 * Record a HITL prompt at render time. Idempotent on the `requestId` PK: an
 * at-least-once push redelivery of the same `input-required` update inserts
 * nothing and returns `false`, so the caller skips re-posting the Slack prompt.
 * Returns `true` only when this call created the row (the caller then posts).
 */
export async function createHitlForm(
  input: CreateHitlFormInput
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .insert(schema.hitlForms)
    .values({
      requestId: input.requestId,
      token: input.token,
      taskId: input.taskId,
      contextId: input.contextId,
      agentName: input.agentName,
      channelId: input.channelId,
      threadTs: input.threadTs,
      requestJson: input.request,
      deadlineAt: input.deadlineAt
    })
    .onConflictDoNothing()
    .returning({ requestId: schema.hitlForms.requestId });
  return rows.length > 0;
}

/** Look up a HITL prompt by its id (the interaction correlation key). */
export async function getHitlForm(
  requestId: string
): Promise<HitlFormRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.hitlForms)
    .where(eq(schema.hitlForms.requestId, requestId))
    .limit(1);
  return rows[0] ?? null;
}

/** Record the ts of the posted Block Kit prompt, so it can be updated later. */
export async function setHitlFormMessageTs(
  requestId: string,
  slackMessageTs: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.hitlForms)
    .set({ slackMessageTs })
    .where(eq(schema.hitlForms.requestId, requestId));
}

/**
 * Keep where `userId` is in a paged form, and what they have entered, until
 * they send it. One statement, so two people paging the same form at once each
 * keep their own. Returns whether the form is still open to keep it on.
 */
export async function saveHitlDraft(
  requestId: string,
  userId: string,
  draft: schema.HitlDraft
): Promise<boolean> {
  // A Slack user id is alphanumeric; anything else has no place in a JSON path.
  if (!/^[A-Z0-9]+$/i.test(userId)) return false;
  const db = getDb();
  const rows = await db
    .update(schema.hitlForms)
    .set({
      draftsJson: sql`json_set(coalesce(${schema.hitlForms.draftsJson}, '{}'), ${`$."${userId}"`}, json(${JSON.stringify(draft)}))`
    })
    .where(
      and(
        eq(schema.hitlForms.requestId, requestId),
        eq(schema.hitlForms.status, "awaiting")
      )
    )
    .returning({ requestId: schema.hitlForms.requestId });
  return rows.length > 0;
}

/** Where `userId` is in a paged form, or `undefined` before they first page it. */
export function hitlDraftOf(
  row: HitlFormRow,
  userId: string
): schema.HitlDraft | undefined {
  const drafts = row.draftsJson;
  return drafts && Object.hasOwn(drafts, userId) ? drafts[userId] : undefined;
}

/** The answers a person supplied in Slack, one per question id. */
export interface ClaimHitlAnswerInput {
  answeredBy: string;
  answers: Record<string, HitlAnswer>;
}

/**
 * Atomically claim a HITL request for an answer. The single conditional
 * `UPDATE … WHERE status='awaiting' RETURNING` makes this first-click-wins: two
 * humans racing on the same prompt (or a Slack retry) yield exactly one non-null
 * result; the loser gets `null` and the caller surfaces "already answered". The
 * full claimed row is returned so the caller can resume the task without a
 * second read.
 */
export async function claimHitlAnswer(
  requestId: string,
  input: ClaimHitlAnswerInput
): Promise<HitlFormRow | null> {
  const db = getDb();
  const rows = await db
    .update(schema.hitlForms)
    .set({
      status: "answered",
      answeredBy: input.answeredBy,
      answersJson: input.answers,
      answeredAt: sql`(unixepoch())`
    })
    .where(
      and(
        eq(schema.hitlForms.requestId, requestId),
        eq(schema.hitlForms.status, "awaiting")
      )
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Undo a claim whose answer never reached the agent, so the question can be
 * answered again. Returns whether the prompt is open again.
 *
 * Only while the task is still parked on it. A 🛑 or a final status that lands
 * while the answer is being sent closes the task's prompts, but only the
 * `awaiting` ones — this row was `answered` then, so it was skipped. Re-opening
 * it afterwards would bring back a live prompt on a task that is over, which is
 * exactly what closing prompts on a final status exists to prevent.
 */
export async function reopenHitlForm(requestId: string): Promise<boolean> {
  const db = getDb();
  const parked = db
    .select({ token: schema.agentTasks.token })
    .from(schema.agentTasks)
    .where(eq(schema.agentTasks.status, "awaiting-input"));
  const rows = await db
    .update(schema.hitlForms)
    .set({
      status: "awaiting",
      answeredBy: null,
      answersJson: null,
      answeredAt: null
    })
    .where(
      and(
        eq(schema.hitlForms.requestId, requestId),
        eq(schema.hitlForms.status, "answered"),
        inArray(schema.hitlForms.token, parked)
      )
    )
    .returning({ requestId: schema.hitlForms.requestId });
  return rows.length > 0;
}

/**
 * Cancel one still-open prompt by its id. For a prompt that was recorded but will
 * never be shown, so it has no Slack message to update. Returns whether it was
 * still `awaiting`.
 */
export async function cancelHitlForm(requestId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(schema.hitlForms)
    .set({ status: "canceled" })
    .where(
      and(
        eq(schema.hitlForms.requestId, requestId),
        eq(schema.hitlForms.status, "awaiting")
      )
    )
    .returning({ requestId: schema.hitlForms.requestId });
  return rows.length > 0;
}

/**
 * Cancel every still-open prompt for a task's correlation token, because the task
 * is over: a 🛑 landed while it was parked on input, or the agent reached a final
 * status without the answer. Returns the canceled rows so the caller can update
 * each Slack prompt to a closed state.
 */
export async function cancelHitlFormsByToken(
  token: string
): Promise<HitlFormRow[]> {
  const db = getDb();
  return db
    .update(schema.hitlForms)
    .set({ status: "canceled" })
    .where(
      and(
        eq(schema.hitlForms.token, token),
        eq(schema.hitlForms.status, "awaiting")
      )
    )
    .returning();
}

/**
 * Expire every `awaiting` prompt whose deadline has passed. Returns the expired
 * rows so the maintenance sweep can update each Slack prompt and signal a
 * timeout back onto its A2A task.
 */
export async function expireStaleHitlForms(
  now: number
): Promise<HitlFormRow[]> {
  const db = getDb();
  return db
    .update(schema.hitlForms)
    .set({ status: "expired" })
    .where(
      and(
        eq(schema.hitlForms.status, "awaiting"),
        lt(schema.hitlForms.deadlineAt, now)
      )
    )
    .returning();
}

/**
 * Delete rows older than `olderThanSeconds` (default 30 days) regardless of
 * status, keeping the table bounded. In practice `awaiting` rows are resolved
 * long before the cutoff — they expire via {@link expireStaleHitlForms},
 * bounded by the 7-day TTL — so this reaps only already-terminal rows.
 */
export async function sweepStaleHitlForms(
  olderThanSeconds = ONE_MONTH_SECONDS
): Promise<number> {
  const db = getDb();
  const cutoff = sql`(unixepoch() - ${olderThanSeconds})`;
  const rows = await db
    .delete(schema.hitlForms)
    .where(lt(schema.hitlForms.createdAt, cutoff))
    .returning({ requestId: schema.hitlForms.requestId });
  return rows.length;
}
