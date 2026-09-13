import { AgentEvent } from "@a2a-js/sdk/server";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message } from "@a2a-js/sdk";
import type {
  FinishReason,
  GenerateTextOnStepEndCallback,
  LanguageModel,
  ModelMessage,
  OnToolExecutionEndCallback,
  PrepareStepFunction,
  StopCondition,
  ToolApprovalConfiguration,
  ToolSet
} from "ai";
import {
  APICallError,
  generateText,
  isStepCount,
  RetryError,
  ToolChoiceViolationError
} from "ai";
import { CHAT_CALL_OPTIONS, type GatewayCallMetadata } from "@/agents/model";
import { buildMessage, textOf, textPart } from "@/a2a/parts";
import { buildHitlRequestParts, type HitlRequest } from "@/a2a/hitl";
import type { AgentTurnMetadata } from "@/agents/dispatch";
import { startTurnLog, type ModelCallLike } from "./turn-log";
import type { SessionLike } from "./session";
import {
  assistantSessionMessage,
  replayToolCallMessage,
  toModelMessages,
  toolCallSessionMessage,
  userSessionMessage,
  type ToolRecord
} from "./messages";
import {
  FINAL_REPLY_CONTRACT,
  FINAL_REPLY_TOOL_NAME,
  FINAL_ROUND_CONTRACT,
  finalReplyInputSchema,
  finalReplyTool
} from "./final-reply";
import { ASK_USER_TOOL_NAME } from "./ask-user";
import {
  answeredCall,
  approvedCall,
  hitlRequestOf,
  openCallOf,
  humanAnswerOf,
  refusalReason,
  refusedCall,
  settledCall,
  wasApproved,
  withRefusal,
  type OpenCallStore
} from "./open-call";

/**
 * How many model calls one turn may spend.
 *
 * Under the forced ending the last of them is not a work step — it is the answer
 * (see `endingStep`), so nine steps do the work and the tenth reports it. The
 * reservation is the point: a budget that simply ran out would discard everything
 * the turn did and apologize for an outage that never happened.
 */
const MAX_STEPS = 10;

const TRANSIENT_REPLY =
  "The AI service is temporarily unavailable. Please try again in a moment.";

/** Recorded in history when a turn is stopped, so it doesn't read as unanswered. */
const CANCELED_NOTE = "(stopped by the user; reply was not delivered)";

/**
 * Recorded when a turn ran tools but never produced a reply. The apology the user
 * sees is not persisted — it says nothing true about the workspace — but the calls
 * did run, and a side effect the transcript does not show is exactly how a later
 * turn ends up guessing.
 */
const NO_REPLY_NOTE =
  "(no reply was produced for this turn; the actions above did run)";

/** Recorded for an approved call a 🛑 reached before it could run. */
const STOPPED_BEFORE_RUN =
  "Not carried out: the turn was stopped before the approved call could run.";

/** Recorded for an approved call that did not run, and left no reason why. */
const NOT_CARRIED_OUT = "Not carried out.";

/**
 * The reply a forced-ending call landed on, or `undefined` if it produced none.
 *
 * `staticToolCalls` holds only calls whose input passed the tool's own schema: the
 * SDK validates every call, marks a rejected one `dynamic`, and this getter filters
 * those out. So a call found here is already valid, and the parse below is how its
 * input is read back *with a type* rather than a second check — it is the same
 * schema object `finalReplyTool` declares, so the two cannot disagree.
 *
 * Typed by what it reads rather than as `GenerateTextResult`, whose three type
 * parameters describe a tool set this turn only assembles at runtime — and so that
 * the one-tool salvage call can be read by the same function.
 */
function readFinalReply(result: {
  finalStep: {
    staticToolCalls: readonly { toolName: string; input: unknown }[];
  };
}): string | undefined {
  const calls = result.finalStep.staticToolCalls.filter(
    (c) => c.toolName === FINAL_REPLY_TOOL_NAME
  );
  if (calls.length === 0) return undefined;
  // The last call of a repeated set: a model that restated its answer meant the
  // restatement.
  const parsed = finalReplyInputSchema.safeParse(calls[calls.length - 1].input);
  return parsed.success ? parsed.data.text.trim() : undefined;
}

/**
 * The reply a plain-text turn landed on. `length` means the model was cut off
 * mid-sentence, which is not an answer however much of one it looks like.
 */
function readPlainReply(result: {
  text: string;
  finishReason: FinishReason;
}): string | undefined {
  const text = result.text.trim();
  return text.length > 0 && result.finishReason !== "length" ? text : undefined;
}

