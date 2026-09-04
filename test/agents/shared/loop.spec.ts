import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { tool, type LanguageModel } from "ai";
import { z } from "zod";
import { TaskState, type TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";
import { dataOf, partsText } from "@/a2a/parts";
import type { ModelPair } from "@/agents/model";
import type { SessionLike } from "@/agents/shared/session";
import {
  isTransientAiError,
  executeAgentTurn,
  type AgentTurnConfig
} from "@/agents/shared/loop";
import { sessionText } from "@/agents/shared/messages";
import {
  FakeSession,
  finalReplyResult,
  okResult,
  lengthResult,
  toolCallResult
} from "../../helpers/agents";
import { userMessage } from "../../helpers/a2a";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PublishedEvent = AgentExecutionEvent;

function fakeEventBus() {
  const published: PublishedEvent[] = [];
  const publish = vi.fn((e: unknown) => {
    published.push(e as never);
  });
  const finished = vi.fn();
  const eventBus = { publish, finished } as never;
  return { eventBus, published, publish, finished };
}

function fakeRequestContext(
  text = "hello",
  opts: { contextId?: string; metadata?: Record<string, unknown> } = {}
) {
  const contextId = opts.contextId ?? "ctx-1";
  return {
    contextId,
    taskId: "task-1",
    userMessage: userMessage(text, {
      contextId,
      metadata: opts.metadata ?? {}
    })
  } as never;
}

/** The status-update event at `index`, failing the test if it is another kind. */
function statusEventAt(
  bus: { published: PublishedEvent[] },
  index: number
): TaskStatusUpdateEvent {
  const event = bus.published.at(index);
  expect(event?.kind).toBe("statusUpdate");
  return (event as { kind: "statusUpdate"; data: TaskStatusUpdateEvent }).data;
}

/** The task state of every status-update event published, in order. */
function publishedStates(bus: { published: PublishedEvent[] }): TaskState[] {
  return bus.published.flatMap((e) =>
    e.kind === "statusUpdate" && e.data.status ? [e.data.status.state] : []
  );
}

/** The concatenated text of every event published, for "never said X" checks. */
function publishedText(bus: { published: PublishedEvent[] }): string {
  return bus.published
    .map((e) =>
      e.kind === "statusUpdate" ? partsText(e.data.status?.message?.parts) : ""
    )
    .join("");
}

function expectTerminalReply(
  bus: { published: PublishedEvent[] },
  state: TaskState = TaskState.TASK_STATE_COMPLETED
) {
  expect(bus.published[0]).toMatchObject({
    kind: "task",
    data: {
      id: "task-1",
      contextId: "ctx-1",
      status: { state: TaskState.TASK_STATE_SUBMITTED }
    }
  });

  const terminal = statusEventAt(bus, -1);
  expect(terminal).toMatchObject({
    taskId: "task-1",
    contextId: "ctx-1",
    status: { state }
  });
  return terminal.status?.message;
}

function fakeModels(
  primary: LanguageModel,
  fallback: LanguageModel = primary
): ModelPair {
  return {
    primary: () => primary,
    fallback: () => fallback,
    primaryId: () => "primary-model",
    fallbackId: () => "fallback-model"
  };
}

function makeCfg(
  session: SessionLike,
  models: ModelPair,
  overrides: Partial<AgentTurnConfig> = {}
): AgentTurnConfig {
  return {
    models,
    prepare: async () => ({ session, systemSuffix: "", tools: {} }),
    unexpectedReply: "Something went wrong. Please try again.",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// isTransientAiError
// ---------------------------------------------------------------------------

describe("isTransientAiError", () => {
  it("returns false for non-Error values", () => {
    expect(isTransientAiError("string error")).toBe(false);
    expect(isTransientAiError(42)).toBe(false);
    expect(isTransientAiError(null)).toBe(false);
    expect(isTransientAiError(undefined)).toBe(false);
  });

  it("returns true when message contains error code 3040", () => {
    expect(isTransientAiError(new Error("error code 3040 hit"))).toBe(true);
  });

  it("returns true when message contains error code 3046", () => {
    expect(isTransientAiError(new Error("3046 returned from model"))).toBe(
      true
    );
  });

  it("returns true for 'capacity temporarily exceeded' (case-insensitive)", () => {
    expect(isTransientAiError(new Error("Capacity Temporarily Exceeded"))).toBe(
      true
    );
    expect(isTransientAiError(new Error("CAPACITY TEMPORARILY EXCEEDED"))).toBe(
      true
    );
  });

  it("returns true for 'request timeout' (case-insensitive)", () => {
    expect(isTransientAiError(new Error("Request Timeout occurred"))).toBe(
      true
    );
    expect(isTransientAiError(new Error("REQUEST TIMEOUT"))).toBe(true);
  });

  it("returns false for an unrelated error message", () => {
    expect(isTransientAiError(new Error("some unrelated failure"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeAgentTurn
// ---------------------------------------------------------------------------

describe("executeAgentTurn", () => {
  it("happy path: appends user + assistant messages and completes a task", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Hello!") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    // finished() always fires
    expect(bus.finished).toHaveBeenCalledTimes(1);
    // The task exists before its terminal response, allowing async acceptance.
    expect(bus.published).toHaveLength(2);
    const terminal = expectTerminalReply(bus);
    expect(terminal?.messageId).toBe("m1:final");
    expect(partsText(terminal?.parts)).toBe("Hello!");
    // User turn then assistant turn persisted
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("persists the incoming turn text verbatim (Gatekeeper owns wrapping)", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("ok") as never
    });
    const bus = fakeEventBus();

    // In production this arrives already wrapped by the Gatekeeper; the loop must
    // store it untouched, not re-wrap it.
    const wrapped =
      '<turn from="Grace" id="U2" channel="general" ' +
      'at="2026-06-25T14:30:00.000Z">register a bot</turn>';

    await executeAgentTurn(
      fakeRequestContext(wrapped),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    const userTurn = session.messages.find((m) => m.role === "user");
    expect(userTurn?.parts[0]).toMatchObject({ type: "text", text: wrapped });
  });

  it("falls back to the fallback model when the primary throws", async () => {
    const session = new FakeSession();
    const fallbackModel = new MockLanguageModelV3({
      doGenerate: async () => okResult("Fallback reply") as never
    });
    const bus = fakeEventBus();

    // Make primary() itself throw synchronously — exercises the inner catch that
    // retries with fallback() without passing a throwing model to generateText
    // (which would leak an unhandled rejection through the SDK telemetry span).
    const models: ModelPair = {
      primary: () => {
        throw new Error("primary unavailable");
      },
      fallback: () => fallbackModel,
      primaryId: () => "primary-model",
      fallbackId: () => "fallback-model"
    };

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, models)
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe("Fallback reply");
  });

  it("publishes the transient reply when a transient error propagates to the outer catch", async () => {
    // Inject the transient error through prepare() to test the outer catch's
    // isTransientAiError branch without invoking generateText (which leaks
    // unhandled rejections through the telemetry span in the Workers runtime).
    const bus = fakeEventBus();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });

    await executeAgentTurn(fakeRequestContext("hi"), bus.eventBus, {
      models: fakeModels(model),
      prepare: async () => {
        throw new Error("capacity temporarily exceeded");
      },
      unexpectedReply: "Something went wrong. Please try again."
    });

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(2);
    expect(partsText(expectTerminalReply(bus)?.parts)).toMatch(
      /temporarily unavailable/i
    );
  });

  it("publishes unexpectedReply when a non-transient error propagates to the outer catch", async () => {
    // Same injection strategy as the transient test above — prepare() throw
    // exercises the same outer-catch branch, just the non-transient arm.
    const bus = fakeEventBus();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });

    await executeAgentTurn(fakeRequestContext("hi"), bus.eventBus, {
      models: fakeModels(model),
      prepare: async () => {
        throw new Error("some unexpected failure");
      },
      unexpectedReply: "Something went wrong. Please try again."
    });

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(2);
    // `failed`, not `completed`: A2A v1.0 has no structured task error, so the
    // state is the only thing that tells the gatekeeper this turn broke.
    expect(
      partsText(expectTerminalReply(bus, TaskState.TASK_STATE_FAILED)?.parts)
    ).toBe("Something went wrong. Please try again.");
  });

  it("publishes the transient reply and skips persist when model returns empty text", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("   ") as never // whitespace-only → trims to ""
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(partsText(expectTerminalReply(bus)?.parts)).toMatch(
      /temporarily unavailable/i
    );
    // User message WAS appended; assistant message was NOT (empty reply skipped)
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("publishes the transient reply and skips persist when finish_reason is 'length'", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => lengthResult("truncated content here") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(partsText(expectTerminalReply(bus)?.parts)).toMatch(
      /temporarily unavailable/i
    );
    // Assistant message must NOT be persisted when the reply was truncated
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("publishes unexpectedReply and still finishes when prepare() throws", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(fakeRequestContext(), bus.eventBus, {
      models: fakeModels(model),
      prepare: async () => {
        throw new Error("missing metadata");
      },
      unexpectedReply: "Something went wrong. Please try again."
    });

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(2);
    expect(
      partsText(expectTerminalReply(bus, TaskState.TASK_STATE_FAILED)?.parts)
    ).toBe("Something went wrong. Please try again.");
  });

  it("always calls finished() even when the second appendMessage throws", async () => {
    const session = new FakeSession();
    // Let the first appendMessage (user turn) succeed, fail on the second (assistant turn).
    session.appendSpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("SQL error"));

    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Hi") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext(),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
  });

  it("publishes textual tool-loop steps without persisting them", async () => {
    const session = new FakeSession();
    let generation = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        if (generation++ === 0) {
          return {
            ...toolCallResult("lookup", {}),
            content: [
              { type: "text", text: "I will check that." },
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "lookup",
                input: "{}"
              }
            ]
          } as never;
        }
        return okResult("Here is what I found.") as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model), {
        prepare: async () => ({
          session,
          systemSuffix: "",
          tools: {
            lookup: tool({
              description: "Lookup a value.",
              inputSchema: z.object({}),
              execute: async () => "found"
            })
          }
        })
      })
    );

    expect(bus.published).toHaveLength(3);
    expect(statusEventAt(bus, 1)).toMatchObject({
      taskId: "task-1",
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: { messageId: "m1:step:0" }
      }
    });
    expect(partsText(statusEventAt(bus, 1).status?.message?.parts)).toBe(
      "I will check that."
    );
    expect(expectTerminalReply(bus)?.parts[0]).toMatchObject({
      content: { $case: "text", value: "Here is what I found." }
    });
    expect(session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(session.messages[1].parts[0]).toMatchObject({
      type: "text",
      text: "Here is what I found."
    });
  });

  it("does not double-post the final text when generation stops at the step limit", async () => {
    const session = new FakeSession();
    // Every step emits text + a tool call, so the loop never reaches a plain
    // stop and instead halts at the step limit. The final step's text is both
    // streamed non-terminally (`:step:N`) and returned as `result.text`.
    let n = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        const i = n++;
        return {
          ...toolCallResult("lookup", {}),
          content: [
            { type: "text", text: `step-${i}` },
            {
              type: "tool-call",
              toolCallId: `tc${i}`,
              toolName: "lookup",
              input: "{}"
            }
          ]
        } as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model), {
        prepare: async () => ({
          session,
          systemSuffix: "",
          tools: {
            lookup: tool({
              description: "Lookup a value.",
              inputSchema: z.object({}),
              execute: async () => "found"
            })
          }
        })
      })
    );

    // The final step's text was streamed as a non-terminal update; the terminal
    // event completes the task with empty text so it isn't posted twice.
    const stepTexts = bus.published.flatMap((e) =>
      e.kind === "statusUpdate" &&
      e.data.status?.state === TaskState.TASK_STATE_WORKING
        ? [partsText(e.data.status.message?.parts)]
        : []
    );
    const lastStepText = stepTexts.at(-1);
    expect(lastStepText).toBeTruthy();

    const terminal = expectTerminalReply(bus);
    expect(partsText(terminal?.parts)).toBe("");

    // The final text appears exactly once across every published event…
    const allTexts = bus.published.map((e) =>
      e.kind === "statusUpdate" ? partsText(e.data.status?.message?.parts) : ""
    );
    expect(allTexts.filter((t) => t === lastStepText)).toHaveLength(1);
    // …yet the full reply is still persisted to session history.
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1].parts[0]).toMatchObject({
      type: "text",
      text: lastStepText
    });
  });
});

