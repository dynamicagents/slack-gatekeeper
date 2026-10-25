import type { WorkflowStep } from "cloudflare:workers";
import type {
  ClassifiedMessageParams,
  MessageWorkflowParams
} from "@/slack/types";
import { buildUserAuthContext } from "@/auth";
import { env } from "cloudflare:workers";
import {
  cancelAgentTask,
  dispatchToAgent,
  joinAgentTask,
  type DispatchAgentRef,
  type DispatchMetadata,
  type DispatchPayload,
  type DispatchResult,
  type JoinOutcome
} from "@/a2a/dispatch";
import { InvalidEndpointError } from "@/a2a/endpoint";
import {
  getOpenAgentTaskInThread,
  getPendingAgentTasksByEventId,
  markAgentTaskCanceled,
  markCancelRequested,
  STARTED_BY_PROCESS,
  type AgentTaskRow
} from "@/db/models/agent-tasks";
import { getAgent } from "@/db/models/agents";
import { closeOpenHitlPrompts } from "@/a2a/notifications/hitl";
import { renderEditDiff } from "@/util/text-diff";
import { addReaction, postReply } from "@/wrappers/slack";
import {
  reactionInstanceId,
  signalReactionSync,
  STOP_REACTION
} from "@/workflows/reaction-helpers";

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