/**
 * The reason the SDK gave for refusing to carry out an approved call.
 *
 * A replayed approval whose policy now says `denied` never executes: the SDK writes
 * an `execution-denied` result into the messages it puts *before* the first step,
 * and no tool-execution event fires. That result carries the policy's own sentence,
 * which is a better account of what happened than anything this layer could infer —
 * the approver's permissions changed, the target moved, the key rotated again.
 *
 * Typed structurally: these are the SDK's own response messages, and reaching into
 * them for one field does not warrant threading its generics through this layer.
 */
function deniedReason(result: {
  responseMessages: readonly { role: string; content: unknown }[];
}): string | undefined {
  for (const message of result.responseMessages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const output = (part as { output?: { type?: string; reason?: string } })
        .output;
      if (output?.type === "execution-denied") return output.reason;
    }
  }
  return undefined;
}

/**
 * Whether a failure is the service being briefly unavailable rather than a bug —
 * the difference between "try again in a moment" and an apology.
 *
 * The SDK decides this now, not us. The provider normalizes a binding failure into
 * an `APICallError` carrying an HTTP status, and `isRetryable` is exactly the
 * question being asked here (429, 408, 409, 5xx). A failure the SDK retried arrives
 * wrapped, and the wrapper's own message ("Failed after N attempts") carries none of
 * that signal, so unwrap before classifying.
 *
 * One known gap: Workers AI code 3046 is missing from the provider's code→status
 * table, so it reaches us with no status at all and reads as permanent. That used to
 * be caught by matching the message text — which also matched any error that merely
 * mentioned the number. Fixing it belongs upstream, in the table, not here.
 */
export function isTransientAiError(err: unknown): boolean {
  if (RetryError.isInstance(err)) return isTransientAiError(err.lastError);
  if (APICallError.isInstance(err)) return err.isRetryable;
  return false;
}

/** What to log as the model. A `LanguageModel` may be a bare model-id string. */
function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/**
 * The workspace a turn belongs to, whichever half of the union carries it.
 *
 * A local admin turn spells it `adminWorkspaceId` and a remote one `workspaceId`
 * ({@link AgentTurnMetadata}); the onboarding concierge has no workspace at all,
 * because it runs per user. Read here rather than in each executor's `prepare`,
 * which narrows the union but keeps the result in its own closure — and this is
 * needed before `prepare` runs, so a turn that fails inside it still says where.
 */
function workspaceIdOf(
  metadata: Partial<AgentTurnMetadata>
): number | undefined {
  if ("adminWorkspaceId" in metadata) return metadata.adminWorkspaceId;
  if ("workspaceId" in metadata) return metadata.workspaceId;
  return undefined;
}

/**
 * What an executor labels a turn's model calls with, for the AI Gateway log.
 *
 * Here rather than in each executor because it reads the same wire metadata this
 * module already reads, off the same request — and because an executor has to
 * build its model *before* `executeAgentTurn` runs, which is before its own
 * `prepare` has narrowed anything.
 */
export function turnGatewayMetadata(
  requestContext: RequestContext
): GatewayCallMetadata {
  const metadata = (requestContext.userMessage.metadata ??
    {}) as Partial<AgentTurnMetadata>;
  return {
    call: "turn",
    tenant: metadata.tenant,
    workspaceId: workspaceIdOf(metadata),
    contextId: requestContext.contextId,
    user: metadata.user?.slackUserId
  };
}

/** What an agent assembles for a single turn (inside the protected body). */
export interface PreparedTurn {
  /** The Durable Object's one Session (history + soul + memory). */
  session: SessionLike;
  /** Per-request system-prompt suffix (caller context). Advisory. */
  systemSuffix: string;
  /** Agent-specific tools merged over the session's own `set_context` tool. */
  tools: ToolSet;
  /**
   * Which calls need a human's Approve before they run, as a per-tool policy the
   * SDK resolves on every call — see
   * {@link file://../admin/tools.ts `adminToolApproval`}.
   *
   * Built per turn from the caller, so the SDK re-running it on the resuming turn
   * re-checks the *approver's* permissions rather than the requester's. The tools
   * it names are also the ones a timed-out turn may no longer call: see `withheld`.
   */
  toolApproval?: ToolApprovalConfiguration<ToolSet, unknown>;
}

