import { env, WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ReactionWorkflowParams } from "@/slack/types";
import { HITL_REQUEST_TTL_SECONDS } from "@/config";
import { removeReaction, postReply } from "@/wrappers/slack";
import {
  getPendingAgentTasksByEventId,
  getPendingAgentTasksWithDeadlinesByEventId
} from "@/db/models/agent-tasks";
import { cancelTaskRow } from "@/workflows/message-helpers";
import {
  MAX_LEGS,
  REACTION_SYNC_EVENT,
  STOP_REACTION,
  type ReactionSync
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
 * How long after a message's agents start work the gatekeeper speaks up about
 * deliveries it explicitly rejected, whatever the legs before it were cut by. Derived from when the last retry is expected, not chosen:
 * a remote's push callback is a Workflow step inheriting Cloudflare's default
 * retry policy (`limit: 5, delay: 10s, backoff: exponential`), so its ladder is
 * 10+20+40+80+160 = 310s ≈ 5m10s. Six minutes clears that with margin, so a
 * misconfigured agent is surfaced just as fast as it was before the stop window
 * grew to an hour. A built-in's callbacks are signed with this Worker's own key,
 * so a rejection there is a misconfigured `A2A_SIGNING_KEY`, surfaced the same.
 */
export const DELIVERY_RETRY_GRACE_SECONDS = 6 * 60;

/**
 * How long the MessageWorkflow is given, at a time, to finish routing before a
 * fan-out with nothing open is read again: its joins run before any of the
 * message's rows is recorded, and can take minutes against an agent slow to
 * answer, so until it says it is done (`routed`), or stops running, nothing
 * open does not yet mean drained.
 */
const ROUTING_WAIT_SECONDS = 30;

/** How long a fan-out waits on a MessageWorkflow that never says it is done. */
const MAX_ROUTING_WAITS = 60;

/**
 * Longest timeout `waitForEvent` will take. The platform accepts between one
 * second and 365 days
 * (https://developers.cloudflare.com/workflows/build/events-and-parameters/),
 * while nothing bounds an agent's `task_deadline_seconds` — an admin may set a
 * budget longer than a year, deliberately.
 *
 * Handing such a value to the wait throws *on entry*, which is the dangerous part:
 * the loop's catch reads a throw as "the wait elapsed", so it would decrement a
 * budget no time was spent against, cancel the task, and tell the user it ran past
 * a limit it never reached.
 */
const MAX_WAIT_SECONDS = 365 * 24 * 60 * 60;

/**
 * One leg's timeout, held inside what `waitForEvent` will accept: at least a
 * second, at most {@link MAX_WAIT_SECONDS}. Both edges are reachable from
 * configuration alone — a deadline at or under the retry grace leaves nothing
 * positive to wait, a multi-year deadline overshoots the platform cap — and an
 * out-of-range value throws where the loop cannot tell it apart from the wait
 * having elapsed.
 *
 * Capping the wait does not cap the deadline: a budget above the cap is served in
 * slices. The loop wakes at the cap with budget still in the map, re-reads the
 * ledger and waits again, so the task is stopped at its own full deadline — a
 * year's worth of legs later.
 *
 * Exported for the unit test, which is the only way to observe the upper edge:
 * driving it for real would mean waiting out a year.
 */
export function clampWaitSeconds(seconds: number): number {
  return Math.min(MAX_WAIT_SECONDS, Math.max(1, seconds));
}

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
 * - `drained`: nothing non-terminal left; the 🛑 has done its job.
 * - `working`: at least one task is `pending`, so the budget clock applies.
 * - `parked`: nothing pending, but something is `awaiting-input`. The clock
 *   stops: that stretch is human time, bounded by the HITL TTL.
 * - `routing`: nothing open yet, or nothing left, while the MessageWorkflow
 *   may still record a task (see {@link ROUTING_WAIT_SECONDS}).
 */
type EventState = "drained" | "working" | "parked" | "routing";

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
async function evaluateEvent(
  eventId: string,
  routed: boolean
): Promise<EventSnapshot> {
  const rows = await getPendingAgentTasksWithDeadlinesByEventId(eventId);
  const tasks = rows.map((r) => ({
    token: r.task.token,
    pending: r.task.status === "pending",
    deadlineSeconds: r.deadlineSeconds
  }));
  if (tasks.length > 0) {
    return {
      state: tasks.some((t) => t.pending) ? "working" : "parked",
      tasks
    };
  }
  if (!routed && (await messageWorkflowRuns(eventId))) {
    return { state: "routing", tasks };
  }
  return { state: "drained", tasks };
}

/** Whether the event's MessageWorkflow (its instance id is the event id) runs. */
async function messageWorkflowRuns(eventId: string): Promise<boolean> {
  try {
    const { status } = await (await env.MESSAGE_WORKFLOW.get(eventId)).status();
    return [
      "queued",
      "running",
      "paused",
      "waiting",
      "waitingForPause"
    ].includes(status);
  } catch {
    return false;
  }
}

/** A task whose own budget is spent, and the budget it was held to. */
interface ExpiredTask {
  token: string;
  deadlineSeconds: number;
}

/**
 * Stop the tasks of this event whose own processing budget ran out. Runs the same
 * cancellation a human's 🛑 does — a real `tasks/cancel` so the agent stops
 * burning its own compute — differing only in the recorded origin and in what the
 * user is told.
 *
 * The ledger is re-read at execution time, so a task that completed or parked
 * during the wait is skipped. The token filter on top of that is what makes
 * cancellation *differential*: a sibling with budget left is not in `expired` and
 * so is left to keep working, even though it is `pending` right now.
 *
 * `awaiting-input` rows are excluded by the `pending` filter alone: a task parked
 * on a prompt has not spent any of its budget, and killing it here would break an
 * approval left open over a weekend.
 *
 * The notice quotes the deadline from the snapshot the decision was made on, so it
 * names the budget actually spent even if an admin changed the value a moment later.
 *
 * Best-effort by contract: never throws, so the loop always makes progress.
 */
async function cancelPendingTasks(
  eventId: string,
  expired: ExpiredTask[]
): Promise<void> {
  const budgets = new Map(expired.map((e) => [e.token, e.deadlineSeconds]));
  try {
    const rows = await getPendingAgentTasksByEventId(eventId);
    for (const row of rows) {
      if (row.status !== "pending") continue;
      const deadlineSeconds = budgets.get(row.token);
      if (deadlineSeconds === undefined) continue; // a sibling with budget left
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
  }
}

/**
 * Durable owner of the 🛑 reaction's lifetime and of each task's processing
 * budget. The webhook handler adds the reaction inline (so it appears immediately,
 * without waiting for a workflow cold start); this workflow runs alongside — never
 * wraps — the MessageWorkflow, and decides when the 🛑 comes off.
 *
 * A loop that owns *a budget per task*, because each task is held to its own
 * agent's `task_deadline_seconds` as that read when the task was first seen;
 * changing an agent's deadline re-times its *next* tasks, never one already being
 * watched here. Each leg re-reads the ledger and waits for whatever could change
 * next: the *shortest* remaining budget while agents work, or the HITL TTL while
 * all are parked on a prompt, and never past the delivery-retry grace until that
 * has passed. A leg ends on its timeout or on a signal, and either way each task
 * that was working through it is charged the time it took; a parked one is
 * charged nothing. A task whose budget is spent is stopped, and siblings with
 * time left run on into the next leg. An answer gives its own task a fresh
 * budget, and no other.
 *
 * Once the grace has passed, any callback we explicitly *rejected* is reported to
 * the thread, so the user learns about a broken agent in minutes, not at the hour
 * mark. Each wait is held to a legal `waitForEvent` timeout
 * ({@link clampWaitSeconds}), so a budget longer than the platform's maximum is
 * served in slices rather than refused. One leg per distinct expiry is also what
 * bounds how wide a fan-out this loop can watch to the end, so how many agents a
 * message may wake is guarded where the fan-out is decided; see
 * {@link MAX_WOKEN_AGENTS}.
 *
 * Two things make this cheap and robust. Cloudflare bills Workflows on CPU, not
 * wall-clock, and a `waiting` instance holds no concurrency slot — so an hour of
 * waiting costs nothing. And every decision is re-derived from D1 on each wake,
 * so a signal is only a promptness and accuracy optimisation: losing one costs
 * lateness, never the task.
 */
export class ReactionWorkflow extends WorkflowEntrypoint<
  Env,
  ReactionWorkflowParams
> {
  async run(event: WorkflowEvent<ReactionWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    try {
      // Every time below comes from a step, so a replay decides the same way.
      const startedAt = await step.do("started", async () => Date.now());
      // One remaining budget per task, keyed by token, in seconds.
      const remaining = new Map<string, number>();
      let surfaced = false;
      let routed = false;
      let routing = 0;

      let leg = 0;
      for (; leg < MAX_LEGS; leg++) {
        let snap = await step.do(`evaluate:${leg}`, () =>
          evaluateEvent(p.eventId, routed)
        );
        while (snap.state === "routing" && routing < MAX_ROUTING_WAITS) {
          try {
            const signal = await step.waitForEvent<ReactionSync>(
              `routing:${routing}`,
              {
                type: REACTION_SYNC_EVENT,
                timeout: `${ROUTING_WAIT_SECONDS} seconds`
              }
            );
            if ((signal.payload as ReactionSync | undefined)?.routed) {
              routed = true;
            }
          } catch {
            // Timed out: read the ledger and the MessageWorkflow again.
          }
          snap = await step.do(`route-check:${routing++}`, () =>
            evaluateEvent(p.eventId, routed)
          );
        }
        if (snap.state === "drained" || snap.state === "routing") break;

        // First sight of a task starts its clock, on its agent's deadline as
        // read *here*; from then on the map is what the task is held to. Tasks
        // that have gone terminal drop out, so a token never outlives its row.
        for (const t of snap.tasks) {
          if (!remaining.has(t.token))
            remaining.set(t.token, t.deadlineSeconds);
        }
        for (const token of [...remaining.keys()]) {
          if (!snap.tasks.some((t) => t.token === token))
            remaining.delete(token);
        }

        const pending = snap.tasks.filter((t) => t.pending);
        const legStartedAt = await step.do(`leg-start:${leg}`, async () =>
          Date.now()
        );
        const untilGrace = surfaced
          ? Number.POSITIVE_INFINITY
          : DELIVERY_RETRY_GRACE_SECONDS -
            Math.floor((legStartedAt - startedAt) / 1000);
        const shortest = pending.reduce(
          (min, t) =>
            Math.min(min, remaining.get(t.token) ?? t.deadlineSeconds),
          Number.POSITIVE_INFINITY
        );
        const waitSeconds = clampWaitSeconds(
          Math.min(
            Number.isFinite(shortest) ? shortest : HITL_REQUEST_TTL_SECONDS,
            untilGrace
          )
        );

        let timedOut = false;
        let sync: ReactionSync | undefined;
        try {
          const signal = await step.waitForEvent<ReactionSync>(`sync:${leg}`, {
            type: REACTION_SYNC_EVENT,
            timeout: `${waitSeconds} seconds`
          });
          sync = signal.payload as ReactionSync | undefined;
        } catch {
          timedOut = true;
        }
        const endedAt = timedOut
          ? legStartedAt + waitSeconds * 1000
          : await step.do(`woke:${leg}`, async () => Date.now());
        const spent = timedOut
          ? waitSeconds
          : Math.max(0, Math.floor((endedAt - legStartedAt) / 1000));

        for (const t of pending) {
          const left = remaining.get(t.token);
          if (left !== undefined) remaining.set(t.token, left - spent);
        }
        if (sync?.routed) routed = true;
        const answered = sync?.fresh
          ? snap.tasks.find((t) => t.token === sync.fresh)
          : undefined;
        if (answered) remaining.set(answered.token, answered.deadlineSeconds);

        if (
          !surfaced &&
          endedAt - startedAt >= DELIVERY_RETRY_GRACE_SECONDS * 1000
        ) {
          console.log("[reaction] retry grace elapsed — checking deliveries", {
            instanceId: event.instanceId,
            eventId: p.eventId,
            channelId: p.channelId
          });
          await step.do("surface-rejected-deliveries", () =>
            surfaceRejectedDeliveries(p.eventId)
          );
          surfaced = true;
        }

        // Only the tasks whose own budget is spent. Siblings with more to run
        // keep going into the next leg, and a budget that outran the leg's legal
        // maximum is such a sibling of itself: the next leg serves its next slice.
        const expired: ExpiredTask[] = pending
          .filter((t) => (remaining.get(t.token) ?? 1) <= 0)
          .map((t) => ({ token: t.token, deadlineSeconds: t.deadlineSeconds }));
        if (expired.length > 0) {
          console.log("[reaction] budget spent — canceling", {
            instanceId: event.instanceId,
            eventId: p.eventId,
            leg,
            waitSeconds,
            expired
          });
          await step.do(`cancel:${leg}`, () =>
            cancelPendingTasks(p.eventId, expired)
          );
          for (const e of expired) remaining.delete(e.token);
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
