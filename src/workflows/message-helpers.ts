import type { WorkflowStep } from "cloudflare:workers";
import type { MessageWorkflowParams } from "@/slack/types";
import { buildUserAuthContext } from "@/auth";
import {
  cancelAgentTask,
  dispatchToAgent,
  type DispatchAgentRef,
  type DispatchMetadata,
  type DispatchResult
} from "@/agents/dispatch";
import { InvalidEndpointError } from "@/a2a/endpoint";
import {
  getPendingAgentTasksByEventId,
  markAgentTaskCanceled,
  markCancelRequested,
  type AgentTaskRow
} from "@/db/models/agent-tasks";
import { getAgent } from "@/db/models/agents";
import { cancelHitlRequestsByToken } from "@/db/models/hitl-requests";
import { markHitlPromptResolved } from "@/a2a/notifications/hitl";
import { renderEditDiff } from "@/util/text-diff";
import { postReply } from "@/wrappers/slack";
import { signalReactionSync } from "@/workflows/reaction-helpers";

// Shown when a dispatch's retries are fully exhausted (persistently unreachable
// endpoint, TLS/DNS failure, persistent 5xx, accept timeout). Not transient by
// the time we get here, so the user should know rather than see silence.
export const AGENT_UNREACHABLE_BASE_TEXT =
  "This agent couldn't be reached after several attempts. It may be down or misconfigured, please contact the agent developer.";
const MAX_UNREACHABLE_ERROR_TEXT_LENGTH = 240;