export interface AgentTurnConfig {
  /**
   * The one model a turn runs on. It carries its own fallback — see
   * {@link file://../model-fallback-middleware.ts model-fallback-middleware.ts} —
   * so a second model is not this layer's concern.
   */
  model: LanguageModel;
  /**
   * Assemble the session/tools/system for this turn. Runs *inside* the protected
   * body, so throwing here (e.g. missing required metadata) yields the friendly
   * error reply rather than a crash.
   */
  prepare: (
    text: string,
    metadata: Partial<AgentTurnMetadata>
  ) => Promise<PreparedTurn>;
  /** Friendly reply for an unexpected (non-transient) failure. */
  unexpectedReply: string;
  /**
   * Whether a 🛑 has been recorded for this turn, keyed by the dispatch token
   * (the A2A `messageId`). Consulted between tool-calling steps; `true` ends the
   * turn with no reply. Optional so a unit test can drive a turn nothing stops.
   */
  isCanceled?: (token: string) => Promise<boolean>;
  /**
   * Make the turn end in a `final_reply` tool call instead of in plain text, with
   * `toolChoice: "required"` on every working step and the ending *named* on the
   * last. Prose stops being an outcome, so a model that narrates an action and
   * stops fails its attempt rather than shipping the narration as an answer — see
   * {@link file://./final-reply.ts final-reply.ts}.
   *
   * Off by default: an agent that has not opted in keeps the plain-text ending.
   */
  requireFinalReply?: boolean;
  /**
   * Persist the tool calls the turn actually made into session history alongside
   * the reply, so a later turn can see what really happened rather than only what
   * this one claimed. Off by default. See {@link assistantSessionMessage}.
   */
  recordToolCalls?: boolean;
  /**
   * Where a turn that stops for a human keeps the call it paused on, until the
   * answer resumes it — see {@link file://./open-call.ts open-call.ts}. Needed by
   * any agent whose tools include `ask_user` or a tool behind an approval: a turn
   * that has to pause without one fails, because the prompt it would raise could
   * never be answered.
   */
  openCalls?: OpenCallStore;
}

function agentMessage(
  requestContext: RequestContext,
  messageId: string,
  parts: Message["parts"]
): Message {
  return buildMessage({
    messageId,
    role: Role.ROLE_AGENT,
    parts,
    taskId: requestContext.taskId,
    contextId: requestContext.contextId
  });
}

/**
 * Publish the initial `submitted` Task. Every A2A v1.0 execution MUST open with
 * a `task` or `message` event — the server rejects a stream that starts with a
 * status update — and events are wrapped in the discriminated `AgentEvent`
 * envelope rather than published as bare objects.
 */
function publishSubmitted(
  eventBus: ExecutionEventBus,
  requestContext: RequestContext
): void {
  eventBus.publish(
    AgentEvent.task({
      id: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: undefined
      },
      artifacts: [],
      history: [],
      metadata: undefined
    })
  );
}

/**
 * Publish a status update. v1.0 dropped `TaskStatusUpdateEvent.final`: the state
 * itself now says whether the stream is over, so a terminal (or interrupted)
 * state closes the turn and `working` keeps it open.
 */
function publishStatus(
  eventBus: ExecutionEventBus,
  requestContext: RequestContext,
  parts: Message["parts"],
  messageId: string,
  state: TaskState
): void {
  eventBus.publish(
    AgentEvent.statusUpdate({
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state,
        message: agentMessage(requestContext, messageId, parts),
        timestamp: undefined
      },
      metadata: undefined
    })
  );
}

/**
 * End the turn in `input-required`, carrying the HITL request data part (plus
 * its text-part fallback). The state is *interrupted*, not terminal: it closes
 * this interaction's event stream while leaving the task resumable on a later
 * invocation when the human answers. The delivery boundary detects the data
 * part and renders it as an interactive Slack prompt (see `deliverHitlRequest`).
 */
function publishInputRequired(
  eventBus: ExecutionEventBus,
  requestContext: RequestContext,
  request: HitlRequest,
  messageId: string
): void {
  publishStatus(
    eventBus,
    requestContext,
    buildHitlRequestParts(request),
    messageId,
    TaskState.TASK_STATE_INPUT_REQUIRED
  );
}

/**
 * The generic agent turn shared by every in-repo agent: append the user message,
 * run **one** Workers-AI `generateText` tool loop over the Session history, persist
 * + publish the final reply, and always `finished()`. Agent-specific behavior
 * (which session, which tools, which caller context) is supplied by `cfg.prepare`.
 *
 * One call, because the SDK's loop already owns everything this used to re-implement
 * around it: a rejected ending comes back to the model as a failed tool result on the
 * next step, the forced final round is that loop's last step, and an unreachable
 * model is answered a layer down by the model's own fallback. The single exception is
 * `salvageEnding` below, for a turn the loop leaves with no answer at all.
 */
