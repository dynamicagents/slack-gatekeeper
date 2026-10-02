import { env } from "cloudflare:workers";

/**
 * Shared vocabulary for the 🛑 reaction: its emoji, the event that wakes the
 * workflow owning it, the bounds its budget loop runs under, and the one-line
 * sender for that event. The ReactionWorkflow itself lives in `reaction.ts` and
 * re-exports these, mirroring how `message-helpers.ts` sits beside `message.ts`.
 *
 * Split out to keep the import graph acyclic. `reaction.ts` needs the
 * cancellation machinery in `message-helpers.ts` (and through it `dispatch.ts`),
 * while `dispatch.ts` needs to signal the workflow when a parked task resumes —
 * so the constants and the signal live here, importing nothing of ours, and all
 * three depend on this rather than on each other.
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
 * boundary it cares about: the fan-out drained, or a parked task resumed. Slack
 * event types only allow `[a-zA-Z0-9_-]` — no dots.
 *
 * **The workflow's processing budget depends on this firing only at real leg
 * boundaries.** It measures a leg with its own `waitForEvent` timeout rather than
 * a stored timestamp, so a signal sent mid-leg would silently hand every agent
 * of the fan-out a fresh leg of its own budget. Both senders respect that today:
 * `collectIfEventDrained` signals
 * only once no non-terminal task remains (not when one agent of a fan-out
 * finishes), and the resume path signals exactly when a new leg starts. Anything
 * added later must hold to the same rule.
 */
export const REACTION_SYNC_EVENT = "ledger_changed";

/**
 * Ceiling on how many times the ReactionWorkflow's budget loop may go round. A
 * leg is a real state transition, not a slice of time — a parked task waits the
 * full HITL TTL in one leg, woken early by the resume signal — so at roughly two
 * legs per ask/answer round-trip this is budget for ~50 of them, which should be
 * extremely rare to reach. The true bound is the 30-day task sweep: once those
 * rows are gone, `evaluateEvent` reports `drained` and the loop exits on its own.
 *
 * It is the backstop of the {@link MAX_WOKEN_AGENTS} guard, not a case with
 * handling of its own: a fan-out held under that bound cannot run the loop out of
 * legs, so reaching this cap means the documented invariant was violated
 * upstream. It is logged loudly and the workflow then gives up watching — the 🛑
 * comes off and the 30-day task sweep still owns the rows.
 */
export const MAX_LEGS = 100;

/**
 * Ceiling on how many agents one message may wake. Enforced where the fan-out is
 * decided (`handleSlackEvent`), because `resolveTargets` returns every agent
 * attached to the channel and so bounds the width by configuration alone.
 *
 * Why it must be strictly under {@link MAX_LEGS}: the ReactionWorkflow stops each
 * woken agent at its *own* deadline, and the only way it can do that is to wait
 * out one leg of its loop per distinct expiry — N agents on N different deadlines
 * spend N legs, plus one more leg to see the ledger drained and stop. Leaving a
 * leg of headroom is therefore what keeps the widest legal fan-out inside the
 * budget, and it is why the fan-out must be less than 100.
 */
export const MAX_WOKEN_AGENTS = MAX_LEGS - 1;

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
export async function signalReactionSync(eventId: string): Promise<void> {
  try {
    const instance = await env.REACTION_WORKFLOW.get(
      reactionInstanceId(eventId)
    );
    await instance.sendEvent({ type: REACTION_SYNC_EVENT, payload: {} });
  } catch (err) {
    console.warn("[reaction] sync signal failed (non-fatal)", {
      eventId,
      err: String(err)
    });
  }
}