// ---------------------------------------------------------------------------
// Cancellation (🛑 recorded on the task row, read back between steps)
// ---------------------------------------------------------------------------

describe("executeAgentTurn — cancellation", () => {
  /** A tool-calling first step, then a final answer — i.e. a two-step turn. */
  function toolLoopModel(onGeneration: (n: number) => void) {
    let generation = 0;
    return new MockLanguageModelV3({
      doGenerate: async () => {
        onGeneration(generation);
        return (
          generation++ === 0
            ? toolCallResult("work", {})
            : okResult("Here is the answer.")
        ) as never;
      }
    });
  }

  function runTurn(
    session: SessionLike,
    model: LanguageModel,
    isCanceled?: AgentTurnConfig["isCanceled"]
  ) {
    const bus = fakeEventBus();
    const done = executeAgentTurn(
      fakeRequestContext("do some work"),
      bus.eventBus,
      makeCfg(session, fakeModels(model), {
        isCanceled,
        prepare: async () => ({
          session,
          systemSuffix: "",
          tools: {
            work: tool({
              description: "Do some work.",
              inputSchema: z.object({}),
              execute: async () => "done"
            })
          }
        })
      })
    );
    return { bus, done };
  }

  it("stops before the next step once a 🛑 is recorded", async () => {
    const generations: number[] = [];
    const session = new FakeSession();
    const { bus, done } = runTurn(
      session,
      toolLoopModel((n) => generations.push(n)),
      async () => true
    );
    await done;

    // The second model call — the one that would have produced the answer — is
    // never made. That is the work the stop actually saves.
    expect(generations).toEqual([0]);
    expect(statusEventAt(bus, -1)).toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED }
    });
    // Empty: the gatekeeper posts its own "🛑 Stopped." notice.
    expect(partsText(statusEventAt(bus, -1).status?.message?.parts)).toBe("");
    expect(bus.finished).toHaveBeenCalledTimes(1);
  });

  it("is keyed by the dispatch token so it reads its own row", async () => {
    const seen: string[] = [];
    const { done } = runTurn(
      new FakeSession(),
      toolLoopModel(() => {}),
      async (token) => {
        seen.push(token);
        return true;
      }
    );
    await done;

    // `m1` is the messageId on the request context — the same value the gatekeeper
    // uses as the task row's token.
    expect(seen).toEqual(["m1"]);
  });

  it("records the stop in history so the next turn doesn't redo the work", async () => {
    const session = new FakeSession();
    const { done } = runTurn(
      session,
      toolLoopModel(() => {}),
      async () => true
    );
    await done;

    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1].parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("stopped by the user")
    });
  });

  it("runs to completion when no stop is recorded", async () => {
    const generations: number[] = [];
    const session = new FakeSession();
    const { bus, done } = runTurn(
      session,
      toolLoopModel((n) => generations.push(n)),
      async () => false
    );
    await done;

    expect(generations).toEqual([0, 1]);
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "Here is the answer."
    );
  });

  it("keeps going when the stop check itself fails", async () => {
    // The check reads D1 mid-turn. A blip there must not destroy a turn nobody
    // asked to stop.
    const session = new FakeSession();
    const { bus, done } = runTurn(
      session,
      toolLoopModel(() => {}),
      async () => {
        throw new Error("d1 unavailable");
      }
    );
    await done;

    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "Here is the answer."
    );
  });

  it("withholds the answer of a single-step turn that was stopped", async () => {
    // A one-call turn has no step boundary to be interrupted at, so the work runs
    // to completion — but the reply must not reach Slack after the user was told
    // "🛑 Stopped." The post-generation check is what withholds it.
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("answered in one shot") as never
    });
    const { bus, done } = runTurn(session, model, async () => true);
    await done;

    expect(statusEventAt(bus, -1)).toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED }
    });
    expect(publishedText(bus)).not.toContain("answered in one shot");
    // The compute was spent, so history records the reply was abandoned, not given.
    expect(session.messages[1]?.parts[0]).toMatchObject({
      text: expect.stringContaining("stopped by the user")
    });
  });

  it("checks once more after generation, not only between steps", async () => {
    // Simulates a 🛑 landing while the final model call was in flight: no boundary
    // is left, so only the post-generation check can catch it.
    let stopped = false;
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        stopped = true; // the stop lands during this call
        return okResult("too late to be useful") as never;
      }
    });
    const { bus, done } = runTurn(session, model, async () => stopped);
    await done;

    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
  });
});