function unreachableErrorText(error: string): string {
  const normalized = error.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= MAX_UNREACHABLE_ERROR_TEXT_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_UNREACHABLE_ERROR_TEXT_LENGTH - 3)}...`;
}

export function agentUnreachableText(agentName: string, error: string): string {
  const base = agentName
    ? `${AGENT_UNREACHABLE_BASE_TEXT} (Agent: *${agentName}*.)`
    : AGENT_UNREACHABLE_BASE_TEXT;
  const reason = unreachableErrorText(error);
  return reason ? `${base} Last error: ${reason}` : base;
}

// One agent's resolved dispatch target (must be Rpc.Serializable).
export interface AgentPlan {
  agent: DispatchAgentRef;
  /** Workspace scope of the agent; null = org-wide (onboarding). */
  workspaceId: number | null;
  text: string;
  /** Channel display name, resolved once in resolveMessage for the fan-out. */
  channelName: string | null;
  // No display name / icon here: the workflow only dispatches, it never posts an
  // agent's reply. Rendering identity is resolved at the delivery boundary
  // (`agentRenderIdentity`) from the agent row current when the reply lands.
  user: Awaited<ReturnType<typeof buildUserAuthContext>>;
}

// ---------------------------------------------------------------------------
// Pure steps — called by MessageWorkflow and exported for tests.
// ---------------------------------------------------------------------------

/**
 * Return the thread_ts to reply into, or null to post at channel level.
 * A real thread reply has a thread_ts that differs from the message's own ts.
 */
export function replyThreadTs(p: MessageWorkflowParams): string | null {
  return p.threadTs && p.threadTs !== p.ts ? p.threadTs : null;
}

/**
 * Render the body fanned out to agents. Plain turns carry the user text; edits
 * and deletes become a feed turn describing the change so agents stay aware of
 * the evolving channel reality (A2A has no edit/delete primitive).
 *
 * Edits send only a compact diff (the agent already holds the prior message in
 * session), not both full bodies — see {@link renderEditDiff}.
 */
export function feedText(p: MessageWorkflowParams): string {
  if (p.editKind === "deleted") {
    return `[deleted a message (ts ${p.ts})] ${p.prevText ?? ""}`.trim();
  }
  if (p.editKind === "edited") {
    const diff = renderEditDiff(p.prevText ?? "", p.text);
    return `[edited a message (ts ${p.ts})] changed:\n${diff}`;
  }
  return p.text;
}

/** Build dispatch plans from the targets resolved in the handler + auth context. */
export async function resolveMessage(
  p: MessageWorkflowParams
): Promise<AgentPlan[]> {
  const targets = p.targets;
  if (targets.length === 0) return [];

  // `userId` is guaranteed by the classifier (message events without a sender
  // are ignored), so every caller has an auth context — unknown users get a
  // zero-permission one rather than null.
  const user = await buildUserAuthContext(p.userId);
  return targets.map((t) => ({
    agent: {
      name: t.agent.name,
      kind: t.agent.kind,
      a2aEndpoint: t.agent.a2aEndpoint,
      tenantId: t.agent.tenantId,
      workspaceId: t.agent.workspaceId
    },
    workspaceId: t.workspaceId,
    text: feedText(p),
    channelName: t.channelName,
    user
  }));
}

/**
 * Dispatch one resolved plan to its agent over A2A. Every agent accepts a Task
 * (`{ kind: "accepted" }`) and delivers status snapshots later: remote agents
 * through the authenticated callback and built-ins through the trusted local
 * sender.
 *
 * Retry policy. Two kinds of verdict are deterministic and must NOT be retried:
 * a rejected endpoint (`InvalidEndpointError`, caught here) and a permanent A2A
 * protocol refusal, which `sendA2A*` already folds into a returned `error_reply`
 * rather than a throw — re-sending an identical request earns an identical
 * refusal, so retrying only delays a specific message behind a generic
 * "unreachable" one. Everything else (network blip, accept timeout, an agent's
 * own `INTERNAL_ERROR`) is thrown so the `dispatch` step retries — which is safe
 * because the dispatch id is deterministic (`buildDispatchId`), so a re-send
 * carries the same A2A `messageId` and push `token`; a conformant remote dedupes
 * on the `messageId` instead of appending the turn twice, giving at-least-once
 * delivery with exactly-once effect.
 */
export async function dispatchMessage(
  p: MessageWorkflowParams,
  plan: AgentPlan
): Promise<DispatchResult> {
  // Per-agent extras only. *Which* agent this is comes from `tenantId`, the same
  // field the dispatcher routes on; `kind` only says whether it runs in-process.
  let metadata: DispatchMetadata;
  const local = plan.agent.kind === "local";
  if (local && plan.agent.tenantId === "admin") {
    if (plan.workspaceId == null) {
      throw new Error("BUG: admin agent resolved without a workspaceId");
    }
    metadata = {
      agentKind: "local",
      tenant: "admin",
      adminWorkspaceId: plan.workspaceId
    };
  } else if (local && plan.agent.tenantId === "onboarding") {
    metadata = { agentKind: "local", tenant: "onboarding" };
  } else {
    const { workspaceId } = plan;
    if (workspaceId == null) {
      throw new Error("BUG: remote agent resolved without a workspaceId");
    }
    metadata = {
      agentKind: "remote",
      tenant: plan.agent.tenantId,
      workspaceId
    };
  }

  try {
    return await dispatchToAgent(plan.agent, {
      eventId: p.eventId,
      text: plan.text,
      channelId: p.channelId,
      channelName: plan.channelName,
      threadTs: p.threadTs || p.ts,
      messageTs: p.ts,
      user: plan.user,
      metadata
    });
  } catch (err) {
    if (err instanceof InvalidEndpointError) {
      // Policy rejection — not transient, so don't let the step retry.
      console.warn("[message] agent endpoint rejected", {
        agent: plan.agent.name,
        err: err.message
      });
      return {
        kind: "error_reply",
        text: `The agent *${plan.agent.name}* could not be reached because its endpoint was rejected by the security policy: ${err.message}. Please contact the agent developer to resolve this.`
      };
    }
    throw err; // transient — retry is safe (deterministic dispatch id dedupes)
  }
}

/**
 * Collect (remove) the 🛑 reaction only once the whole fan-out for a trigger
 * event has drained — i.e. no non-terminal task remains for it. A single Slack
 * message can wake several agents; each finishes independently, so the reaction
 * must linger until the *last* one is terminal (otherwise it clears on the first
 * completion and the user loses the ability to stop the rest). Called at every
 * point a task leaves the pending set: a terminal delivery, and the end of the
 * MessageWorkflow (after non-accepts/unreachables have been unrecorded).
 *
 * Race note: this is only reliable because every fan-out row is recorded up front
 * (before any dispatch), so a fast terminal callback can never observe an
 * incomplete sibling set and drain early.
 *
 * The drain check is also what keeps the signal honest. The ReactionWorkflow
 * measures its processing budget with its own timer, so it must only ever be
 * woken at a real leg boundary — signalling on *every* completion would hand a
 * slow sibling a fresh hour each time a fast one finished. Hence the guard: no
 * signal until nothing is left.
 */
export async function collectIfEventDrained(eventId: string): Promise<void> {
  const pending = await getPendingAgentTasksByEventId(eventId);
  if (pending.length === 0) {
    await signalReactionSync(eventId);
  }
}

/**
 * What happened to one task when we tried to stop it.
 * - `stopped`     — canceled, already terminal, unknown to the agent, or intent
 *                   recorded for a not-yet-accepted task (all "it will stop / is
 *                   stopped" from the user's view).
 * - `unsupported` — the agent doesn't implement cancellation; it keeps running.
 * - `error`       — a transport/other failure; the agent may keep running.
 *
 * All three terminalize the row (see {@link cancelAndReconcile}); the distinction
 * only decides what the user is told.
 */
export type CancelRowKind = "stopped" | "unsupported" | "error";

/**
 * Ask an agent to stop `taskId`, then mark the row `canceled` — **whatever the
 * agent answered**.
 *
 * Cancellation is *attempted*, not guaranteed (A2A §7.5): on `unsupported` or
 * `error` the agent may well run to completion and deliver. This used to leave
 * the row `pending` so that late reply still reached Slack. It no longer does. A
 * stop is a decision about whether the user wants the answer at all, so once one
 * is issued the task is over here: the row goes terminal, and the reply — if it
 * ever arrives — is dropped at the notification boundary with a 200 (which also
 * stops the remote's retry ladder rather than inviting it to hammer us).
 *
 * The kind is still returned, because "we stopped it" and "it refused to stop"
 * are different things to *say*, even though the ledger treats them alike.
 */
export async function cancelAndReconcile(
  agent: DispatchAgentRef,
  taskId: string,
  token: string
): Promise<CancelRowKind> {
  const outcome = await cancelAgentTask(agent, taskId);
  await markAgentTaskCanceled(token);
  switch (outcome.kind) {
    case "canceled":
    case "not_cancelable":
    case "not_found":
      return "stopped";
    case "unsupported":
      return "unsupported";
    case "error":
      return "error";
  }
}

/**
 * Notice posted when a stop wasn't honored — for both `unsupported` and `error`.
 * The cause differs but the user-visible consequence is identical, and the
 * gatekeeper shouldn't leak transport detail into the thread.
 *
 * Says the reply is discarded rather than promising it will arrive: the row is
 * terminal from the moment the stop was issued, so a reply the agent still
 * produces never reaches this thread.
 */
export function cancelNotHonoredText(agentName: string): string {
  return `*Agent ${agentName}* couldn't be stopped mid-run. It may keep running, but its reply will be discarded.`;
}