function agentUnreachableText(agentName: string, error: string): string {
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
 *
 * Takes the classifier params rather than the workflow's, so the webhook handler
 * can place a notice about an event in the same thread the event's replies land in
 * — before any target has been resolved for it.
 */
export function replyThreadTs(p: ClassifiedMessageParams): string | null {
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

/**
 * Who to mention if a task from this turn later stops to ask a person something
 * — an approval to decide or words to answer — recorded on the task row at
 * dispatch (`agent_tasks.started_by`).
 *
 * A plain turn was sent by somebody, so the work is theirs and so is the
 * question, and `p.userId` is that person: the classifier ignores a message
 * event without a user id, so it is always a real id from the signature-verified
 * envelope.
 *
 * A feed turn is nobody's: {@link feedText}'s edit and delete both carry the
 * *authored* message's user rather than the actor's (see `messageEditFromEvent`),
 * so on a delete it is whoever wrote the message, not whoever removed it.
 * Mentioning them would wake someone who did nothing, so such a turn records
 * {@link STARTED_BY_PROCESS} — the gatekeeper fed the turn in, and no sentinel is
 * ever rendered as a mention.
 */
export function startedBy(p: MessageWorkflowParams): string {
  return p.editKind ? STARTED_BY_PROCESS : p.userId;
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
 * Dispatch one resolved plan to its agent over A2A. Every agent — remote or
 * built-in — accepts a Task (`{ kind: "accepted" }`) and delivers status
 * snapshots later through the authenticated callback.
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
  try {
    return await dispatchToAgent(plan.agent, payloadFor(p, plan));
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

/** The thread a message belongs to, as dispatch keys its A2A context. */
export function threadKeyOf(
  p: Pick<MessageWorkflowParams, "threadTs" | "ts">
): string {
  return p.threadTs || p.ts;
}

/**
 * How long a message waits for a task in its thread to finish being accepted:
 * past one dispatch attempt's accept timeout (`ACCEPT_TIMEOUT_MS` in
 * `src/a2a/client.ts`), with room to spare.
 */
const ACCEPT_WAIT_MS = 45_000;
const ACCEPT_POLL_MS = 500;

/**
 * The open task each plan's agent already has in this message's thread, or
 * `null` where it has none: the message joins those, and starts a task only
 * for the rest. A task still waiting on its accept (no task id yet) is waited
 * for, bounded, so two quick messages do not start two tasks; one that never
 * gets its id in time is passed over.
 */
export async function openTasksFor(
  p: MessageWorkflowParams,
  plans: AgentPlan[]
): Promise<(Pick<AgentTaskRow, "token" | "taskId" | "eventId"> | null)[]> {
  const threadKey = threadKeyOf(p);
  return Promise.all(
    plans.map(async (plan) => {
      const deadline = Date.now() + ACCEPT_WAIT_MS;
      for (;;) {
        const row = await getOpenAgentTaskInThread(
          plan.agent.name,
          p.channelId,
          threadKey
        );
        if (!row) return null;
        if (row.taskId) {
          return { token: row.token, taskId: row.taskId, eventId: row.eventId };
        }
        if (Date.now() >= deadline) return null;
        await scheduler.wait(ACCEPT_POLL_MS);
      }
    })
  );
}

/**
 * Send a message onto an agent's open task. An endpoint the policy now
 * rejects, like any refusal, starts a task instead, where the rejection is
 * said in the thread.
 */
export async function joinMessage(
  p: MessageWorkflowParams,
  plan: AgentPlan,
  row: Pick<AgentTaskRow, "token" | "taskId">
): Promise<JoinOutcome> {
  try {
    return await joinAgentTask(plan.agent, row, payloadFor(p, plan));
  } catch (err) {
    if (err instanceof InvalidEndpointError) return "refused";
    throw err;
  }
}

/**
 * Put the 🛑 on the trigger message and start its ReactionWorkflow, for a
 * message that starts a task after the handler gave it neither: its join was
 * refused, or the task it would have joined closed in between. Both are
 * idempotent, so a delivery that races the handler's repeats nothing. The 🛑
 * is best-effort, as the handler's is; a workflow that would not start throws,
 * so the step tries again: without it the task has no deadline.
 */
export async function ensureStopReaction(
  p: MessageWorkflowParams
): Promise<void> {
  try {
    await addReaction(p.channelId, p.ts, STOP_REACTION);
  } catch (err) {
    console.warn("[message] could not add the stop reaction", {
      eventId: p.eventId,
      err: String(err)
    });
  }
  try {
    await env.REACTION_WORKFLOW.create({
      id: reactionInstanceId(p.eventId),
      params: { eventId: p.eventId, channelId: p.channelId, ts: p.ts }
    });
  } catch (err) {
    if (!/already exists/i.test(String(err))) throw err;
  }
}

/** What one plan's dispatch or join sends: the turn, where it goes, for whom. */
function payloadFor(
  p: MessageWorkflowParams,
  plan: AgentPlan
): DispatchPayload {
  // *Which* agent this is comes from `tenantId`, the same field the dispatcher
  // routes on; `kind` only says whether it is one of this Worker's own tenants.
  let metadata: DispatchMetadata;
  const local = plan.agent.kind === "local";
  if (
    local &&
    (plan.agent.tenantId === "admin" || plan.agent.tenantId === "onboarding")
  ) {
    metadata = { agentKind: "local", tenant: plan.agent.tenantId };
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

  return {
    eventId: p.eventId,
    text: plan.text,
    channelId: p.channelId,
    channelName: plan.channelName,
    threadTs: threadKeyOf(p),
    messageTs: p.ts,
    user: plan.user,
    metadata
  };
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
 * Race note: every fan-out row is recorded before any dispatch, so a fast
 * terminal callback can never observe an incomplete sibling set of dispatched
 * tasks. The rows are recorded after the message's joins, which can take
 * minutes against an agent slow to answer, so the MessageWorkflow says when it
 * is done (`routed`), and until then, or until it stops running, the
 * ReactionWorkflow does not read nothing open as drained.
 *
 * The drain check keeps the signal to the one the workflow needs: every signal
 * ends a leg, and one per completion would end a leg each time a fast sibling
 * finished.
 */
export async function collectIfEventDrained(
  eventId: string,
  { routed = false }: { routed?: boolean } = {}
): Promise<void> {
  const pending = await getPendingAgentTasksByEventId(eventId);
  if (pending.length === 0) {
    await signalReactionSync(eventId, routed ? { routed } : {});
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
  token: string,
  channelId: string
): Promise<CancelRowKind> {
  const outcome = await cancelAgentTask(agent, taskId, channelId);
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

  const kind = await cancelAndReconcile(ref, taskId, row.token, row.channelId);

  // Close any human-in-the-loop prompt the task had open (the stop supersedes it),
  // and strip its now-dead buttons in Slack. Independent of the cancel outcome:
  // the run is over, so the pending question no longer stands.
  await closeOpenHitlPrompts(row.token, "🛑 Canceled.");

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
