import { env } from "cloudflare:workers";
import {
  getAgentTaskByToken,
  resumeFromInput,
  suspendForInput
} from "@/db/models/agent-tasks";

/**
 * Shared vocabulary for the 🛑 reaction: its emoji, the event that wakes the
 * workflow owning it, the bounds its budget loop runs under, and the one-line
 * sender for that event. The ReactionWorkflow itself lives in `reaction.ts` and
 * re-exports these, mirroring how `message-helpers.ts` sits beside `message.ts`.
 *
 * Split out to keep the import graph acyclic. `reaction.ts` needs the
 * cancellation machinery in `message-helpers.ts` (and through it `dispatch.ts`),
 * while `dispatch.ts` needs to signal the workflow when a parked task resumes —
 * so the constants and the signal live here, importing nothing of ours but the
 * task ledger, and all three depend on this rather than on each other.
 */

/**
 * Emoji reaction the gatekeeper pre-adds to a trigger message while its agents work.
 * It doubles as the **cancel affordance**: the human taps this same 🛑 to stop
 * the run (see the `reaction_added` → CancelWorkflow path), so there's a single
 * one-tap control instead of a separate "working" indicator and stop emoji.
 * Configurable here in one place. The reaction is *added* inline by the webhook
 * handler (so it shows immediately); the ReactionWorkflow owns its removal.
 */
export const STOP_REACTION = "octagonal_sign";

/**
 * Event `type` sent to the ReactionWorkflow whenever the task ledger reaches a
 * boundary it cares about. Slack event types only allow `[a-zA-Z0-9_-]`, no dots.
 *
 * Every signal ends the leg in progress: the workflow charges the time since it
 * began to each task that worked through it, a parked one nothing, and reads
 * the ledger again. A task parking, a message waking one, the fan-out draining
 * all send one. What a signal adds is in {@link ReactionSync}. A lost one costs
 * accuracy, never the task: the leg it would have ended runs to its timeout.
 */
export const REACTION_SYNC_EVENT = "ledger_changed";

/** What a signal to the ReactionWorkflow says: see {@link REACTION_SYNC_EVENT}. */
export interface ReactionSync {
  /** The task a person answered: its own budget starts again, and no other's. */
  fresh?: string;
  /**
   * From the MessageWorkflow once it has recorded every task it will: until
   * then, a fan-out with nothing open may still be routing, not drained.
   */
  routed?: boolean;
}

/**
 * Ceiling on how many times the ReactionWorkflow's budget loop may go round. A
 * leg is a real state transition, not a slice of time — a parked task waits the
 * full HITL TTL in one leg, woken early by the resume signal — so at roughly two
 * legs per ask/answer round-trip this is budget for ~50 of them, which should be
 * extremely rare to reach. The true bound is the 30-day task sweep: once those
 * rows are gone, `evaluateEvent` reports `drained` and the loop exits on its own.
 *
 * It is the backstop of the {@link MAX_WOKEN_AGENTS} guard rather than a case with
 * handling of its own: that guard holds the one dimension configuration alone can
 * blow up — distinct deadline expiries — inside this cap, but it is not a bound on
 * the loop's whole appetite, since HITL round-trips spend legs from the same budget
 * (see there). So reaching this cap means either the fan-out bound was violated
 * upstream or the run simply asked for more legs than the loop has. Either way it
 * is logged loudly and the workflow then gives up watching — the 🛑 comes off and
 * the 30-day task sweep still owns the rows.
 */
export const MAX_LEGS = 101;

/**
 * Ceiling on how many agents one message may wake. Enforced where the fan-out is
 * decided (`handleSlackEvent`), because `resolveTargets` returns every agent
 * attached to the channel and so bounds the width by configuration alone.
 *
 * Why it must be two under {@link MAX_LEGS}: the ReactionWorkflow stops each
 * woken agent at its *own* deadline, and the only way it can do that is to wait
 * out one leg of its loop per distinct expiry. N agents on N different deadlines
 * spend N legs, plus the first, which ends at the delivery-retry grace, and one
 * more to see the ledger drained and stop.
 *
 * The whole arithmetic, so the −2 is not read as more than it is: the grace leg,
 * N expiry legs and the drained-observation leg are exactly what fits in
 * {@link MAX_LEGS}, and nothing beyond that is reserved. Every other signal draws
 * on the same leg budget (a task parking on a question, an answer, a message
 * joining it), and no fixed reserve could cover them, because a single turn may
 * ask arbitrarily many questions. So a max-width fan-out that also asks can still
 * run the loop out of legs, and so can one agent asking fifty questions. The guard
 * bounds the dimension that configuration alone decides, not the loop's total
 * appetite: when the legs do run out, the `console.error` at the cap is the
 * tripwire and the 30-day task sweep still owns the rows.
 */
export const MAX_WOKEN_AGENTS = MAX_LEGS - 2;

/** Deterministic ReactionWorkflow instance id derived from the Slack event id. */
export function reactionInstanceId(eventId: string): string {
  return `react-${eventId}`;
}

/**
 * Nudge the ReactionWorkflow to re-evaluate the ledger now rather than at its
 * next scheduled wake. Best-effort: any failure is logged, not thrown — the
 * workflow re-derives everything from D1 when it does wake, so a lost signal
 * costs lateness, never correctness. Also throws once the instance has finished
 * (a reply landing after the task was canceled), which is expected and harmless.
 */
export async function signalReactionSync(
  eventId: string,
  sync: ReactionSync = {}
): Promise<void> {
  try {
    const instance = await env.REACTION_WORKFLOW.get(
      reactionInstanceId(eventId)
    );
    await instance.sendEvent({ type: REACTION_SYNC_EVENT, payload: sync });
  } catch (err) {
    console.warn("[reaction] sync signal failed (non-fatal)", {
      eventId,
      err: String(err)
    });
  }
}

/**
 * Park a task's row on the person (`awaiting-input`), and end the budget's leg
 * there. Without the signal the wait in progress would charge the task for the
 * whole leg once it woke, the time it spent parked included. Returns whether
 * the row parked.
 */
export async function parkTask(
  token: string,
  eventId: string
): Promise<boolean> {
  const parked = await suspendForInput(token);
  if (parked) await signalReactionSync(eventId);
  return parked;
}

/**
 * Wake a task's row before something is sent onto it, so the turn's first
 * callbacks find it working: a joined message, on the budget it had, or a
 * person's answer (`answered`), which starts the task's own leg afresh, parked
 * or not. Returns whether the row was parked, so a send the task does not take
 * can park it again.
 */
export async function wakeTask(
  token: string,
  answered = false
): Promise<boolean> {
  const woke = await resumeFromInput(token);
  const eventId =
    woke ?? (answered ? (await getAgentTaskByToken(token))?.eventId : null);
  if (eventId) {
    await signalReactionSync(eventId, answered ? { fresh: token } : {});
  }
  return woke !== null;
}
