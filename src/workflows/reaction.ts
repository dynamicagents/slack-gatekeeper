import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ReactionWorkflowParams } from "@/slack/types";
import { HITL_REQUEST_TTL_SECONDS, TASK_DEADLINE_SECONDS } from "@/config";
import { removeReaction, postReply } from "@/wrappers/slack";
import { getPendingAgentTasksByEventId } from "@/db/models/agent-tasks";
import { cancelTaskRow } from "@/workflows/message-helpers";
import {
  REACTION_SYNC_EVENT,
  STOP_REACTION
} from "@/workflows/reaction-helpers";

// Re-exported so callers and tests can keep importing the 🛑 vocabulary from the
// workflow that owns it, while the definitions sit in `reaction-helpers` where
// `dispatch` and `message-helpers` can reach them without a cycle.
export {
  STOP_REACTION,
  REACTION_SYNC_EVENT,
  reactionInstanceId
} from "@/workflows/reaction-helpers";

/**
 * How long the first wait runs before the gatekeeper speaks up about deliveries it
 * explicitly rejected. Derived from when the last retry is expected, not chosen:
 * a remote's push callback is a Workflow step inheriting Cloudflare's default
 * retry policy (`limit: 5, delay: 10s, backoff: exponential`), so its ladder is
 * 10+20+40+80+160 = 310s ≈ 5m10s; a built-in's in-process sender exhausts in
 * ~1.3s. Six minutes clears both with margin, so a misconfigured agent is
 * surfaced just as fast as it was before the stop window grew to an hour.
 */
export const DELIVERY_RETRY_GRACE_SECONDS = 6 * 60;

/**
 * The grace is spent *inside* the first leg, so it can never outlast the budget
 * it is carved from — and what remains afterwards must still be a legal
 * `waitForEvent` timeout, which rejects anything below one second.
 *
 * Both clamps only bind when `TASK_DEADLINE_SECONDS` is set below the grace,
 * which is exactly what this PR's own verification steps ask you to do
 * (shorten it to ~60s to watch the timeout path run). Without them that produces
 * a `"-300 seconds"` timeout, and the leg ends by throwing rather than by
 * deciding — correct-looking behaviour that comes out of the catch block instead
 * of the logic.
 */
const GRACE_SECONDS = Math.min(
  DELIVERY_RETRY_GRACE_SECONDS,
  TASK_DEADLINE_SECONDS
);
const REMAINING_AFTER_GRACE = Math.max(
  1,
  TASK_DEADLINE_SECONDS - GRACE_SECONDS
);

/**
 * Ceiling on how many times the budget loop may go round. A leg is a real state
 * transition, not a slice of time — a parked task waits the full HITL TTL in one
 * leg, woken early by the resume signal — so at roughly two legs per ask/answer
 * round-trip this is budget for ~50 of them, which should be extremely rare to
 * reach. The true bound is the 30-day task sweep: once those rows are gone,
 * `evaluateEvent` reports `drained` and the loop exits on its own.
 */
const MAX_LEGS = 100;

/**
 * Backstop notice: an accepted turn whose delivery callback we saw explicitly
 * rejected (auth/malformed) and which never succeeded within the window. Past
 * tense on purpose — it stays truthful even if the remote retries and succeeds
 * later (the row is never terminalized here).
 */
function rejectedDeliveryText(agentName: string, reason: string): string {
  return `*Agent ${agentName}* failed to deliver a reply: ${reason}. If you don't hear back, please contact the agent developer.`;
}

/**
 * The processing budget as the user should read it, derived rather than written
 * out so the notice below can't drift from `TASK_DEADLINE_SECONDS`.
 */
const TASK_DEADLINE_LABEL =
  TASK_DEADLINE_SECONDS % 3600 === 0
    ? `${TASK_DEADLINE_SECONDS / 3600} hour${TASK_DEADLINE_SECONDS === 3600 ? "" : "s"}`
    : `${Math.round(TASK_DEADLINE_SECONDS / 60)} minutes`;