// ---------------------------------------------------------------------------
// Human-in-the-loop park (a tool calls turn.park → end in input-required)
// ---------------------------------------------------------------------------

describe("executeAgentTurn — HITL park", () => {
  const request = {
    type: "io.looping.hitl.request",
    requestId: "req-1",
    requestKind: "choice",
    prompt: "Which environment?",
    options: [{ id: "opt_0", label: "dev" }],
    allowFreeform: true
  };

  /** A model that calls `ask` on its first step; a second step would answer. */
  function askThenAnswerModel(onGeneration: () => void) {
    let n = 0;
    return new MockLanguageModelV3({
      doGenerate: async () => {
        onGeneration();
        return (
          n++ === 0 ? toolCallResult("ask", {}) : okResult("unreachable")
        ) as never;
      }
    });
  }

  it("ends the turn in input-required with the request DataPart, no terminal reply", async () => {
    const session = new FakeSession();
    let generations = 0;
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("set up an agent"),
      bus.eventBus,
      makeCfg(session, fakeModels(askThenAnswerModel(() => generations++)), {
        prepare: async (_t, _m, turn) => ({
          session,
          systemSuffix: "",
          tools: {
            ask: tool({
              description: "Ask the user.",
              inputSchema: z.object({}),
              execute: async () => {
                turn.park(request as never);
                return { status: "awaiting_user" };
              }
            })
          }
        })
      })
    );

    // The turn always finishes, but the model's second (answering) step never runs.
    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(generations).toBe(1);

    // Terminal event is input-required (an interrupted, non-terminal task
    // state) carrying the HITL data part.
    const last = statusEventAt(bus, -1);
    expect(last).toMatchObject({
      taskId: "task-1",
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: { messageId: "m1:hitl" }
      }
    });
    const parts = last.status?.message?.parts ?? [];
    expect(partsText(parts)).toBe("Which environment?");
    expect(
      parts.some((p) => {
        const data = dataOf(p) as
          { type?: string; requestId?: string } | undefined;
        return (
          data?.type === "io.looping.hitl.request" && data.requestId === "req-1"
        );
      })
    ).toBe(true);

    // No completed/canceled terminal was published.
    const states = publishedStates(bus);
    expect(states).not.toContain(TaskState.TASK_STATE_COMPLETED);
    expect(states).not.toContain(TaskState.TASK_STATE_CANCELED);

    // The prompt is persisted as the assistant turn so the resumed turn has context.
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1].parts[0]).toMatchObject({
      type: "text",
      text: "Which environment?"
    });
  });

  it("a recorded 🛑 wins over a park (no prompt is raised)", async () => {
    const session = new FakeSession();
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("set up an agent"),
      bus.eventBus,
      makeCfg(session, fakeModels(askThenAnswerModel(() => {})), {
        isCanceled: async () => true,
        prepare: async (_t, _m, turn) => ({
          session,
          systemSuffix: "",
          tools: {
            ask: tool({
              description: "Ask the user.",
              inputSchema: z.object({}),
              execute: async () => {
                turn.park(request as never);
                return { status: "awaiting_user" };
              }
            })
          }
        })
      })
    );

    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
    expect(publishedStates(bus)).not.toContain(
      TaskState.TASK_STATE_INPUT_REQUIRED
    );
  });
});