/** Why a task was stopped. Recorded in the log line — the ledger keeps only `canceled`. */
export type CancelReason = "user" | "task-timeout";

/** Who or what issued a stop, for the one log line that records it. */
export interface CancelOrigin {
  reason: CancelReason;
  /** Slack user id that tapped 🛑; null when the gatekeeper timed the task out. */
  actorUserId: string | null;
}

/**
 * Stop one non-terminal task via the standard A2A `tasks/cancel`, reconciling the
 * gatekeeper ledger from the (synchronous) response — a conformant agent sends no
 * push callback after cancellation, so the gatekeeper is the source of truth here.
 *
 * Shared by both triggers: a human's 🛑 (`CancelWorkflow`) and the gatekeeper's own
 * processing-deadline cancel (`ReactionWorkflow`). They differ only in what the
 * user is told and in the `origin` recorded below.
 *
 * Handles the taskId race: if the accept hasn't returned a taskId yet, record a
 * `cancelRequested` intent instead. If that atomic mark reveals the accept just
 * committed (taskId now present), cancel directly; otherwise the dispatch's
 * accept path honors the intent. Exactly one cancel fires either way.
 *
 * Exported for unit testing.
 */
export async function cancelTaskRow(
  row: AgentTaskRow,
  origin: CancelOrigin
): Promise<CancelRowResult> {
  // The only record of *who* stopped a task: the actor is not a column, and the
  // ledger keeps a single `canceled` status for both triggers.
  console.log("[cancel] canceling task", {
    reason: origin.reason,
    actorUserId: origin.actorUserId,
    agent: row.agentName,
    token: row.token,
    taskId: row.taskId,
    eventId: row.eventId,
    channelId: row.channelId,
    messageTs: row.messageTs
  });

  const agent = await getAgent(row.agentName);
  if (!agent) {
    // Agent deregistered mid-flight — nothing to cancel; reconcile the row.
    await markAgentTaskCanceled(row.token);
    return { agentName: row.agentName, kind: "stopped" };
  }
  const ref: DispatchAgentRef = {
    name: agent.name,
    kind: agent.kind,
    a2aEndpoint: agent.a2aEndpoint,
    tenantId: agent.tenantId,
    workspaceId: agent.workspaceId
  };

  let taskId = row.taskId;
  if (!taskId) {
    const mark = await markCancelRequested(row.token);
    // Row completed/purged between resolve and now, or intent recorded for a
    // task whose taskId is still unknown → the accept path (dispatch) honors it.
    if (!mark.matched || !mark.taskId) {
      return { agentName: row.agentName, kind: "stopped" };
    }
    taskId = mark.taskId; // accept raced in — cancel directly now
  }

  const kind = await cancelAndReconcile(ref, taskId, row.token);

  // Close any human-in-the-loop prompt the task had open (the stop supersedes it),
  // and strip its now-dead buttons in Slack. Independent of the cancel outcome:
  // the run is over, so the pending question no longer stands.
  const canceledPrompts = await cancelHitlRequestsByToken(row.token);
  for (const prompt of canceledPrompts) {
    await markHitlPromptResolved(prompt, "🛑 Canceled.");
  }

  return { agentName: row.agentName, kind };
}