/** Notice posted when a task burned its whole processing budget without replying. */
function taskTimedOutText(agentName: string): string {
  return `⏱️ *Agent ${agentName}* didn't reply within the ${TASK_DEADLINE_LABEL} limit, so the gatekeeper stopped it. Any later reply will be discarded.`;
}

/**
 * On the retry-grace timeout, surface any pending task that carries a captured
 * `lastError` (a delivery callback we rejected). Best-effort by contract: never
 * throws, so the loop always makes progress, and so a step retry can't re-post.
 * Pending tasks without an error are left silent — absence of a callback is not
 * proof of failure. The row is never terminalized here: unlike a cancel, a
 * rejected delivery is not a decision to stop, and the remote may still retry
 * successfully within its budget.
 */
async function surfaceRejectedDeliveries(eventId: string): Promise<void> {
  try {
    const pending = await getPendingAgentTasksByEventId(eventId);
    for (const row of pending) {
      if (!row.lastError) continue;
      try {
        // App branding (null) — this is a gatekeeper error notice, not an agent reply.
        await postReply(
          row.channelId,
          row.replyThreadTs,
          rejectedDeliveryText(row.agentName, row.lastError),
          null,
          null
        );
      } catch (err) {
        console.error("[reaction] failed to surface rejected delivery", {
          agent: row.agentName,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  } catch (err) {
    console.error("[reaction] failed to load pending tasks for backstop", {
      eventId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * What the fan-out for a trigger event is doing right now.
 * - `drained` — nothing non-terminal left; the 🛑 has done its job.
 * - `working` — at least one task is `pending`, so the budget clock applies.
 * - `parked`  — nothing pending, but something is `awaiting-input`. The clock
 *               stops: that stretch is human time, bounded by the HITL TTL.
 */
type EventState = "drained" | "working" | "parked";

/** Read the ledger and classify the fan-out. The workflow's only source of truth. */
async function evaluateEvent(eventId: string): Promise<EventState> {
  const rows = await getPendingAgentTasksByEventId(eventId);
  if (rows.length === 0) return "drained";
  return rows.some((r) => r.status === "pending") ? "working" : "parked";
}

/**
 * Stop every task of this event still `pending`, because its processing budget
 * ran out. Runs the same cancellation a human's 🛑 does — a real `tasks/cancel`
 * so the agent stops burning its own compute — differing only in the recorded
 * origin and in what the user is told.
 *
 * `awaiting-input` rows are excluded by the `pending` filter alone: a task parked
 * on a prompt has not spent any of its budget, and killing it here would break an
 * approval left open over a weekend.
 *
 * Best-effort by contract: never throws, so the loop always makes progress.
 */
async function cancelPendingTasks(eventId: string): Promise<void> {
  try {
    const rows = await getPendingAgentTasksByEventId(eventId);
    for (const row of rows) {
      if (row.status !== "pending") continue;
      try {
        const { agentName } = await cancelTaskRow(row, {
          reason: "task-timeout",
          actorUserId: null
        });
        // App branding (null) — a gatekeeper notice, not an agent reply. One line per
        // agent whatever the cancel outcome: "we stopped it" and "it refused to
        // stop" look identical from the thread, since either way no reply lands.
        await postReply(
          row.channelId,
          row.replyThreadTs,
          taskTimedOutText(agentName),
          null,
          null
        );
      } catch (err) {
        console.error("[reaction] failed to cancel timed-out task", {
          agent: row.agentName,
          token: row.token,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  } catch (err) {
    console.error("[reaction] failed to load tasks for timeout cancel", {
      eventId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Durable owner of the 🛑 reaction's lifetime and of each task's processing
 * budget. The webhook handler adds the reaction inline (so it appears immediately,
 * without waiting for a workflow cold start); this workflow runs alongside — never
 * wraps — the MessageWorkflow, and decides when the 🛑 comes off.
 *
 * Two phases:
 *
 *   1. A short wait sized to the delivery retry ladder. If nothing has landed by
 *      then, any callback we explicitly *rejected* is reported to the thread —
 *      the user learns about a broken agent in minutes, not at the hour mark.
 *
 *   2. A loop that owns the budget. Each pass re-reads the ledger and waits for
 *      whatever could change next: the remaining budget while an agent works, or
 *      the HITL TTL while one is parked on a human prompt. A wake by signal is a
 *      real leg boundary and buys a fresh {@link TASK_DEADLINE_SECONDS}; a wake by
 *      timeout while working means the budget is spent, so the task is canceled.
 *
 * Two things make this cheap and robust. Cloudflare bills Workflows on CPU, not
 * wall-clock, and a `waiting` instance holds no concurrency slot — so an hour of
 * waiting costs nothing. And every decision is re-derived from D1 on each wake,
 * so the sync event is only a promptness optimisation: losing one costs lateness,
 * never correctness.
 */
export class ReactionWorkflow extends WorkflowEntrypoint<
  Env,
  ReactionWorkflowParams
> {
  async run(event: WorkflowEvent<ReactionWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    try {
      // Phase 1 — wait out the delivery retry ladder. waitForEvent throws on
      // timeout, so the catch is what tells us nothing arrived.
      let graceTimedOut = false;
      try {
        await step.waitForEvent("await collect signal", {
          type: REACTION_SYNC_EVENT,
          timeout: `${GRACE_SECONDS} seconds`
        });
      } catch (err) {
        graceTimedOut = true;
        console.log("[reaction] retry grace elapsed — checking deliveries", {
          instanceId: event.instanceId,
          eventId: p.eventId,
          channelId: p.channelId,
          error: err instanceof Error ? err.message : String(err)
        });
      }

      if (graceTimedOut) {
        await step.do("surface-rejected-deliveries", () =>
          surfaceRejectedDeliveries(p.eventId)
        );
      }

      // Phase 2 — the budget loop. Phase 1's wait was part of the first leg, so
      // only the remainder is left unless a signal already restarted the clock.
      let budgetSeconds = graceTimedOut
        ? REMAINING_AFTER_GRACE
        : TASK_DEADLINE_SECONDS;

      let leg = 0;
      for (; leg < MAX_LEGS; leg++) {
        const state = await step.do(`evaluate:${leg}`, () =>
          evaluateEvent(p.eventId)
        );
        if (state === "drained") break;

        // Parked tasks spend human time, not budget: wait out the prompt's own
        // TTL instead, and let the resume signal cut that short.
        const waitSeconds =
          state === "parked" ? HITL_REQUEST_TTL_SECONDS : budgetSeconds;

        let timedOut = false;
        try {
          await step.waitForEvent(`sync:${leg}`, {
            type: REACTION_SYNC_EVENT,
            timeout: `${waitSeconds} seconds`
          });
        } catch {
          timedOut = true;
        }

        if (timedOut && state === "working") {
          // The budget is spent and the agent never delivered — stop it.
          await step.do(`cancel:${leg}`, () => cancelPendingTasks(p.eventId));
        } else if (!timedOut) {
          // A signal only ever fires at a real boundary (the fan-out drained, or a
          // parked task resumed), so this is the start of a fresh leg.
          budgetSeconds = TASK_DEADLINE_SECONDS;
        }
        // parked + timedOut → the prompt outlived its TTL. The maintenance sweep
        // owns that; just loop and re-read what it did.
      }

      if (leg >= MAX_LEGS) {
        console.error("[reaction] leg budget exhausted — removing reaction", {
          instanceId: event.instanceId,
          eventId: p.eventId,
          channelId: p.channelId
        });
      }

      await step.do("remove-reaction", () =>
        removeReaction(p.channelId, p.ts, STOP_REACTION)
      );
    } catch (err) {
      console.error("[reaction] workflow run failed", {
        instanceId: event.instanceId,
        eventId: p.eventId,
        channelId: p.channelId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      throw err;
    }
  }
}