// ---------------------------------------------------------------------------
// Forced ending (`requireFinalReply`) — prose is no longer an outcome.
//
// The failure these cover really happened: five consecutive admin turns came back
// `finish_reason: stop` with zero tool calls, each rendering a confident "Feito! ✅"
// table, while the database showed nothing had been written.
// ---------------------------------------------------------------------------

/** A step that emits some narration alongside `toolName`. */
function narratedToolCall(text: string, toolName: string, input: unknown) {
  return {
    ...toolCallResult(toolName, input),
    content: [
      { type: "text", text },
      {
        type: "tool-call",
        toolCallId: `tc-${toolName}`,
        toolName,
        input: JSON.stringify(input)
      }
    ]
  };
}

/** A `final_reply` call preceded by narration in the same step. */
function narratedFinalReply(text: string, reply: string) {
  return {
    ...finalReplyResult(reply),
    content: [
      { type: "text", text },
      {
        type: "tool-call",
        toolCallId: "fr1",
        toolName: "final_reply",
        input: JSON.stringify({ text: reply })
      }
    ]
  };
}

const workTool = tool({
  description: "Do some work.",
  inputSchema: z.object({ name: z.string().optional() }),
  execute: async () => ({ ok: true })
});

function forcedCfg(
  session: SessionLike,
  models: ModelPair,
  overrides: Partial<AgentTurnConfig> = {}
): AgentTurnConfig {
  return makeCfg(session, models, {
    requireFinalReply: true,
    recordToolCalls: true,
    prepare: async () => ({
      session,
      systemSuffix: "",
      tools: { work: workTool }
    }),
    ...overrides
  });
}

