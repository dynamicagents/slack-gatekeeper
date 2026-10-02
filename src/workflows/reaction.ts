import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ReactionWorkflowParams } from "@/slack/types";
import {
  HITL_REQUEST_TTL_SECONDS,
  DEFAULT_TASK_DEADLINE_SECONDS
} from "@/config";
import { removeReaction, postReply } from "@/wrappers/slack";
import {
  getPendingAgentTasksByEventId,
  getPendingAgentTasksWithDeadlinesByEventId
} from "@/db/models/agent-tasks";
import { cancelTaskRow } from "@/workflows/message-helpers";
import {
  MAX_LEGS,
  REACTION_SYNC_EVENT,
  STOP_REACTION
} from "@/workflows/reaction-helpers";

// Re-exported so callers and tests can keep importing the 🛑 vocabulary from the
// workflow that owns it, while the definitions sit in `reaction-helpers` where
// `dispatch`, `message-helpers` and the webhook handler can reach them without a
// cycle.
export {
  STOP_REACTION,
  REACTION_SYNC_EVENT,
  MAX_LEGS,
  MAX_WOKEN_AGENTS,
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
 * `waitForEvent` timeout, which rejects anything below one second (the floor
 * `waitSeconds` applies in the loop below).
 *
 * The grace is still sized against the *default* because it is one wait shared by
 * the whole fan-out, and the per-agent deadlines are not known until the first
 * `evaluate` step has read them. The clamps bind for any agent whose own deadline
 * is at or below the grace — not only when the global constant is lowered for a
 * manual test. Without them such an agent produces a `"-300 seconds"` timeout,
 * and the leg ends by throwing rather than by deciding — correct-looking
 * behaviour that comes out of the catch block instead of the logic.
 */
const GRACE_SECONDS = Math.min(
  DELIVERY_RETRY_GRACE_SECONDS,
  DEFAULT_TASK_DEADLINE_SECONDS
);

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
 * A processing budget as the user should read it, derived from whichever budget
 * was actually enforced rather than written out — so the notice below always
 * names the number the task was really held to, not a constant beside it.
 *
 * Only the units that divide the value exactly are used: an admin may set any
 * positive whole number of seconds, and rounding one of those into minutes would
 * put a number in the notice that was never the limit (`1` read back as
 * "0 minutes", `90` as "2 minutes"). Falling through to seconds is sometimes
 * ugly — "3601 seconds" — but it is the number the admin chose, and the notice's
 * only job is to name the limit that was enforced.
 */
export function deadlineLabel(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** Notice posted when a task burned its whole processing budget without replying. */
function taskTimedOutText(agentName: string, deadlineSeconds: number): string {
  return `⏱️ *Agent ${agentName}* didn't reply within the ${deadlineLabel(deadlineSeconds)} limit, so the gatekeeper stopped it. Any later reply will be discarded.`;
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

/** One non-terminal task as the budget loop sees it. */
interface TaskSnapshot {
  token: string;
  /** Non-terminal only: `pending` spends budget, `awaiting-input` freezes it. */
  pending: boolean;
  /** This task's own agent's leg budget. Always set. */
  deadlineSeconds: number;
}

/** The fan-out's state and the tasks it is made of, as of one read. */
interface EventSnapshot {
  state: EventState;
  tasks: TaskSnapshot[];
}

/** Read the ledger and classify the fan-out. The workflow's only source of truth. */
async function evaluateEvent(eventId: string): Promise<EventSnapshot> {
  const rows = await getPendingAgentTasksWithDeadlinesByEventId(eventId);
  const tasks = rows.map((r) => ({
    token: r.task.token,
    pending: r.task.status === "pending",
    deadlineSeconds: r.deadlineSeconds
  }));
  if (tasks.length === 0) return { state: "drained", tasks };
  return { state: tasks.some((t) => t.pending) ? "working" : "parked", tasks };
}

/** A task whose own budget is spent, and the budget it was held to. */
interface ExpiredTask {
  token: string;
  deadlineSeconds: number;
}

/** How much of one task's own budget has been spent on this leg. */
interface TaskCharge {
  token: string;
  /** Seconds of processing time charged to the task, the wait just ended included. */
  spent: number;
}

/** What one working-timeout pass decided, re-derived from the ledger in-step. */
interface TimeoutPass {
  /** Canceled, each with the deadline its notice named. */
  expired: ExpiredTask[];
  /** Still working, with the charge that now stands against them. */
  survivors: TaskCharge[];
}

/**
 * Carry out one working-timeout pass: of the tasks that were pending when the
 * wait began, stop those whose own processing budget the wait has now spent. Runs
 * the same cancellation a human's 🛑 does — a real `tasks/cancel` so the agent
 * stops burning its own compute — differing only in the recorded origin and in
 * what the user is told.
 *
 * Both halves of the decision are made *here*, at execution time, from one fresh
 * read of the ledger joined to its agents:
 *
 * - **Status.** A task that completed or parked during the wait is skipped — it is
 *   in neither returned list, so a parked one keeps its charge frozen, which is
 *   right: the time it spends waiting on a human is not its own.
 * - **Deadline.** Expiry is `currentDeadline - spent <= 0` against the deadline as
 *   it reads *now*, never the one read before a wait that may have run for hours.
 *   So an admin raising an agent's limit mid-wait is always observed before a
 *   cancel (the task survives with what the new limit leaves it), and one lowering
 *   it is observed at this wake, with the new value named in the notice.
 *
 * Tracking *spent* time rather than remaining budget is what makes that re-read
 * possible: spent time is a fact about the past, so it stays true however the
 * deadline moves underneath it.
 *
 * The charge filter on top of the status check is what makes cancellation
 * *differential*: a sibling with budget left comes back as a survivor and is left
 * to keep working, even though it is `pending` right now.
 *
 * `awaiting-input` rows are excluded by the `pending` filter alone: a task parked
 * on a prompt is not spending its budget, and killing it here would break an
 * approval left open over a weekend.
 *
 * Best-effort by contract: never throws, so the loop always makes progress.
 */
async function cancelPendingTasks(
  eventId: string,
  charges: TaskCharge[]
): Promise<TimeoutPass> {
  const spent = new Map(charges.map((c) => [c.token, c.spent]));
  const expired: ExpiredTask[] = [];
  const survivors: TaskCharge[] = [];
  try {
    const rows = await getPendingAgentTasksWithDeadlinesByEventId(eventId);
    for (const { task: row, deadlineSeconds } of rows) {
      if (row.status !== "pending") continue;
      const charged = spent.get(row.token);
      if (charged === undefined) continue; // parked when the wait began, or newer
      if (deadlineSeconds - charged > 0) {
        survivors.push({ token: row.token, spent: charged });
        continue;
      }
      // Decided expired, so it leaves the loop's book either way: should the cancel
      // throw, the row is re-seen on a fresh leg next pass rather than charged twice.
      expired.push({ token: row.token, deadlineSeconds });
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
          taskTimedOutText(agentName, deadlineSeconds),
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
    // Nothing could be read, so nothing was decided: the charges stand as passed
    // in and the next pass re-reads them against a fresh ledger.
    return { expired: [], survivors: charges };
  }
  return { expired, survivors };
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
 *   2. A loop that owns *how much of its own budget each task has spent*, because
 *      each task is held to its own agent's `task_deadline_seconds`. Each pass
 *      re-reads the ledger and waits for whatever could change next: the shortest
 *      budget left (a deadline minus what that task has spent) while agents work,
 *      or the HITL TTL while one is parked on a human prompt. A wake by signal is a
 *      real leg boundary and buys every task a fresh leg of **its own agent's**
 *      deadline; a wake by timeout while working charges every pending task for
 *      the wait, and `cancelPendingTasks` then re-reads the ledger and stops only
 *      those whose own budget that charge has spent — siblings with time left run
 *      on into the next leg.
 *
 *      Because expiry is tested against the deadline read *inside* that step, an
 *      admin's edit during a wait is always honored before a cancel: a raise lets
 *      the task run on with what the new limit leaves it, and a lowering takes
 *      effect at the next wake at the latest — the wait already running may be
 *      longer than the new limit, which costs lateness, never a wrong cancel.
 *
 *      One leg per distinct expiry is also what bounds how wide a fan-out this
 *      loop can watch to the end, so how many agents a message may wake is
 *      guarded where the fan-out is decided; see {@link MAX_WOKEN_AGENTS}.
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

      // Phase 2 — the budget loop. One *spent* total per task keyed by token: how
      // much of its own agent's deadline this leg has charged it so far. Phase 1's
      // wait was part of the first leg, so a task first seen there is already
      // charged for the grace unless a signal restarted the clock.
      //
      // Spent time rather than remaining budget, because only spent time survives
      // an admin moving a deadline underneath a running wait: it is a fact about
      // the past, so the cancel step can subtract it from the deadline as that
      // reads at cancel time (see `cancelPendingTasks`).
      const spent = new Map<string, number>();

      let leg = 0;
      for (; leg < MAX_LEGS; leg++) {
        const snap = await step.do(`evaluate:${leg}`, () =>
          evaluateEvent(p.eventId)
        );
        if (snap.state === "drained") break;

        // Reconcile the map against this snapshot. First sight of a task starts its
        // clock — at the grace mark, if that is where we are. Tasks that have gone
        // terminal drop out, so a token can never outlive its row. Nothing else to
        // reconcile: the deadlines read here only size the next wait, and expiry is
        // decided inside `cancel:{leg}` against the deadline as it reads there.
        for (const t of snap.tasks) {
          if (!spent.has(t.token)) {
            spent.set(t.token, leg === 0 && graceTimedOut ? GRACE_SECONDS : 0);
          }
        }
        for (const token of [...spent.keys()]) {
          if (!snap.tasks.some((t) => t.token === token)) spent.delete(token);
        }

        // Parked tasks spend human time, not budget: wait out the prompt's own
        // TTL instead, and let the resume signal cut that short. While working, the
        // next thing that can happen is the *shortest* remaining budget expiring —
        // each task's freshly-read deadline less what it has already spent.
        const pending = snap.tasks.filter((t) => t.pending);
        const minRemaining = pending.reduce(
          (min, t) =>
            Math.min(min, t.deadlineSeconds - (spent.get(t.token) ?? 0)),
          Number.POSITIVE_INFINITY
        );
        const waitSeconds =
          snap.state === "parked" || !Number.isFinite(minRemaining)
            ? HITL_REQUEST_TTL_SECONDS
            : Math.max(1, minRemaining);

        let timedOut = false;
        try {
          await step.waitForEvent(`sync:${leg}`, {
            type: REACTION_SYNC_EVENT,
            timeout: `${waitSeconds} seconds`
          });
        } catch {
          timedOut = true;
        }

        if (timedOut && snap.state === "working") {
          // Everything that was pending waited out the whole timeout, so charge
          // them all for it and let the step decide — from a read of its own, taken
          // after the wait — whose budget that charge actually spends. Siblings
          // with more to run come back as survivors and keep going into the next
          // leg, which waits out whatever is left of the shortest of them.
          //
          // The alternative to re-reading here — signaling this instance whenever
          // an admin edits a deadline — is not available: a signal means a real leg
          // boundary and hands *every* task in the fan-out a fresh leg of its
          // budget, so using one to deliver a deadline change would reset the whole
          // fan-out's clocks as a side effect.
          const charges: TaskCharge[] = pending.map((t) => ({
            token: t.token,
            spent: (spent.get(t.token) ?? 0) + waitSeconds
          }));
          const pass = await step.do(`cancel:${leg}`, () =>
            cancelPendingTasks(p.eventId, charges)
          );
          console.log("[reaction] working timeout — budgets reckoned", {
            instanceId: event.instanceId,
            eventId: p.eventId,
            leg,
            waitSeconds,
            expired: pass.expired,
            survivors: pass.survivors
          });
          // Loop state from the step's output alone, so a replay re-derives it
          // rather than re-deciding it.
          for (const e of pass.expired) spent.delete(e.token);
          for (const s of pass.survivors) spent.set(s.token, s.spent);
        } else if (!timedOut) {
          // A signal only ever fires at a real boundary (the fan-out drained, or a
          // parked task resumed), so this is the start of a fresh leg — and each
          // task gets a fresh leg of its own agent's budget.
          for (const t of snap.tasks) spent.set(t.token, 0);
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
