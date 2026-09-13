import { and, eq, lt, sql } from "drizzle-orm";
import type { HitlRequestKind } from "@dynamicagents/g2a-protocol";
import { getDb } from "../client";
import * as schema from "../schema";

const ONE_MONTH_SECONDS = 30 * 24 * 60 * 60;

export type HitlRequestRow = typeof schema.hitlRequests.$inferSelect;

/** Everything captured when a HITL prompt is first rendered to Slack. */
export interface CreateHitlRequestInput {
  requestId: string;
  token: string;
  taskId: string | null;
  contextId: string;
  agentName: string;
  channelId: string;
  threadTs: string | null;
  requestKind: HitlRequestKind;
  promptText: string;
  /** JSON-encoded SlackInputOption[] as rendered. */
  optionsJson: string | null;
  allowFreeform: boolean;
  /** Unix-seconds expiry (createdAt + HITL_REQUEST_TTL_SECONDS). */
  deadlineAt: number;
}

/**
 * Record a HITL prompt at render time. Idempotent on the `requestId` PK: an
 * at-least-once push redelivery of the same `input-required` update inserts
 * nothing and returns `false`, so the caller skips re-posting the Slack prompt.
 * Returns `true` only when this call created the row (the caller then posts).
 */
export async function createHitlRequest(
  input: CreateHitlRequestInput
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .insert(schema.hitlRequests)
    .values({
      requestId: input.requestId,
      token: input.token,
      taskId: input.taskId,
      contextId: input.contextId,
      agentName: input.agentName,
      channelId: input.channelId,
      threadTs: input.threadTs,
      requestKind: input.requestKind,
      promptText: input.promptText,
      optionsJson: input.optionsJson,
      allowFreeform: input.allowFreeform ? 1 : 0,
      deadlineAt: input.deadlineAt
    })
    .onConflictDoNothing()
    .returning({ requestId: schema.hitlRequests.requestId });
  return rows.length > 0;
}

/** Look up a HITL request by its id (the interaction correlation key). */
export async function getHitlRequest(
  requestId: string
): Promise<HitlRequestRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.requestId, requestId))
    .limit(1);
  return rows[0] ?? null;
}

/** Record the ts of the posted Block Kit prompt, so it can be updated later. */
export async function setHitlSlackMessageTs(
  requestId: string,
  slackMessageTs: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.hitlRequests)
    .set({ slackMessageTs })
    .where(eq(schema.hitlRequests.requestId, requestId));
}

/** The answer a human supplied in Slack. */
export interface ClaimHitlAnswerInput {
  answeredBy: string;
  optionId?: string;
  text?: string;
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
): Promise<HitlRequestRow | null> {
  const db = getDb();
  const rows = await db
    .update(schema.hitlRequests)
    .set({
      status: "answered",
      answeredBy: input.answeredBy,
      answeredOptionId: input.optionId ?? null,
      answerText: input.text ?? null,
      answeredAt: sql`(unixepoch())`
    })
    .where(
      and(
        eq(schema.hitlRequests.requestId, requestId),
        eq(schema.hitlRequests.status, "awaiting")
      )
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Cancel every still-open prompt for a task's correlation token, because the task
 * is over: a 🛑 landed while it was parked on input, or the agent reached a final
 * status without the answer. Returns the canceled rows so the caller can update
 * each Slack prompt to a closed state.
 */
export async function cancelHitlRequestsByToken(
  token: string
): Promise<HitlRequestRow[]> {
  const db = getDb();
  return db
    .update(schema.hitlRequests)
    .set({ status: "canceled" })
    .where(
      and(
        eq(schema.hitlRequests.token, token),
        eq(schema.hitlRequests.status, "awaiting")
      )
    )
    .returning();
}

/**
 * Expire every `awaiting` prompt whose deadline has passed. Returns the expired
 * rows so the maintenance sweep can update each Slack prompt and signal a
 * timeout back onto its A2A task.
 */
export async function expireStaleHitlRequests(
  now: number
): Promise<HitlRequestRow[]> {
  const db = getDb();
  return db
    .update(schema.hitlRequests)
    .set({ status: "expired" })
    .where(
      and(
        eq(schema.hitlRequests.status, "awaiting"),
        lt(schema.hitlRequests.deadlineAt, now)
      )
    )
    .returning();
}

/**
 * Delete rows older than `olderThanSeconds` (default 30 days) regardless of
 * status, keeping the table bounded. In practice `awaiting` rows are resolved
 * long before the cutoff — they expire via {@link expireStaleHitlRequests},
 * bounded by the 7-day TTL — so this reaps only already-terminal rows.
 */
export async function sweepStaleHitlRequests(
  olderThanSeconds = ONE_MONTH_SECONDS
): Promise<number> {
  const db = getDb();
  const cutoff = sql`(unixepoch() - ${olderThanSeconds})`;
  const rows = await db
    .delete(schema.hitlRequests)
    .where(lt(schema.hitlRequests.createdAt, cutoff))
    .returning({ requestId: schema.hitlRequests.requestId });
  return rows.length;
}