/** What one row's cancel attempt produced, for the caller's user-facing summary. */
export interface CancelRowResult {
  agentName: string;
  kind: CancelRowKind;
}

/**
 * Result of running one agent's dispatch + reply within the fan-out. The task
 * catches every *expected* failure and reports it here (rather than rejecting)
 * so the workflow can react precisely instead of collapsing everything into a
 * single "dispatch failed" notice.
 *
 * - `accepted`      — the agent took the turn and will deliver its reply later;
 *                     the 🛑 must linger until its callback (or backstop) clears it.
 * - `done`          — handled fully now (sync reply posted, silence, or a policy
 *                     error notice posted); nothing is still working.
 * - `unreachable`   — the `dispatch` step itself exhausted retries; the user
 *                     should see `agentUnreachableText(...)`.
 * - `internal_error`— the agent responded but a later step (usually the Slack
 *                     post) exhausted retries; distinct from unreachable.
 */
export type TaskOutcome =
  | { kind: "accepted" }
  | { kind: "done" }
  | { kind: "unreachable"; error: string }
  | { kind: "internal_error"; error: string };

/**
 * Post the "agent unreachable" notice and dispatch-failed error handling the
 * workflow runs when a task returns `{ kind: "unreachable" }`.
 */
export async function handleUnreachable(
  step: WorkflowStep,
  p: MessageWorkflowParams,
  threadTs: string | null,
  agentName: string,
  error: string
): Promise<void> {
  console.error("[message] agent dispatch failed", {
    agent: agentName,
    error
  });
  try {
    await step.do(`dispatch-failed:${agentName}`, () =>
      postReply(
        p.channelId,
        threadTs,
        agentUnreachableText(agentName, error),
        null,
        null
      )
    );
  } catch (postErr) {
    console.error("[message] failed to post unreachable notice", {
      agent: agentName,
      error: postErr instanceof Error ? postErr.message : String(postErr)
    });
  }
}