/** The tool parts of the persisted assistant message, if any. */
function persistedActions(session: FakeSession) {
  const assistant = session.messages.find((m) => m.role === "assistant");
  return (assistant?.parts ?? []).filter((p) => p.type.startsWith("tool-"));
}

describe("executeAgentTurn — forced final_reply", () => {
  it("takes the final_reply call's text as the reply", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => finalReplyResult("Here are your agents.") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("list agents"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model))
    );

    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "Here are your agents."
    );
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(sessionText(session.messages[1])).toBe("Here are your agents.");
  });

  it("declares final_reply and forces a tool choice", async () => {
    const session = new FakeSession();
    const seen: { tools: string[]; toolChoice: unknown }[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seen.push({
          tools: (options.tools ?? []).map((t) => t.name),
          toolChoice: options.toolChoice
        });
        return finalReplyResult("ok") as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model))
    );

    expect(seen[0].toolChoice).toEqual({ type: "required" });
    // Declared first: tool order is part of the prompt, and reaching an ending is
    // the thing every turn has to do.
    expect(seen[0].tools[0]).toBe("final_reply");
    expect(seen[0].tools).toContain("work");
  });

  it("never ships narration as an answer: prose burns both slots and apologizes", async () => {
    // The regression. Under the old loop this exact generation — text, no call —
    // completed the task successfully and told the user the work was done.
    const session = new FakeSession();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = new MockLanguageModelV3({
      doGenerate: async () => {
        primaryCalls++;
        return okResult("Feito! ✅ I updated the endpoint.") as never;
      }
    });
    const fallback = new MockLanguageModelV3({
      doGenerate: async () => {
        fallbackCalls++;
        return okResult("Feito! ✅ I updated the endpoint.") as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update the endpoint"),
      bus.eventBus,
      forcedCfg(session, fakeModels(primary, fallback))
    );

    expect(primaryCalls).toBeGreaterThan(0);
    expect(fallbackCalls).toBeGreaterThan(0);
    // The claim never reaches the user, and is never persisted as history.
    expect(publishedText(bus)).not.toContain("Feito!");
    expect(partsText(expectTerminalReply(bus)?.parts)).toMatch(
      /temporarily unavailable/i
    );
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("repairs a blank final_reply on the same model", async () => {
    const session = new FakeSession();
    const prompts: string[] = [];
    let n = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return (
          n++ === 0 ? finalReplyResult("   ") : finalReplyResult("Real answer.")
        ) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model))
    );

    expect(prompts).toHaveLength(2);
    // The rejection is shown to the model as a failed tool result…
    expect(prompts[1]).toContain("final_reply");
    expect(prompts[1]).toContain("must not be blank");
    // …and the blank reply never reaches the user.
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe("Real answer.");
    // The repair exchange is ephemeral — history keeps only the ending it landed on.
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(sessionText(session.messages[1])).toBe("Real answer.");
  });

  it("forces a final round when the turn spends every step on work", async () => {
    const session = new FakeSession();
    const declared: string[][] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const names = (options.tools ?? []).map((t) => t.name);
        declared.push(names);
        // Keep working for as long as there is anything to work with.
        return (
          names.includes("work")
            ? narratedToolCall("still going", "work", {})
            : finalReplyResult("Here is what I managed.")
        ) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("do a lot"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model))
    );

    // The last call is the final round: nothing on the table but the reply.
    expect(declared.at(-1)).toEqual(["final_reply"]);
    // The user gets the real summary, not an apology for an outage that never happened.
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "Here is what I managed."
    );
    expect(publishedText(bus)).not.toMatch(/temporarily unavailable/i);
  });

  it("publishes intermediate narration but not the final_reply step's text", async () => {
    const session = new FakeSession();
    let n = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        (n++ === 0
          ? narratedToolCall("I will check that.", "work", {})
          : narratedFinalReply(
              "thinking out loud",
              "Here is what I found."
            )) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model))
    );

    expect(publishedText(bus)).toContain("I will check that.");
    // Publishing the ending step's text too would post the same thought twice.
    expect(publishedText(bus)).not.toContain("thinking out loud");
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "Here is what I found."
    );
  });

  it("lets a park out-rank a final_reply emitted in the same step", async () => {
    const session = new FakeSession();
    const request = {
      type: "io.looping.hitl.request",
      requestId: "req-1",
      requestKind: "choice",
      prompt: "Which environment?",
      options: [{ id: "opt_0", label: "dev" }],
      allowFreeform: true
    };
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        ({
          ...toolCallResult("ask", {}),
          content: [
            {
              type: "tool-call",
              toolCallId: "tc-ask",
              toolName: "ask",
              input: "{}"
            },
            {
              type: "tool-call",
              toolCallId: "fr1",
              toolName: "final_reply",
              input: JSON.stringify({ text: "Using dev." })
            }
          ]
        }) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("set up an agent"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model), {
        prepare: async (_t, _m, turn) => ({
          session,
          systemSuffix: "",
          tools: {
            ask: tool({
              description: "Ask the user.",
              inputSchema: z.object({}),
              execute: async () => {
                turn.park(request as never);
                return { status: "awaiting_user" };
              }
            })
          }
        })
      })
    );

    // Asking is the more committal act, so the question is raised and the answer
    // it would have given is discarded.
    expect(publishedStates(bus).at(-1)).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED
    );
    expect(publishedText(bus)).not.toContain("Using dev.");
  });

  it("lets a 🛑 out-rank everything, with no fallback or final round after it", async () => {
    const session = new FakeSession();
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return narratedToolCall("working", "work", {}) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("do some work"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model), { isCanceled: async () => true })
    );

    expect(calls).toBe(1);
    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
  });
});

