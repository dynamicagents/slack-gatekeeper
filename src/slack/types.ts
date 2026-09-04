// ---------------------------------------------------------------------------
// Params passed into Workflows — must be Rpc.Serializable (plain JSON types).
// ---------------------------------------------------------------------------

import type { ResolvedTarget } from "@/router/resolve";

/** Classifier output for a message event — before targets are resolved. */
export interface ClassifiedMessageParams {
  eventId: string;
  eventType: "app_mention" | "message";
  channelId: string;
  threadTs: string;
  ts: string;
  /** Always set — the classifier ignores message events without a sender. */
  userId: string;
  teamId?: string;
  text: string;
  /** Set for edits/deletes: the message's prior text (transcript on delete). */
  prevText?: string;
  /** Marks edit/delete events so the workflow renders a feed turn, not a reply. */
  editKind?: "edited" | "deleted";
  raw: Record<string, unknown>;
}

/** MessageWorkflow input — classifier params plus the agents resolved to wake. */
export interface MessageWorkflowParams extends ClassifiedMessageParams {
  /** Agents woken by this message, resolved once in the handler. Always ≥1. */
  targets: ResolvedTarget[];
}

export interface LifecycleWorkflowParams {
  eventId: string;
  type: string;
  subtype?: string;
  channelId?: string;
  userId?: string;
  teamId?: string;
  /** Display name extracted from the Slack envelope at classify time (team_join only). */
  displayName?: string | null;
  raw: Record<string, unknown>;
}

/**
 * CancelWorkflow input — a human tapped the 🛑 stop reaction on a trigger
 * message. Carries the reacted message's coordinates (`channelId` + `ts`) so the
 * workflow can look up that message's pending fan-out, plus the reactor (`userId`,
 * so the gatekeeper's own initial 🛑 can be filtered out).
 */
export interface CancelWorkflowParams {
  /** The reaction event's own Slack `event_id` (dedupe key for Slack retries). */
  eventId: string;
  channelId: string;
  /** `ts` of the reacted-to (trigger) message. */
  ts: string;
  /** Slack user who added the reaction. */
  userId: string;
  teamId?: string;
}

/**
 * Params for the parallel ReactionWorkflow that owns the 🛑 stop reaction on a
 * trigger message: added inline by the webhook handler on receipt, removed once
 * the fan-out has drained (or on a timeout backstop). Keyed off the same Slack
 * `eventId` as the MessageWorkflow.
 */
export interface ReactionWorkflowParams {
  eventId: string;
  channelId: string;
  /** Timestamp of the trigger message to react to. */
  ts: string;
}

// ---------------------------------------------------------------------------
// Classification — the routing verdict produced by classifyEvent()
// ---------------------------------------------------------------------------

export type Classification =
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; params: ClassifiedMessageParams }
  | { kind: "lifecycle"; params: LifecycleWorkflowParams }
  | { kind: "cancel"; params: CancelWorkflowParams }
  | { kind: "ignore"; reason: string }
  /**
   * Malformed delivery — acked with a 4xx rather than a 200, so the failure is
   * visible in Slack's app dashboard instead of silently swallowed. Distinct from
   * `ignore`, which is a well-formed event we simply have no interest in.
   */
  | { kind: "invalid"; reason: string };