export async function executeAgentTurn(
  requestContext: RequestContext,
  eventBus: ExecutionEventBus,
  cfg: AgentTurnConfig
): Promise<void> {
  const userMessage = requestContext.userMessage;
  const text = textOf(userMessage);
  const metadata = (userMessage.metadata ?? {}) as Partial<AgentTurnMetadata>;
  const modelId = modelIdOf(cfg.model);
  // Opened before anything can fail, and flushed in the `finally`, so a turn that
  // throws on its first await still reports what it was and how long it took.
  const turnLog = startTurnLog({
    contextId: requestContext.contextId,
    taskId: requestContext.taskId,
    tenant: metadata.tenant,
    workspaceId: workspaceIdOf(metadata),
    user: metadata.user?.slackUserId,
    model: modelId
  });
  let completed = false;
  // Set by the stop condition below once a 🛑 is seen for this turn.
  let canceled = false;
  // Tracks the text of the most recent non-terminal step published below, so the
  // terminal reply isn't posted twice when it is that same text.
  let lastStepText = "";
  // Both hoisted out of the protected body so the outer catch can still record an
  // approval this turn carried out. The call really ran, the store has already let
  // it go, and the gatekeeper will not deliver the decision a second time — so a
  // turn that failed afterwards is the last chance to say what happened.
  let approvalAction: ToolRecord | undefined;
  let openSession: SessionLike | undefined;

  publishSubmitted(eventBus, requestContext);

  const publishTerminal = (
    reply: string,
    state: TaskState = TaskState.TASK_STATE_COMPLETED
  ): void => {
    if (completed) return;
    completed = true;
    // When generation stops at the step limit on a tool-calling step, that step's
    // text was already streamed as a non-terminal update (`:step:N`) and equals
    // `result.text`. Send an empty terminal so the task still completes and
    // collects the 🛑 without re-posting it (different id ⇒ dedupe would miss it).
    // History still keeps the full reply via `appendMessage`.
    const terminalText = reply && reply === lastStepText ? "" : reply;
    publishStatus(
      eventBus,
      requestContext,
      [textPart(terminalText)],
      `${userMessage.messageId}:final`,
      state
    );
  };

  try {
    const {
      session,
      systemSuffix,
      tools: extraTools,
      toolApproval
    } = await cfg.prepare(text, metadata);
    openSession = session;

    // An answer to a prompt this agent raised resumes that call rather than opening
    // a new exchange: the call, with the human's answer against it, goes where the
    // model left off, and no user turn is added — the answer *is* the result.
    //
    // A question's answer is written to history first, before the model runs and
    // before the store lets go of its copy. The gatekeeper has already marked the
    // answer as given and will not send it again, so a turn that recorded it only on
    // the way out could lose it to anything that ends the turn early.
    //
    // An approval cannot be written that early, because the answer is not the
    // outcome: the call still has to run, and history cannot amend a record it
    // already holds. So the decision is carried here and recorded once, by whichever
    // exit the turn takes — see {@link approvedCall}.
    //
    // A prompt with no open call left to settle (raised before open calls existed,
    // or already settled) is an ordinary message.
    const answer = humanAnswerOf(userMessage, metadata.user?.displayName);
    // Read off the answer rather than the settled record: a timeout for a prompt
    // raised before open calls existed has no record to settle, and that turn must
    // not be free to raise the same one again either.
    const timedOut = answer?.answer.kind === "timed-out";
    const settled =
      answer && cfg.openCalls
        ? await cfg.openCalls.settle(answer.requestId, async (call) => {
            if (call.approval) {
              approvalAction = wasApproved(answer.answer)
                ? approvedCall(call, answer.answer.by)
                : refusedCall(call, refusalReason(answer.answer));
              return;
            }
            await session.appendMessage(
              toolCallSessionMessage(
                answeredCall(call, answer.answer),
                // Fixed per call, so recording the same answer twice stores it once.
                `answer:${call.requestId}`
              )
            );
          })
        : null;
    if (settled) {
      console.info("[agent-loop] resuming a settled prompt", {
        requestId: settled.requestId,
        approval: settled.approval !== undefined,
        contextId: requestContext.contextId
      });
    } else {
      // `text` already carries its `<turn>` provenance wrapper (applied by the
      // Gatekeeper in dispatch); persist it verbatim.
      await session.appendMessage(userSessionMessage(text));
    }
    const history = await session.getHistory();
    const soul = (await session.refreshSystemPrompt()) + systemSuffix;
    const workTools = { ...(await session.tools()), ...extraTools };
    const required = cfg.requireFinalReply === true;

    // Whether the approved call is still waiting to run. Only an approval that was
    // granted replays; a refusal is already its own outcome.
    const replaying = approvalAction?.approval?.approved === true;
    // A replayed call is the one thing a turn does that its own model never asked
    // for — it runs before the first step, from a decision a previous turn made
    // and a human then approved. It is named separately rather than folded into
    // `tools` precisely because of that: "this turn decided to delete an agent"
    // and "this turn carried out a delete someone approved" are different facts,
    // and the second is the one an audit wants.
    if (replaying && approvalAction) turnLog.replayed(approvalAction.toolName);

    /**
     * History, plus the decision this turn is resuming.
     *
     * Every settled approval goes in, not only an approved one. An approved call
     * replays as `assistant[tool-call, tool-approval-request]` then
     * `tool[tool-approval-response]` — the shape the SDK collects a decision from —
     * and a refusal replays as that call plus the denied result carrying its
     * reason. A refusal the model never sees is one it will simply make again,
     * which is the whole thing a rejection is supposed to prevent.
     *
     * It is folded in with the rest rather than appended afterwards, so the
     * assistant run it continues is joined into one message the way any other
     * turn's would be. And it goes in uncapped: what the SDK executes has to be
     * what the human approved, to the character.
     */
    const messages = await toModelMessages(
      approvalAction
        ? [...history, replayToolCallMessage(approvalAction)]
        : history
    );

    // Every tool call this turn actually executed, across every attempt — the
    // primary's, a repair's, and the fallback's alike. All of them really ran and
    // really had side effects, so all of them are recorded: a fallback that
    // repeated an update performed two updates, and history should say so.
    //
    // `final_reply` never appears here. It has no `execute`, so it produces no
    // result to record — its text is the message body, not an action.
    const actions: ToolRecord[] = [];

    /** What this turn has to persist: the approval it settled, then its own calls. */
    const persisted = (): ToolRecord[] =>
      approvalAction ? [approvalAction, ...actions] : actions;

    const onStepEnd: GenerateTextOnStepEndCallback<ToolSet> = (step) => {
      if (cfg.recordToolCalls) {
        for (const part of step.content) {
          if (part.type === "tool-result") {
            actions.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              output: part.output
            });
          } else if (part.type === "tool-error") {
            // "I tried and it failed" is precisely the evidence that stops the
            // next turn confirming a success that never happened.
            actions.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              errorText: String(part.error)
            });
          }
        }
      }
      // Text from a tool-calling step is the agent's only genuine non-terminal
      // content. Tool-only steps stay silent in Slack.
      if (step.toolCalls.length === 0 || !step.text.trim()) return;
      // The step that ends the turn carries the answer in its `final_reply` call.
      // Publishing its accompanying text too would post the same thought twice —
      // once as a `working` update, once as the reply.
      if (step.toolCalls.some((c) => c.toolName === FINAL_REPLY_TOOL_NAME))
        return;
      const stepText = step.text.trim();
      lastStepText = stepText;
      publishStatus(
        eventBus,
        requestContext,
        [textPart(stepText)],
        `${userMessage.messageId}:step:${step.stepNumber}`,
        TaskState.TASK_STATE_WORKING
      );
    };

    /**
     * Settle the replayed call with what it produced.
     *
     * An approved call runs *before* the first step, into the messages the SDK puts
     * ahead of it, so `onStepEnd` never sees it — this is the only callback that
     * does. Everything else the turn calls is recorded there as usual.
     */
    const onToolExecutionEnd: OnToolExecutionEndCallback<ToolSet> = (event) => {
      turnLog.toolRan(event.toolExecutionMs);
      if (
        !approvalAction ||
        event.toolCall.toolCallId !== approvalAction.toolCallId
      )
        return;
      approvalAction = settledCall(
        approvalAction,
        event.toolOutput.type === "tool-result"
          ? { output: event.toolOutput.output }
          : { errorText: String(event.toolOutput.error) }
      );
    };

    /**
     * Every model call the turn is charged for, counted as it happens.
     *
     * Deliberately not read off the resolved result. A model that narrates under
     * an enforced tool choice is billed and then discarded: `generateText` raises
     * `ToolChoiceViolationError` at `generate-text.ts:1150`, so the promise never
     * resolves and there is no result — but the callback has already fired at
     * `:1128`. Reading usage from the result would report nothing for exactly the
     * turns that cost the most, which is both models answering in prose and then
     * a salvage on top.
     */
    const onLanguageModelCallEnd = (event: ModelCallLike): void => {
      turnLog.modelCall(event);
    };

    // The gatekeeper's 🛑 workflow runs on its own request and cannot reach into
    // this Durable Object mid-turn, so it records the stop on the task row and
    // the turn reads it back from there.
    const checkCanceled = async (): Promise<boolean> => {
      if (!cfg.isCanceled || canceled) return canceled;
      try {
        canceled = await cfg.isCanceled(userMessage.messageId);
      } catch (err) {
        // A ledger hiccup must not kill a turn that was never asked to stop.
        console.warn("[agent-loop] stop check failed, continuing", {
          contextId: requestContext.contextId,
          err: String(err)
        });
        return false;
      }
      return canceled;
    };

    // Between tool-calling steps — the only place generation can be *interrupted*.
    // A step's tool calls have already run and their results still reach the model.
    const stopIfCanceled: StopCondition<ToolSet> = () => checkCanceled();

    // A 🛑 has to be read *before* an approved call is replayed. The SDK runs it
    // ahead of the first model call, so by the first step boundary the deletion has
    // already happened — there is no later point at which stopping still means
    // anything. The decision is recorded as not carried out, and no call is spent.
    if (replaying && approvalAction && (await checkCanceled())) {
      console.info("[agent-loop] stopped before an approved call ran", {
        contextId: requestContext.contextId,
        toolName: approvalAction.toolName
      });
      approvalAction = withRefusal(approvalAction, STOPPED_BEFORE_RUN);
      // Recorded before the terminal is published: publishing marks the turn
      // completed, and the outer catch stands its own recovery down once it is.
      await session.appendMessage(
        assistantSessionMessage(CANCELED_NOTE, persisted())
      );
      turnLog.ending("stopped");
      publishTerminal("", TaskState.TASK_STATE_CANCELED);
      return;
    }

    // The system prompt goes in `instructions`: `messages` rejects `role: "system"`
    // entries by default, which is fine because `toModelMessages` only ever emits
    // user/assistant turns.
    const instructions = soul + (required ? FINAL_REPLY_CONTRACT : "");

    /**
     * The last step is the ending, not one more chance to work.
     *
     * Handing it only `final_reply` explains a constraint the model can already see
     * rather than imposing a new one — and the *named* tool choice is the stronger
     * form of the same ask: Workers AI enforces it server-side, where `required` is
     * advisory and fails open into prose on long contexts, which is the exact failure
     * this whole design exists to catch.
     *
     * Unlike the separate round it replaces, this step is inside the loop, so it can
     * see every tool result the turn produced. The old one restarted from history and
     * was asked to report work it could not read.
     */
    const endingStep: PrepareStepFunction<ToolSet> = ({ stepNumber }) =>
      stepNumber < MAX_STEPS - 1
        ? undefined
        : {
            activeTools: [FINAL_REPLY_TOOL_NAME],
            toolChoice: { type: "tool", toolName: FINAL_REPLY_TOOL_NAME },
            instructions: instructions + FINAL_ROUND_CONTRACT
          };

    // `final_reply` is declared *first*: tool order is part of the prompt, and
    // reaching an ending is the thing every turn has to do.
    // Typed as `ToolSet` rather than inferred: the ternary would otherwise infer a
    // union of two shapes, and `activeTools` is keyed to the tool names, which in
    // one branch narrows to `final_reply` alone.
    const turnTools: ToolSet = required
      ? { [FINAL_REPLY_TOOL_NAME]: finalReplyTool, ...workTools }
      : workTools;

    /**
     * A turn a timeout resumed may not raise the same kind of prompt again.
     *
     * Nobody answered for the whole TTL, and a turn still holding `ask_user` can
     * park on a fresh one, expire, and ask again — a task that never ends, putting
     * the same question to a human who let the last one sit for a week. A gated tool
     * is the same loop wearing a different hat: call `agents_delete` again and it
     * raises a new approval on a fresh seven-day deadline. So both are withheld, and
     * one way out is left: say what happened and finish. Everything else stays on the
     * table, so that ending can still report the work the turn did before it stopped.
     *
     * The gatekeeper closes the other way out itself: a 🛑 resolves the open rows and
     * never hands the task back, so a stopped prompt reaches no model at all.
     */
    const gated = new Set(
      toolApproval && typeof toolApproval === "object"
        ? Object.keys(toolApproval)
        : []
    );
    const withheld = timedOut
      ? Object.keys(turnTools).filter(
          (name) => name !== ASK_USER_TOOL_NAME && !gated.has(name)
        )
      : undefined;

    const runTurn = () =>
      generateText({
        model: cfg.model,
        instructions,
        messages,
        tools: turnTools,
        ...(toolApproval ? { toolApproval } : {}),
        ...(withheld ? { activeTools: withheld } : {}),
        // Every ending is a `final_reply` call, so the model must always call
        // something. Work tools stay freely available — `required` constrains the
        // *shape* of a step's output, not which tool is chosen.
        ...(required
          ? { toolChoice: "required" as const, prepareStep: endingStep }
          : {}),
        // `hasToolCall(FINAL_REPLY_TOOL_NAME)` is deliberately absent here: it matches
        // a *rejected* call too, so it would halt the loop on a malformed ending
        // before the SDK could hand the model its own error to fix. A valid call ends
        // the loop without help — `final_reply` has no `execute`, so it produces no
        // output, and the loop only continues once every call has one. A call waiting
        // on an approval has no output either, and stops it the same way.
        stopWhen: [isStepCount(MAX_STEPS), stopIfCanceled],
        onStepEnd,
        onToolExecutionEnd,
        onLanguageModelCallEnd,
        // The telemetry opt-out, shared with the compaction summarizer so the two
        // call sites cannot drift. Reasoning depth is not here: it belongs to the
        // model, because the primary and the fallback do not accept the same
        // levels — see {@link file://../model.ts model.ts}.
        ...CHAT_CALL_OPTIONS
      });

    /**
     * Ask for an ending, once, with nothing else on the table.
     *
     * Reached only when the loop came back with no reply: the model narrated under
     * the advisory `required` and the SDK raised the violation, or the ending step's
     * own call was malformed with no budget left to repair it. Both are endings the
     * turn can still recover, and the enforced tool choice is the one lever the
     * failed steps did not have.
     *
     * No `onStepEnd`: nothing but the reply is declared, so there is no action to
     * record and no intermediate text to publish.
     */
    const salvageEnding = (seed: ModelMessage[]) =>
      generateText({
        model: cfg.model,
        instructions: instructions + FINAL_ROUND_CONTRACT,
        messages: seed,
        tools: { [FINAL_REPLY_TOOL_NAME]: finalReplyTool },
        toolChoice: { type: "tool", toolName: FINAL_REPLY_TOOL_NAME },
        stopWhen: [isStepCount(1)],
        // The one callback the salvage does want: it is a charged call like any
        // other, and the case it exists for is the one where it narrates too.
        onLanguageModelCallEnd,
        ...CHAT_CALL_OPTIONS
      });

    let result: Awaited<ReturnType<typeof runTurn>> | undefined;
    let reply: string | undefined;

    try {
      result = await runTurn();
      reply = required ? readFinalReply(result) : readPlainReply(result);
    } catch (err) {
      // Narration under an enforced tool choice arrives as a throw, not a result —
      // the SDK enforces the constraint it cannot make the model honour, and it only
      // does so once the model's own fallback has answered in prose too. It is an
      // *ending*, not an outage: both models were reachable and answered, they just
      // answered in prose. Catching it here keeps the turn off the failure path and
      // on the one that asks once more for an answer.
      if (!ToolChoiceViolationError.isInstance(err)) throw err;
      console.warn("[agent-loop] narrated under an enforced tool choice", {
        model: modelId,
        finishReason: err.finishReason,
        contextId: requestContext.contextId
      });
    }

    // An approved call that produced no execution event never ran. The SDK's own
    // `execution-denied` says why when the re-run policy refused it — the approver
    // was not entitled to it, or what it named has since moved — and that sentence
    // is a truer account than a guess from out here.
    if (
      replaying &&
      approvalAction &&
      !("output" in approvalAction) &&
      approvalAction.errorText === undefined
    ) {
      approvalAction = withRefusal(
        approvalAction,
        (result ? deniedReason(result) : undefined) ?? NOT_CARRIED_OUT
      );
    }

    // The prompt the last step stopped on, if it stopped on one.
    const pause = result ? openCallOf(result.finalStep) : undefined;

    // A 🛑 or a prompt out-ranks the reply and ends the turn here: neither is a
    // reason to spend another call.
    const interrupted = (await checkCanceled()) || pause !== undefined;

    if (required && reply === undefined && !interrupted) {
      turnLog.salvaged();
      console.warn("[agent-loop] no ending; asking once more with none else", {
        model: modelId,
        finishReason: result?.finishReason,
        contextId: requestContext.contextId
      });
      try {
        // With a result there is a whole run to report, so hand it over. A violation
        // discards the run, leaving only history — which is all the round this
        // replaces ever had. What history must *not* still carry is an approval the
        // SDK was never told the outcome of: seeded with that, the salvage collects
        // the same decision again and sends the call on with no result at all. So the
        // settled record is folded in instead.
        const seed = result
          ? [...messages, ...result.responseMessages]
          : approvalAction
            ? await toModelMessages([
                ...history,
                toolCallSessionMessage(approvalAction)
              ])
            : messages;
        const salvaged = await salvageEnding(seed);
        reply = readFinalReply(salvaged);
      } catch (err) {
        if (!ToolChoiceViolationError.isInstance(err)) throw err;
        console.warn("[agent-loop] narrated again under the enforced ending", {
          model: modelId,
          contextId: requestContext.contextId
        });
      }
    }

    // Every exit below persists `persisted()` alongside whatever the turn managed
    // to say. The tools ran and their side effects are real however the turn ended;
    // a side effect the transcript does not show is exactly how a later turn ends
    // up guessing at what happened.

    // Re-check after generation, not only between steps. A turn the model answers
    // in a single step has no step boundary to be interrupted at, and neither does
    // a salvage call, so this is the only chance to notice a 🛑 that landed while
    // either was generating. The work is already spent by then, but the answer must
    // still be withheld: the user was told "🛑 Stopped.", and delivering the reply
    // anyway is the bug this fixes.
    await checkCanceled();

    // Stopped: whatever was produced is abandoned work, not an answer. Publish an
    // empty terminal `canceled` — the gatekeeper posts its own "🛑 Stopped." notice,
    // and any partial output already went out as a step update — and close the
    // turn in history so the next one doesn't reopen it.
    if (canceled) {
      console.info("[agent-loop] turn stopped by the user", {
        contextId: requestContext.contextId,
        model: modelId
      });
      await session.appendMessage(
        assistantSessionMessage(CANCELED_NOTE, persisted())
      );
      turnLog.ending("stopped");
      publishTerminal("", TaskState.TASK_STATE_CANCELED);
      return;
    }

    // The model asked for something the human has to settle. Record the prompt as
    // what this turn said, keep the call until someone answers it, and only then
    // raise it: a click that beat the record would find nothing to resume.
    if (pause) {
      if (!cfg.openCalls) {
        throw new Error(
          `[agent-loop] ${pause.call.toolName} was called, but this agent has nowhere to keep an open call`
        );
      }
      const request = hitlRequestOf(pause.call);
      await session.appendMessage(
        assistantSessionMessage(request.prompt, [
          ...persisted(),
          ...pause.notRaised
        ])
      );
      await cfg.openCalls.put(pause.call);
      completed = true;
      turnLog.ending("parked");
      publishInputRequired(
        eventBus,
        requestContext,
        request,
        `${userMessage.messageId}:hitl`
      );
      return;
    }

    if (reply === undefined) {
      console.warn("[agent-loop] turn produced no reply", {
        model: modelId,
        // Absent when the turn ended in a violation: the throw carries the result
        // away with it, and the warning above already named that case.
        finishReason: result?.finishReason,
        contextId: requestContext.contextId
      });
      // The apology is not persisted — it says nothing true about the workspace —
      // but any calls that ran are.
      const records = persisted();
      if (records.length > 0) {
        await session.appendMessage(
          assistantSessionMessage(NO_REPLY_NOTE, records)
        );
      }
      turnLog.ending("none");
      publishTerminal(TRANSIENT_REPLY);
      return;
    }

    await session.appendMessage(assistantSessionMessage(reply, persisted()));
    turnLog.ending("reply");
    publishTerminal(reply);
  } catch (err) {
    turnLog.ending("failed");
    console.error("[agent-loop] turn failed", {
      contextId: requestContext.contextId,
      model: modelId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    // An approval this turn settled is recorded here or nowhere. `completed` means
    // an exit above already published, and so already persisted — writing again
    // would put a second part under the same tool call id, which breaks the replay
    // of every later turn. Best-effort: a failure here must not mask the real one.
    if (!completed && approvalAction && openSession) {
      // A failure before the call could run leaves the decision marked approved
      // with no outcome, which reads as one still waiting to happen. Nothing is
      // waiting: this turn is over and the store has already let the call go.
      const unfinished =
        approvalAction.approval?.approved === true &&
        !("output" in approvalAction) &&
        approvalAction.errorText === undefined;
      const record = unfinished
        ? withRefusal(approvalAction, NOT_CARRIED_OUT)
        : approvalAction;
      try {
        await openSession.appendMessage(
          assistantSessionMessage(NO_REPLY_NOTE, [record])
        );
      } catch (persistErr) {
        console.error("[agent-loop] could not record a settled approval", {
          contextId: requestContext.contextId,
          err: String(persistErr)
        });
      }
    }
    // A transient blip is a turn that completed by saying "try again" — the work
    // is recoverable and nothing is broken. An unexpected error is a real
    // failure, so report it as one: `failed` is what makes the delivery boundary
    // mark it in Slack instead of rendering the apology as a normal reply. A2A
    // v1.0 carries no structured task error, so the state is the only signal.
    if (isTransientAiError(err)) {
      publishTerminal(TRANSIENT_REPLY);
    } else {
      publishTerminal(cfg.unexpectedReply, TaskState.TASK_STATE_FAILED);
    }
  } finally {
    turnLog.flush();
    eventBus.finished();
  }
}