// ---------------------------------------------------------------------------
// Tool-call evidence in history (`recordToolCalls`)
//
// History used to keep only the assistant's final text, so a fabricated claim
// became fact for every later turn. Now the transcript either contains the call
// or visibly does not.
// ---------------------------------------------------------------------------

describe("executeAgentTurn — recorded tool calls", () => {
  it("persists a call's input and output alongside the reply", async () => {
    const session = new FakeSession();
    let n = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("work", { name: "arc-player" })
          : finalReplyResult("Updated the endpoint.")) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update it"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model))
    );

    const actions = persistedActions(session);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "tool-work",
      state: "output-available",
      input: { name: "arc-player" },
      output: { ok: true }
    });
    // The reply is still the only text — recall and FTS see no tool JSON.
    expect(sessionText(session.messages[1])).toBe("Updated the endpoint.");
  });

  it("records nothing when the turn called nothing — the absence is the evidence", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => finalReplyResult("Feito! ✅") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update it"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model))
    );

    // A later turn asked "did that go through?" can now see that it did not.
    expect(persistedActions(session)).toHaveLength(0);
    expect(sessionText(session.messages[1])).toBe("Feito! ✅");
  });

  it("never records final_reply itself as an action", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => finalReplyResult("done") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model))
    );

    expect(persistedActions(session)).toHaveLength(0);
  });

  it("keeps calls that ran before a 🛑 — the side effects are real", async () => {
    const session = new FakeSession();
    let stopped = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        const result = toolCallResult("work", {});
        stopped = true;
        return result as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("do some work"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model), { isCanceled: async () => stopped })
    );

    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
    expect(persistedActions(session)).toHaveLength(1);
    expect(sessionText(session.messages[1])).toContain("stopped by the user");
  });

  it("keeps calls that ran before a HITL park", async () => {
    const session = new FakeSession();
    const request = {
      type: "io.looping.hitl.request",
      requestId: "req-1",
      requestKind: "approval",
      prompt: "Delete arc-player?"
    };
    let n = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("work", {})
          : toolCallResult("ask", {})) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("delete it"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model), {
        prepare: async (_t, _m, turn) => ({
          session,
          systemSuffix: "",
          tools: {
            work: workTool,
            ask: tool({
              description: "Ask the user.",
              inputSchema: z.object({}),
              execute: async () => {
                turn.park(request as never);
                return { status: "awaiting_approval" };
              }
            })
          }
        })
      })
    );

    expect(publishedStates(bus).at(-1)).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED
    );
    // Both the work that ran and the question that parked the turn.
    expect(persistedActions(session).map((p) => p.type)).toEqual([
      "tool-work",
      "tool-ask"
    ]);
    expect(sessionText(session.messages[1])).toBe("Delete arc-player?");
  });

  it("records a failed call so a later turn cannot confirm it as a success", async () => {
    const session = new FakeSession();
    let n = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("work", {})
          : finalReplyResult("That didn't work.")) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update it"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model), {
        prepare: async () => ({
          session,
          systemSuffix: "",
          tools: {
            // The annotation matters: an `execute` that only ever throws infers
            // `Promise<never>`, which collapses the tool's output generic.
            work: tool({
              description: "Do some work.",
              inputSchema: z.object({}),
              execute: async (): Promise<{ ok: boolean }> => {
                throw new Error("no such agent");
              }
            })
          }
        })
      })
    );

    const actions = persistedActions(session);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ state: "output-error" });
    expect(
      (actions[0] as unknown as { errorText: string }).errorText
    ).toContain("no such agent");
  });

  it("keeps the record when the turn produced no reply at all", async () => {
    // The apology is not persisted — it says nothing true about the workspace —
    // but a call that ran and left no trace is how the next turn ends up guessing.
    const session = new FakeSession();
    let n = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("work", {})
          : okResult("Feito! ✅")) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update it"),
      bus.eventBus,
      forcedCfg(session, fakeModels(model))
    );

    expect(partsText(expectTerminalReply(bus)?.parts)).toMatch(
      /temporarily unavailable/i
    );
    expect(publishedText(bus)).not.toContain("Feito!");
    expect(persistedActions(session)).toHaveLength(1);
  });

  it("stays off for agents that have not opted in", async () => {
    const session = new FakeSession();
    let n = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("work", {})
          : okResult("Here is what I found.")) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model), {
        prepare: async () => ({
          session,
          systemSuffix: "",
          tools: { work: workTool }
        })
      })
    );

    // The plain-text ending still answers, and history stays text-only.
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "Here is what I found."
    );
    expect(persistedActions(session)).toHaveLength(0);
  });
});
