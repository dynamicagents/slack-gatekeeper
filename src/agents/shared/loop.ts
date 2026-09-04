import { AgentEvent } from "@a2a-js/sdk/server";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message } from "@a2a-js/sdk";
import type {
  FinishReason,
  GenerateTextOnStepEndCallback,
  LanguageModel,
  ModelMessage,
  StopCondition,
  ToolSet
} from "ai";
import { generateText, hasToolCall, isStepCount } from "ai";
import type { createModelPair } from "@/agents/model";
import { buildMessage, textOf, textPart } from "@/a2a/parts";
import { buildHitlRequestParts, type HitlRequest } from "@/a2a/hitl";
import type { AgentTurnMetadata } from "@/agents/dispatch";
import type { SessionLike } from "./session";
import {
  assistantSessionMessage,
  toModelMessages,
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

const MAX_STEPS = 10;

/**
 * How many times one model may be shown its own rejected `final_reply` and asked
 * again, before the turn gives up on that slot.
 *
 * Repair belongs to the **slot**, not the turn. A rejected call is not a model
 * that is unavailable — it is one that understood the request and got the shape
 * wrong, which is the single failure it can actually fix once it is shown the
 * rejection. Falling straight through to the fallback instead spends a whole
 * second model on a fresh guess that has no idea the first one failed.
 */
const MAX_REPAIR_ATTEMPTS = 2;

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

/**
 * What a round may do.
 *
 * - `open` — the normal round: `final_reply` and every work tool, up to
 *   {@link MAX_STEPS} steps.
 * - `final` — the turn spent its steps without ever answering. **No work tools**:
 *   the only thing on the table is the reply. This is not a punishment but the
 *   shape of the ceiling — a budget that ends in a forced answer returns the work,
 *   where one that simply stopped would discard it and apologize for an outage
 *   that never happened.
 */
type RoundMode = "open" | "final";

/**
 * How one model attempt ended.
 *
 * The two failure shapes are the point of the split. `rejected` means the model
 * reached an ending and got its *shape* wrong — repairable, by the same model,
 * which now has something specific to fix. `none` means the attempt produced no
 * ending at all, which no feedback can address and which is what the fallback slot
 * exists for. `exhausted` is neither: the model was working fine and simply ran out
 * of steps, so the answer is a `final` round, not a second opinion.
 */
type Attempt =
  | { kind: "replied"; text: string }
  | { kind: "rejected"; input: unknown; error: unknown }
  | { kind: "exhausted" }
  | { kind: "none"; finishReason: FinishReason }
  /** A 🛑 or a HITL park ended the turn; the caller reads which from its own state. */
  | { kind: "interrupted" };

/**
 * A rejected `final_reply` paired with its rejection, as the exchange the model
 * has to see in order to fix it.
 *
 * Deliberately the same shape the SDK produces for a work tool that failed — the
 * call, then an `error-text` result carrying the reason. A work tool gets this for
 * free and models already know how to read it; a control tool halts the loop before
 * the SDK can, so the turn builds it by hand.
 *
 * Entirely ephemeral: these messages exist for the next `generateText` call and are
 * never appended to the Session. The durable record of a turn is the ending it
 * landed on, and a call that was thrown out is not something a later turn should be
 * able to read back as history.
 */
function repairExchange(
  toolCallId: string,
  input: unknown,
  error: unknown
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: FINAL_REPLY_TOOL_NAME,
          input
        }
      ]
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: FINAL_REPLY_TOOL_NAME,
          output: {
            type: "error-text",
            value:
              `${String(error)}\n\n` +
              `The turn did not end and nothing was sent to the user. Call ` +
              `${FINAL_REPLY_TOOL_NAME} again with your complete reply.`
          }
        }
      ]
    }
  ];
}

export function isTransientAiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("3040") ||
    err.message.includes("3046") ||
    err.message.toLowerCase().includes("capacity temporarily exceeded") ||
    err.message.toLowerCase().includes("request timeout")
  );
}

/** What an agent assembles for a single turn (inside the protected body). */
export interface PreparedTurn {
  /** The Durable Object's one Session (history + soul + memory). */
  session: SessionLike;
  /** Per-request system-prompt suffix (caller context). Advisory. */
  systemSuffix: string;
  /** Agent-specific tools merged over the session's own `set_context` tool. */
  tools: ToolSet;
}

/** Turn-scoped controls a tool can reach (via the deps its executor builds). */
export interface TurnControls {
  /**
   * Pause this turn to ask a human: the loop stops after the current tool step,
   * ends the turn in `input-required` carrying `request` (the delivery boundary
   * renders it in Slack and parks the task), and publishes no terminal reply. The
   * human's answer resumes the agent on a later, separate invocation.
   */
  park(request: HitlRequest): void;
}

export interface AgentTurnConfig {
  models: ReturnType<typeof createModelPair>;
  /**
   * Assemble the session/tools/system for this turn. Runs *inside* the protected
   * body, so throwing here (e.g. missing required metadata) yields the friendly
   * error reply rather than a crash. `turn` lets the assembled tools pause the
   * turn for human input (agents that don't offer HITL simply ignore it).
   */
  prepare: (
    text: string,
    metadata: Partial<AgentTurnMetadata>,
    turn: TurnControls
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
   * `toolChoice: "required"` on every step. Prose stops being an outcome, so a
   * model that narrates an action and stops fails its attempt rather than shipping
   * the narration as an answer — see {@link file://./final-reply.ts final-reply.ts}.
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
 * run a Workers-AI `generateText` tool loop over the Session history (primary →
 * fallback model on any error), persist + publish the final reply, and
 * always `finished()`. Agent-specific behavior (which session, which tools, which
 * caller context) is supplied by `cfg.prepare`.
 */
export async function executeAgentTurn(
  requestContext: RequestContext,
  eventBus: ExecutionEventBus,
  cfg: AgentTurnConfig
): Promise<void> {
  const userMessage = requestContext.userMessage;
  const text = textOf(userMessage);
  const metadata = (userMessage.metadata ?? {}) as Partial<AgentTurnMetadata>;
  let modelId = cfg.models.primaryId();
  let completed = false;
  // Set by the stop condition below once a 🛑 is seen for this turn.
  let canceled = false;
  // Set when a tool calls `turn.park`: the turn ends in `input-required` awaiting
  // a human instead of publishing a terminal reply. Held on an object so the
  // closure assignment in `turn.park` is visible to control-flow narrowing.
  const hitl: { request: HitlRequest | null } = { request: null };
  // Tracks the text of the most recent non-terminal step published below, so the
  // terminal reply isn't posted twice when it is that same text.
  let lastStepText = "";

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
    const turn: TurnControls = {
      park: (request) => {
        hitl.request = request;
      }
    };
    const {
      session,
      systemSuffix,
      tools: extraTools
    } = await cfg.prepare(text, metadata, turn);

    // `text` already carries its `<turn>` provenance wrapper (applied by the
    // Gatekeeper in dispatch); persist it verbatim.
    await session.appendMessage(userSessionMessage(text));
    const history = await session.getHistory();
    const soul = (await session.refreshSystemPrompt()) + systemSuffix;
    const workTools = { ...(await session.tools()), ...extraTools };
    const messages = await toModelMessages(history);
    const required = cfg.requireFinalReply === true;

    // Every tool call this turn actually executed, across every attempt — the
    // primary's, a repair's, and the fallback's alike. All of them really ran and
    // really had side effects, so all of them are recorded: a fallback that
    // repeated an update performed two updates, and history should say so.
    //
    // `final_reply` never appears here. It has no `execute`, so it produces no
    // result to record — its text is the message body, not an action.
    const actions: ToolRecord[] = [];

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

    // A tool called `turn.park`: stop right after this step so the turn can end in
    // `input-required` instead of feeding the sentinel result back to the model.
    const stopIfHitlRequested: StopCondition<ToolSet> = () =>
      hitl.request !== null;

    // One call shape, two models, two modes. The system prompt goes in
    // `instructions`: `messages` rejects `role: "system"` entries by default,
    // which is fine because `toModelMessages` only ever emits user/assistant turns.
    const generate = (
      model: LanguageModel,
      msgs: ModelMessage[],
      mode: RoundMode
    ) =>
      generateText({
        model,
        instructions:
          soul +
          (required ? FINAL_REPLY_CONTRACT : "") +
          (mode === "final" ? FINAL_ROUND_CONTRACT : ""),
        messages: msgs,
        // `final_reply` is declared *first*: tool order is part of the prompt, and
        // reaching an ending is the thing every turn has to do. A `final` round is
        // handed nothing to work with but the way out — leaving the work tools on
        // would invite it to spend a budget it has already spent.
        tools: required
          ? {
              [FINAL_REPLY_TOOL_NAME]: finalReplyTool,
              ...(mode === "final" ? {} : workTools)
            }
          : workTools,
        // Every ending is a `final_reply` call, so the model must always call
        // something. Work tools stay freely available — `required` constrains the
        // *shape* of a step's output, not which tool is chosen.
        ...(required ? { toolChoice: "required" as const } : {}),
        stopWhen:
          mode === "final"
            ? [isStepCount(1)]
            : [
                isStepCount(MAX_STEPS),
                stopIfCanceled,
                stopIfHitlRequested,
                ...(required ? [hasToolCall(FINAL_REPLY_TOOL_NAME)] : [])
              ],
        onStepEnd
      });

    /** Classify what one completed generation produced. */
    const readEnding = (
      result: Awaited<ReturnType<typeof generate>>
    ): Attempt => {
      if (!required) {
        const replyText = result.text.trim();
        if (!replyText || result.finishReason === "length") {
          return { kind: "none", finishReason: result.finishReason };
        }
        return { kind: "replied", text: replyText };
      }

      const calls = result.toolCalls.filter(
        (c) => c.toolName === FINAL_REPLY_TOOL_NAME
      );
      if (calls.length > 0) {
        // The last call of a repeated set: a model that restated its answer meant
        // the restatement.
        const input = calls[calls.length - 1].input as unknown;
        const parsed = finalReplyInputSchema.safeParse(input);
        if (parsed.success) {
          return { kind: "replied", text: parsed.data.text.trim() };
        }
        return {
          kind: "rejected",
          input,
          error: parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")
        };
      }

      // No ending. `tool-calls` means the model was still working when it hit the
      // step ceiling — a `final` round is what it needs. Anything else means it
      // ignored `toolChoice: "required"` and narrated instead of acting, which is
      // the failure this whole design exists to catch.
      return result.finishReason === "tool-calls"
        ? { kind: "exhausted" }
        : { kind: "none", finishReason: result.finishReason };
    };

    /**
     * Run one mode across both model slots, repairing a rejected ending in place.
     *
     * Two nested recoveries answering different failures. Within a slot, a call the
     * schema rejects goes back to the *same* model as a failed tool result — a shape
     * error is the one thing a model can fix once it sees it. Across slots, an
     * attempt that produced no ending at all moves to the fallback, which is what
     * that slot is for.
     */
    const runRounds = async (mode: RoundMode): Promise<Attempt> => {
      let last: Attempt = { kind: "none", finishReason: "stop" };

      for (const slot of ["primary", "fallback"] as const) {
        if (slot === "fallback") modelId = cfg.models.fallbackId();
        const model =
          slot === "primary" ? cfg.models.primary : cfg.models.fallback;
        // A fresh copy per slot, so a fallback that is reached is never handed the
        // primary's rejected calls to be confused by.
        const slotMessages = [...messages];

        for (let repair = 0; repair <= MAX_REPAIR_ATTEMPTS; repair += 1) {
          let result: Awaited<ReturnType<typeof generate>>;
          try {
            result = await generate(model(), slotMessages, mode);
          } catch (err) {
            // The last slot's throw is the one the outer catch classifies, so it
            // is left to propagate; an earlier slot's is spent and moves on.
            if (slot === "fallback") throw err;
            console.warn(
              "[agent-loop] AI error on primary model, retrying with fallback",
              {
                model: modelId,
                mode,
                error: String(err),
                contextId: requestContext.contextId
              }
            );
            break;
          }

          // A 🛑 or a park out-ranks the reply and ends the turn here: neither is
          // a reason to spend another model.
          if (await checkCanceled()) return { kind: "interrupted" };
          if (hitl.request) return { kind: "interrupted" };

          last = readEnding(result);
          // The plain-text ending has never advanced to the fallback on anything
          // but a throw, and does not repair. Keep it that way.
          if (!required) return last;
          if (last.kind === "replied" || last.kind === "exhausted") return last;

          if (last.kind === "rejected" && repair < MAX_REPAIR_ATTEMPTS) {
            console.warn("[agent-loop] final_reply rejected, repairing", {
              model: modelId,
              repair,
              error: String(last.error),
              contextId: requestContext.contextId
            });
            slotMessages.push(
              ...repairExchange(
                `${userMessage.messageId}:repair:${slot}:${repair}`,
                last.input,
                last.error
              )
            );
            continue;
          }
          break;
        }
      }

      return last;
    };

    let ending = await runRounds("open");

    // The turn spent its steps without answering. One more call, with nothing on
    // the table but the reply, so the work it did do comes back to the user
    // instead of being discarded behind an apology for an outage that never
    // happened.
    if (
      required &&
      ending.kind !== "replied" &&
      ending.kind !== "interrupted"
    ) {
      console.warn("[agent-loop] no final_reply; forcing a final round", {
        model: modelId,
        ending: ending.kind,
        contextId: requestContext.contextId
      });
      modelId = cfg.models.primaryId();
      ending = await runRounds("final");
    }

    // Every exit below persists `actions` alongside whatever the turn managed to
    // say. The tools ran and their side effects are real however the turn ended;
    // a side effect the transcript does not show is exactly how a later turn ends
    // up guessing at what happened.

    // Re-check after generation, not only between steps. A turn the model answers
    // in a single call has no step boundary to be interrupted at, so this is the
    // only chance to notice a 🛑 that landed while it was generating. The work is
    // already spent by then, but the answer must still be withheld: the user was
    // told "🛑 Stopped.", and delivering the reply anyway is the bug this fixes.
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
      publishTerminal("", TaskState.TASK_STATE_CANCELED);
      await session.appendMessage(
        assistantSessionMessage(CANCELED_NOTE, actions)
      );
      return;
    }

    // A tool paused the turn for human input. Persist the prompt as the assistant's
    // turn so the resumed turn has coherent context (the model "remembers" what it
    // asked), then end in `input-required` — no terminal reply.
    if (hitl.request) {
      completed = true;
      await session.appendMessage(
        assistantSessionMessage(hitl.request.prompt, actions)
      );
      publishInputRequired(
        eventBus,
        requestContext,
        hitl.request,
        `${userMessage.messageId}:hitl`
      );
      return;
    }

    if (ending.kind !== "replied") {
      console.warn("[agent-loop] turn produced no reply", {
        model: modelId,
        ending: ending.kind,
        finishReason: ending.kind === "none" ? ending.finishReason : undefined,
        contextId: requestContext.contextId
      });
      // The apology is not persisted — it says nothing true about the workspace —
      // but any calls that ran are.
      if (actions.length > 0) {
        await session.appendMessage(
          assistantSessionMessage(NO_REPLY_NOTE, actions)
        );
      }
      publishTerminal(TRANSIENT_REPLY);
      return;
    }

    await session.appendMessage(assistantSessionMessage(ending.text, actions));
    publishTerminal(ending.text);
  } catch (err) {
    console.error("[agent-loop] turn failed", {
      contextId: requestContext.contextId,
      model: modelId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
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
    eventBus.finished();
  }
}
