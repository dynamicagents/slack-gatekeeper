import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError, RetryError, tool, type LanguageModel } from "ai";
import { z } from "zod";
import {
  Role,
  TaskState,
  type Message,
  type TaskStatusUpdateEvent
} from "@a2a-js/sdk";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";
import { buildMessage, dataOf, partsText } from "@/a2a/parts";
import {
  buildHitlResponseParts,
  buildHitlTimeoutParts,
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID,
  HITL_REQUEST_TYPE
} from "@/a2a/hitl";
import {
  isTransientAiError,
  executeAgentTurn,
  turnGatewayCall,
  type AgentTurnConfig
} from "@/agents/shared/loop";
import { askUserTool } from "@/agents/shared/ask-user";
import { NOT_ASKED_NOTE } from "@/agents/shared/open-call";
import {
  assistantSessionMessage,
  sessionText,
  userSessionMessage
} from "@/agents/shared/messages";
import {
  FakeSession,
  MemoryOpenCalls,
  fakeAgentSession,
  finalReplyResult,
  okResult,
  lengthResult,
  toolCallResult
} from "../../helpers/agents";
import { userMessage } from "../../helpers/a2a";
import { useStorageReset } from "../../helpers/storage";

useStorageReset();

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

function makeCfg(
  session: FakeSession,
  model: LanguageModel,
  overrides: Partial<AgentTurnConfig> = {}
): AgentTurnConfig {
  return {
    // One model whatever the round: these tests are about the loop, not about what
    // the gateway log says. `executeAgentTurn` calls this once per round of asking.
    model: () => model,
    prepare: async () => ({
      ...fakeAgentSession(session),
      systemSuffix: "",
      tools: {}
    }),
    unexpectedReply: "Something went wrong. Please try again.",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// isTransientAiError
// ---------------------------------------------------------------------------

/** What the provider hands us: a binding failure normalized to an APICallError. */
function bindingError(statusCode?: number) {
  return new APICallError({
    message: "Capacity temporarily exceeded",
    url: "workers-ai:binding/run/@cf/test",
    requestBodyValues: {},
    statusCode
  });
}

describe("isTransientAiError", () => {
  it("returns false for values the SDK never produced", () => {
    expect(isTransientAiError("string error")).toBe(false);
    expect(isTransientAiError(42)).toBe(false);
    expect(isTransientAiError(null)).toBe(false);
    expect(isTransientAiError(undefined)).toBe(false);
    expect(isTransientAiError(new Error("some unrelated failure"))).toBe(false);
  });

  it("is true for a retryable APICallError — the provider maps 3040 to 429", () => {
    expect(isTransientAiError(bindingError(429))).toBe(true);
  });

  it("is false for a status the provider will not retry", () => {
    expect(isTransientAiError(bindingError(400))).toBe(false);
  });

  it("unwraps a RetryError and classifies the failure underneath it", () => {
    expect(
      isTransientAiError(
        new RetryError({
          message: "Failed after 3 attempts",
          reason: "maxRetriesExceeded",
          errors: [bindingError(429), bindingError(429)]
        })
      )
    ).toBe(true);
  });

  // Pinned, not overlooked. Workers AI code 3046 is absent from the provider's
  // code→status table, so `normalizeBindingError` builds an APICallError with no
  // status and it reads as permanent. The substring match this replaced did catch
  // it — along with any error that merely mentioned the number. The fix belongs
  // upstream in the table; this test is here to notice when it lands.
  it("does not recognize 3046, which arrives with no status code", () => {
    expect(isTransientAiError(bindingError(undefined))).toBe(false);
    expect(isTransientAiError(new Error("3046 returned from model"))).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// turnGatewayCall
// ---------------------------------------------------------------------------

describe("turnGatewayCall", () => {
  /** The wire metadata a real admin turn arrives with, user and all. */
  const adminMetadata = {
    agentKind: "local",
    tenant: "admin",
    adminWorkspaceId: 7,
    user: { slackUserId: "U123", slackUserName: "grace" }
  };

  it("labels a round with the agent, the thread and the workspace", () => {
    const call = turnGatewayCall(
      "admin",
      fakeRequestContext("hi", {
        contextId: "C123:1700000000.0001",
        metadata: adminMetadata
      }),
      1
    );

    expect(call).toEqual({
      agent: "admin",
      phase: "round",
      round: 1,
      channel: "C123:1700000000.0001",
      workspaceId: 7,
      eventId: "task-1:r1"
    });
  });

  it("names the task and the round in the event id, and only there", () => {
    // `${taskId}:r${round}` rides on `GatewayOptions.eventId`, which is its own
    // field on the request — so the join from a gateway row back to the task that
    // paid for it spends none of the five, and `taskId` stays off this side.
    const round = (n: number) =>
      turnGatewayCall(
        "admin",
        fakeRequestContext("hi", { metadata: adminMetadata }),
        n
      );

    expect(round(1).eventId).toBe("task-1:r1");
    // The salvage is a second charge for the same turn. Same task, different round:
    // the two are only distinguishable because the number is in both.
    expect(round(2).eventId).toBe("task-1:r2");
    expect(round(2).round).toBe(2);
    expect(round(1)).not.toHaveProperty("taskId");
  });

  it("takes the agent from the executor, not from the wire", () => {
    // The wire `tenant` is an open string on the remote arm of the union, so it
    // cannot be a closed gateway dimension. The executor passing its own literal is
    // also what stops a forged `tenant` from relabelling someone else's spend.
    const call = turnGatewayCall(
      "onboarding",
      fakeRequestContext("hi", {
        metadata: { agentKind: "local", tenant: "anything-at-all" }
      }),
      1
    );

    expect(call.agent).toBe("onboarding");
    expect(call.workspaceId).toBeUndefined();
  });

  it("leaves the Slack user behind, though it reads the message that carries one", () => {
    // The privacy regression, at the one call site that has a person to hand: the
    // wire metadata it reads holds `user.slackUserId`, one property away, and the
    // gateway log is retained account-wide. Fields are picked out by name for
    // exactly this reason — see `gatewayLogFields` in model.spec.ts.
    const call = turnGatewayCall(
      "admin",
      fakeRequestContext("hi", { metadata: adminMetadata }),
      1
    );

    expect(JSON.stringify(call)).not.toContain("U123");
    expect(JSON.stringify(call)).not.toContain("grace");
    expect(call).not.toHaveProperty("user");
  });
});

// ---------------------------------------------------------------------------
// executeAgentTurn
// ---------------------------------------------------------------------------

describe("executeAgentTurn", () => {
  it("asks for a model per round, numbering the salvage apart from the round", async () => {
    // The turn and the salvage are two charges against the gateway, and a model
    // freezes its metadata at construction — so one model for both would put them in
    // the log as the same call made twice.
    const session = new FakeSession();
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        (n++ === 0
          ? okResult("Done! ✅")
          : finalReplyResult("Here is what happened.")) as never
    });
    const rounds: number[] = [];
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update the endpoint"),
      bus.eventBus,
      forcedCfg(session, model, {
        model: (round) => {
          rounds.push(round);
          return model;
        }
      })
    );

    expect(rounds).toEqual([1, 2]);
  });

  it("builds only the round's model when no salvage is needed", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () => okResult("Hello!") as never
    });
    const rounds: number[] = [];
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, model, {
        model: (round) => {
          rounds.push(round);
          return model;
        }
      })
    );

    expect(rounds).toEqual([1]);
  });

  it("happy path: appends user + assistant messages and completes a task", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () => okResult("Hello!") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, model)
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
    const model = new MockLanguageModelV4({
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
      makeCfg(session, model)
    );

    const userTurn = session.messages.find((m) => m.role === "user");
    expect(userTurn?.parts[0]).toMatchObject({ type: "text", text: wrapped });
  });

  it("publishes the transient reply when a transient error propagates to the outer catch", async () => {
    // Injected through prepare(): the outer catch classifies whatever reaches it,
    // and a throw there exercises that branch without a model in the way.
    const bus = fakeEventBus();
    const model = new MockLanguageModelV4({
      doGenerate: async () => okResult("unused") as never
    });

    await executeAgentTurn(fakeRequestContext("hi"), bus.eventBus, {
      model: () => model,
      prepare: async () => {
        throw bindingError(429);
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
    const model = new MockLanguageModelV4({
      doGenerate: async () => okResult("unused") as never
    });

    await executeAgentTurn(fakeRequestContext("hi"), bus.eventBus, {
      model: () => model,
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
    const model = new MockLanguageModelV4({
      doGenerate: async () => okResult("   ") as never // whitespace-only → trims to ""
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, model)
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
    const model = new MockLanguageModelV4({
      doGenerate: async () => lengthResult("truncated content here") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, model)
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(partsText(expectTerminalReply(bus)?.parts)).toMatch(
      /temporarily unavailable/i
    );
    // Assistant message must NOT be persisted when the reply was truncated
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("publishes unexpectedReply and still finishes when prepare() throws", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => okResult("unused") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(fakeRequestContext(), bus.eventBus, {
      model: () => model,
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

    const model = new MockLanguageModelV4({
      doGenerate: async () => okResult("Hi") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext(),
      bus.eventBus,
      makeCfg(session, model)
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
  });

  it("publishes textual tool-loop steps without persisting them", async () => {
    const session = new FakeSession();
    let generation = 0;
    const model = new MockLanguageModelV4({
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
      makeCfg(session, model, {
        prepare: async () => ({
          ...fakeAgentSession(session),
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
    const model = new MockLanguageModelV4({
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
      makeCfg(session, model, {
        prepare: async () => ({
          ...fakeAgentSession(session),
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
    return new MockLanguageModelV4({
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
    session: FakeSession,
    model: LanguageModel,
    isCanceled?: AgentTurnConfig["isCanceled"]
  ) {
    const bus = fakeEventBus();
    const done = executeAgentTurn(
      fakeRequestContext("do some work"),
      bus.eventBus,
      makeCfg(session, model, {
        isCanceled,
        prepare: async () => ({
          ...fakeAgentSession(session),
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
    const model = new MockLanguageModelV4({
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
    const model = new MockLanguageModelV4({
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
  session: FakeSession,
  model: LanguageModel,
  overrides: Partial<AgentTurnConfig> = {}
): AgentTurnConfig {
  return makeCfg(session, model, {
    requireFinalReply: true,
    recordToolCalls: true,
    prepare: async () => ({
      ...fakeAgentSession(session),
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
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Here are your agents.") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("list agents"),
      bus.eventBus,
      forcedCfg(session, model)
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
    const model = new MockLanguageModelV4({
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
      forcedCfg(session, model)
    );

    expect(seen[0].toolChoice).toEqual({ type: "required" });
    // Declared first: tool order is part of the prompt, and reaching an ending is
    // the thing every turn has to do.
    expect(seen[0].tools[0]).toBe("final_reply");
    expect(seen[0].tools).toContain("work");
  });

  it("never ships narration as an answer: it apologizes instead", async () => {
    // The regression. Under the old loop this exact generation — text, no call —
    // completed the task successfully and told the user the work was done. Reaching
    // for a second model is a layer below this one now: by the time the SDK reports
    // the violation, the model's own fallback has already answered in prose too.
    const session = new FakeSession();
    const declared: string[][] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        declared.push((options.tools ?? []).map((t) => t.name));
        return okResult("Feito! ✅ I updated the endpoint.") as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update the endpoint"),
      bus.eventBus,
      forcedCfg(session, model)
    );

    // Narrated under `required`, then again under the enforced salvage — and no
    // further: the salvage is asked once.
    expect(declared).toHaveLength(2);
    expect(declared[1]).toEqual(["final_reply"]);
    // The claim never reaches the user, and is never persisted as history.
    expect(publishedText(bus)).not.toContain("Feito!");
    expect(partsText(expectTerminalReply(bus)?.parts)).toMatch(
      /temporarily unavailable/i
    );
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("repairs a blank final_reply within the same call", async () => {
    const session = new FakeSession();
    const prompts: string[] = [];
    const declared: string[][] = [];
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        declared.push((options.tools ?? []).map((t) => t.name));
        return (
          n++ === 0 ? finalReplyResult("   ") : finalReplyResult("Real answer.")
        ) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      forcedCfg(session, model)
    );

    // Two steps of one call, not two calls: the SDK rejects the input against the
    // tool's own schema and feeds the model its error on the next step.
    expect(prompts).toHaveLength(2);
    // Still a working step, work tools and all — not the ending-only salvage call,
    // which would also have fixed the reply and hidden a loop that stopped on the
    // rejected call instead of handing it back.
    expect(declared[1]).toContain("work");
    expect(prompts[1]).toContain("final_reply");
    expect(prompts[1]).toContain("Invalid input for tool");
    expect(prompts[1]).toContain("must not be blank");
    // The blank reply never reaches the user.
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe("Real answer.");
    // The repair is ephemeral — history keeps only the ending it landed on.
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(sessionText(session.messages[1])).toBe("Real answer.");
  });

  it("reserves the last step for the ending when the turn spends every other one", async () => {
    const session = new FakeSession();
    const declared: string[][] = [];
    const choices: unknown[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const names = (options.tools ?? []).map((t) => t.name);
        declared.push(names);
        choices.push(options.toolChoice);
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
      forcedCfg(session, model)
    );

    // The ending is the last step of the one call, not an eleventh call after it.
    expect(declared).toHaveLength(10);
    expect(declared.at(-1)).toEqual(["final_reply"]);
    // Named, not merely `required`. With one tool on the table the two would pick
    // the same call here, but only the named form is enforced server-side — the
    // advisory one is what fails open into prose, and it is exactly what the working
    // steps before it keep.
    expect(choices.at(-1)).toEqual({ type: "tool", toolName: "final_reply" });
    expect(choices[0]).toEqual({ type: "required" });
    // The user gets the real summary, not an apology for an outage that never happened.
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "Here is what I managed."
    );
    expect(publishedText(bus)).not.toMatch(/temporarily unavailable/i);
  });

  it("shows the ending step the work it is being asked to report", async () => {
    // The capability the separate final round did not have: it restarted from
    // history, so it answered for work it could not read.
    const session = new FakeSession();
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return (
          (options.tools ?? []).some((t) => t.name === "work")
            ? narratedToolCall("still going", "work", {})
            : finalReplyResult("Here is what I managed.")
        ) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("do a lot"),
      bus.eventBus,
      forcedCfg(session, model)
    );

    // The tenth call is the loop's own ending step. An eleventh would be the salvage,
    // which also reads the run — and would pass this for the wrong reason.
    expect(prompts).toHaveLength(10);
    const ending = prompts.at(-1) ?? "";
    expect(ending).toContain('"toolName":"work"');
    expect(ending).toContain('"ok":true');
  });

  it("salvages a reply when the model narrates instead of ending", async () => {
    // `toolChoice: "required"` is advisory on Workers AI — it fails open into prose.
    // One more call with the ending *named* is the enforced form, and the work the
    // turn did comes back instead of being buried under an apology.
    const session = new FakeSession();
    const declared: string[][] = [];
    const choices: unknown[] = [];
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        declared.push((options.tools ?? []).map((t) => t.name));
        choices.push(options.toolChoice);
        return (
          n++ === 0
            ? okResult("Feito! ✅ I updated the endpoint.")
            : finalReplyResult("I could not do that, and here is why.")
        ) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update the endpoint"),
      bus.eventBus,
      forcedCfg(session, model)
    );

    expect(declared).toHaveLength(2);
    expect(declared[1]).toEqual(["final_reply"]);
    // The salvage's whole reason to exist is the stronger form. Asking again with the
    // advisory `required` that just failed open would be the same ask, repeated.
    expect(choices[0]).toEqual({ type: "required" });
    expect(choices[1]).toEqual({ type: "tool", toolName: "final_reply" });
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "I could not do that, and here is why."
    );
    // A turn that answered is completed, not failed — nothing went down.
    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    // The narrated claim still never reaches the user or history.
    expect(publishedText(bus)).not.toContain("Feito!");
  });

  it("salvages an ending the last step got wrong, with no budget left to repair it", async () => {
    const session = new FakeSession();
    let endings = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        if ((options.tools ?? []).some((t) => t.name === "work")) {
          return narratedToolCall("still going", "work", {}) as never;
        }
        // The first ending-only call is step 10: a blank reply there is rejected
        // with no step left to fix it. The second is the salvage.
        return (
          endings++ === 0
            ? finalReplyResult("   ")
            : finalReplyResult("Salvaged answer.")
        ) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("do a lot"),
      bus.eventBus,
      forcedCfg(session, model)
    );

    expect(endings).toBe(2);
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe("Salvaged answer.");
    expect(sessionText(session.messages[1])).toBe("Salvaged answer.");
  });

  it("lets a 🛑 out-rank the salvage: a stopped turn spends no more calls", async () => {
    const session = new FakeSession();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        return okResult("narrating instead of ending") as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update the endpoint"),
      bus.eventBus,
      forcedCfg(session, model, { isCanceled: async () => true })
    );

    expect(calls).toBe(1);
    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("publishes intermediate narration but not the final_reply step's text", async () => {
    const session = new FakeSession();
    let n = 0;
    const model = new MockLanguageModelV4({
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
      forcedCfg(session, model)
    );

    expect(publishedText(bus)).toContain("I will check that.");
    // Publishing the ending step's text too would post the same thought twice.
    expect(publishedText(bus)).not.toContain("thinking out loud");
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "Here is what I found."
    );
  });

  it("lets a 🛑 out-rank everything, with no fallback or final round after it", async () => {
    const session = new FakeSession();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        return narratedToolCall("working", "work", {}) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("do some work"),
      bus.eventBus,
      forcedCfg(session, model, { isCanceled: async () => true })
    );

    expect(calls).toBe(1);
    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
  });
});

// ---------------------------------------------------------------------------
// ask_user — a control tool with no handler. The turn pauses on the call itself,
// keeps it as an open call, and a human's answer resumes it as the call's result.
// ---------------------------------------------------------------------------

describe("executeAgentTurn — ask_user", () => {
  const question = {
    question: "Which environment?",
    options: [{ label: "dev" }, { label: "prod" }]
  };

  function askingCfg(
    session: FakeSession,
    model: LanguageModel,
    overrides: Partial<AgentTurnConfig> = {}
  ): AgentTurnConfig {
    return forcedCfg(session, model, {
      prepare: async () => ({
        ...fakeAgentSession(session),
        systemSuffix: "",
        tools: { work: workTool, ask_user: askUserTool }
      }),
      ...overrides
    });
  }

  /** The gatekeeper handing a human's answer back onto the parked task. */
  function resumeContext(
    parts: Message["parts"],
    metadata: Record<string, unknown> = {}
  ) {
    return {
      contextId: "ctx-1",
      taskId: "task-1",
      userMessage: buildMessage({
        messageId: "m2",
        role: Role.ROLE_USER,
        parts,
        contextId: "ctx-1",
        taskId: "task-1",
        metadata
      })
    } as never;
  }

  /** A button answer to `req-1`, as the gatekeeper sends it. */
  const answered = (humanText: string) =>
    buildHitlResponseParts({
      requestId: "req-1",
      optionId: "opt_1",
      answeredBy: "U9",
      humanText
    });

  /** The question as the pausing turn kept it. */
  const heldQuestion = () => ({
    requestId: "req-1",
    toolCallId: "tc-ask",
    toolName: "ask_user",
    input: question,
    createdAt: Date.now()
  });

  /** The HITL request data part on the last event published. */
  function raisedRequest(bus: { published: PublishedEvent[] }) {
    return (statusEventAt(bus, -1).status?.message?.parts ?? [])
      .map((p) => dataOf(p) as Record<string, unknown> | undefined)
      .find((d) => d?.type === HITL_REQUEST_TYPE);
  }

  it("pauses on the question and keeps the call until someone answers", async () => {
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        return toolCallResult("ask_user", question) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("set up an agent"),
      bus.eventBus,
      askingCfg(session, model, { openCalls })
    );

    // The call has no handler, so the loop stopped on it without being told to.
    expect(calls).toBe(1);
    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(statusEventAt(bus, -1)).toMatchObject({
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: { messageId: "m1:hitl" }
      }
    });
    const request = raisedRequest(bus);
    expect(request).toMatchObject({
      requestKind: "choice",
      prompt: "Which environment?",
      allowFreeform: true
    });
    expect(request?.options).toHaveLength(2);

    // Kept under the id Slack answers with — minted, never the provider's call id.
    const requestId = request?.requestId as string;
    expect(requestId).not.toBe("tc1");
    expect(openCalls.held.get(requestId)).toMatchObject({
      toolCallId: "tc1",
      toolName: "ask_user",
      input: question
    });

    // No reply went out, and the question is what the turn is recorded as saying.
    expect(publishedStates(bus)).not.toContain(TaskState.TASK_STATE_COMPLETED);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(sessionText(session.messages[1])).toBe("Which environment?");
  });

  it("keeps the question before raising it, so a fast answer finds it", async () => {
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    const model = new MockLanguageModelV4({
      doGenerate: async () => toolCallResult("ask_user", question) as never
    });
    const bus = fakeEventBus();
    let keptWhenRaised: number | undefined;
    bus.publish.mockImplementation((e: unknown) => {
      bus.published.push(e as never);
      const event = e as PublishedEvent;
      if (
        event.kind === "statusUpdate" &&
        event.data.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED
      ) {
        keptWhenRaised = openCalls.held.size;
      }
    });

    await executeAgentTurn(
      fakeRequestContext("set up an agent"),
      bus.eventBus,
      askingCfg(session, model, { openCalls })
    );

    // The prompt reaches Slack the moment it is published, and a click that beat
    // the record would resume nothing.
    expect(keptWhenRaised).toBe(1);
  });

  it("lets a 🛑 out-rank a question: nothing is raised or kept", async () => {
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    const model = new MockLanguageModelV4({
      doGenerate: async () => toolCallResult("ask_user", question) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("set up an agent"),
      bus.eventBus,
      askingCfg(session, model, {
        openCalls,
        isCanceled: async () => true
      })
    );

    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
    expect(publishedStates(bus)).not.toContain(
      TaskState.TASK_STATE_INPUT_REQUIRED
    );
    expect(openCalls.held.size).toBe(0);
  });

  it("lets a question out-rank a final_reply in the same step", async () => {
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          ...toolCallResult("ask_user", question),
          content: [
            {
              type: "tool-call",
              toolCallId: "tc-ask",
              toolName: "ask_user",
              input: JSON.stringify(question)
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
      askingCfg(session, model, { openCalls })
    );

    // Asking is the more committal act: the answer it would have given is dropped.
    expect(publishedStates(bus).at(-1)).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED
    );
    expect(publishedText(bus)).not.toContain("Using dev.");
    expect(openCalls.held.size).toBe(1);
  });

  it("keeps the calls that ran before the question", async () => {
    const session = new FakeSession();
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("work", {})
          : toolCallResult("ask_user", question)) as never
    });

    await executeAgentTurn(
      fakeRequestContext("set it up"),
      fakeEventBus().eventBus,
      askingCfg(session, model, { openCalls: new MemoryOpenCalls() })
    );

    expect(persistedActions(session).map((p) => p.type)).toEqual(["tool-work"]);
    expect(sessionText(session.messages[1])).toBe("Which environment?");
  });

  it("records a second question in the same step as not asked", async () => {
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    const other = { question: "And which region?", options: [{ label: "eu" }] };
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          ...toolCallResult("ask_user", question),
          content: [
            {
              type: "tool-call",
              toolCallId: "tc-a",
              toolName: "ask_user",
              input: JSON.stringify(question)
            },
            {
              type: "tool-call",
              toolCallId: "tc-b",
              toolName: "ask_user",
              input: JSON.stringify(other)
            }
          ]
        }) as never
    });

    await executeAgentTurn(
      fakeRequestContext("set it up"),
      fakeEventBus().eventBus,
      askingCfg(session, model, { openCalls })
    );

    // One call is open per turn. The other reached nobody, and history says so.
    expect([...openCalls.held.values()].map((p) => p.toolCallId)).toEqual([
      "tc-a"
    ]);
    expect(persistedActions(session)).toEqual([
      expect.objectContaining({
        type: "tool-ask_user",
        toolCallId: "tc-b",
        state: "output-error",
        errorText: NOT_ASKED_NOTE
      })
    ]);
  });

  it("fails the turn when the agent has nowhere to keep the question", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () => toolCallResult("ask_user", question) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("set it up"),
      bus.eventBus,
      askingCfg(session, model)
    );

    // A question nobody could ever answer is a wiring bug, not an outcome to park on.
    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_FAILED);
    expect(publishedStates(bus)).not.toContain(
      TaskState.TASK_STATE_INPUT_REQUIRED
    );
  });

  it("resumes an answer as the call's result, not as a user turn", async () => {
    const session = new FakeSession();
    session.messages.push(
      userSessionMessage("set up an agent"),
      assistantSessionMessage("Which environment?")
    );
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldQuestion());
    const seen: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(JSON.stringify(options.prompt.at(-1)));
        return finalReplyResult("Using prod.") as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      resumeContext(answered("prod"), { user: { displayName: "Grace" } }),
      bus.eventBus,
      askingCfg(session, model, { openCalls })
    );

    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(publishedText(bus)).toContain("Using prod.");
    // The model picks up where it left off: its prompt ends in the call's result.
    expect(seen[0]).toContain('"role":"tool"');
    expect(seen[0]).toContain('"answer":"prod"');
    expect(seen[0]).toContain('"answeredBy":"Grace"');
    // No user turn was added for the answer, and it was settled, not copied.
    expect(session.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant"
    ]);
    expect(openCalls.held.size).toBe(0);
    // The answered call is recorded as a message of its own, ahead of the reply.
    expect(session.messages[2].parts).toEqual([
      expect.objectContaining({
        type: "tool-ask_user",
        toolCallId: "tc-ask",
        state: "output-available",
        output: { answer: "prod", answeredBy: "Grace" }
      })
    ]);
    expect(sessionText(session.messages[3])).toBe("Using prod.");
  });

  it("resumes a question nobody answered as unanswered", async () => {
    const session = new FakeSession();
    session.messages.push(assistantSessionMessage("Which environment?"));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldQuestion());
    const seen: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(JSON.stringify(options.prompt.at(-1)));
        return finalReplyResult("No answer came back, so I left it.") as never;
      }
    });

    await executeAgentTurn(
      resumeContext(buildHitlTimeoutParts("req-1")),
      fakeEventBus().eventBus,
      askingCfg(session, model, { openCalls })
    );

    expect(seen[0]).toContain('"answered":false');
    expect(session.messages[1].parts[0]).toMatchObject({
      type: "tool-ask_user",
      state: "output-available",
      output: { answered: false }
    });
  });

  it("withholds ask_user from the turn a timeout resumed", async () => {
    // Nobody answered for a week. A turn free to ask again would park on a fresh
    // deadline and time out again, forever — so this one can only end.
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldQuestion());
    const offered: string[][] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        offered.push((options.tools ?? []).map((t) => t.name));
        return finalReplyResult("No answer came back, so I left it.") as never;
      }
    });

    await executeAgentTurn(
      resumeContext(buildHitlTimeoutParts("req-1")),
      fakeEventBus().eventBus,
      askingCfg(session, model, { openCalls })
    );

    expect(offered[0]).not.toContain("ask_user");
    // Only the question is withheld: the ending still has the turn's work to report.
    expect(offered[0]).toEqual(expect.arrayContaining(["final_reply", "work"]));
  });

  it("leaves ask_user on the table when a human did answer", async () => {
    // The human is present and engaged; a follow-up question costs them one click,
    // not another week of silence.
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldQuestion());
    const offered: string[][] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        offered.push((options.tools ?? []).map((t) => t.name));
        return finalReplyResult("Using prod.") as never;
      }
    });

    await executeAgentTurn(
      resumeContext(answered("prod")),
      fakeEventBus().eventBus,
      askingCfg(session, model, { openCalls })
    );

    expect(offered[0]).toContain("ask_user");
  });

  it("treats an answer with no open call as an ordinary message", async () => {
    // A question asked before open calls existed has nothing to take.
    const session = new FakeSession();
    const seen: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(JSON.stringify(options.prompt.at(-1)));
        return finalReplyResult("Using prod.") as never;
      }
    });

    await executeAgentTurn(
      resumeContext(answered("prod")),
      fakeEventBus().eventBus,
      askingCfg(session, model, { openCalls: new MemoryOpenCalls() })
    );

    expect(seen[0]).toContain('"role":"user"');
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(sessionText(session.messages[0])).toBe("prod");
  });

  it("settles a call once: a second delivery is an ordinary message", async () => {
    const session = new FakeSession();
    session.messages.push(assistantSessionMessage("Which environment?"));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldQuestion());
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Using prod.") as never
    });

    for (let i = 0; i < 2; i++) {
      await executeAgentTurn(
        resumeContext(answered("prod")),
        fakeEventBus().eventBus,
        askingCfg(session, model, { openCalls })
      );
    }

    const answers = session.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "tool-ask_user");
    expect(answers).toHaveLength(1);
    expect(
      session.messages.filter((m) => m.role === "user").map(sessionText)
    ).toEqual(["prod"]);
  });

  it("records the answer before the model runs, so no ending can lose it", async () => {
    const session = new FakeSession();
    session.messages.push(assistantSessionMessage("Which environment?"));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldQuestion());
    let recordedBeforeModel = false;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        recordedBeforeModel = session.messages.some((m) =>
          m.parts.some((p) => p.type === "tool-ask_user")
        );
        // An ending that writes nothing on its way out: the turn fails outright.
        throw new Error("model exploded");
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      resumeContext(answered("prod")),
      bus.eventBus,
      askingCfg(session, model, { openCalls })
    );

    // The gatekeeper has marked this answer as given and will not send it again,
    // so it has to be in history before anything can end the turn.
    expect(recordedBeforeModel).toBe(true);
    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_FAILED);
    expect(session.messages[1].parts[0]).toMatchObject({
      type: "tool-ask_user",
      output: { answer: "prod" }
    });
  });
});

// ---------------------------------------------------------------------------
// Approvals — a tool the policy gates. The turn pauses on the call itself, keeps
// it as an open call, and a human's Approve resumes it as the call the SDK runs.
// ---------------------------------------------------------------------------

describe("executeAgentTurn — approvals", () => {
  const input = { name: "arc-player" };
  const reason = "Delete *arc-player*?";

  /** A gated tool that records what it was actually asked to do. */
  function gatedTool() {
    const ran: unknown[] = [];
    return {
      ran,
      danger: tool({
        description: "Delete something, irreversibly.",
        inputSchema: z.object({ name: z.string() }),
        execute: async (args) => {
          ran.push(args);
          return { ok: true, deleted: args.name };
        }
      })
    };
  }

  /** Always stop for a human. */
  const asksAHuman = {
    danger: async () => ({ type: "user-approval", reason })
  };

  function gatedCfg(
    session: FakeSession,
    model: LanguageModel,
    gate: ReturnType<typeof gatedTool>,
    toolApproval: unknown,
    overrides: Partial<AgentTurnConfig> = {}
  ): AgentTurnConfig {
    return forcedCfg(session, model, {
      prepare: async () => ({
        ...fakeAgentSession(session),
        systemSuffix: "",
        tools: { work: workTool, ask_user: askUserTool, danger: gate.danger },
        toolApproval: toolApproval as never
      }),
      ...overrides
    });
  }

  /** The gatekeeper handing a decision back onto the parked task. */
  function resumeContext(parts: Message["parts"]) {
    return {
      contextId: "ctx-1",
      taskId: "task-1",
      userMessage: buildMessage({
        messageId: "m2",
        role: Role.ROLE_USER,
        parts,
        contextId: "ctx-1",
        taskId: "task-1",
        metadata: { user: { displayName: "Grace" } }
      })
    } as never;
  }

  const decision = (optionId: string, humanText: string) =>
    buildHitlResponseParts({
      requestId: "aitxt-1",
      optionId,
      answeredBy: "U9",
      humanText
    });

  /** The gated call as the pausing turn kept it. */
  const heldApproval = () => ({
    requestId: "aitxt-1",
    toolCallId: "tc-danger",
    toolName: "danger",
    input,
    approval: { reason },
    createdAt: Date.now()
  });

  /** The tool parts of the last assistant message the turn persisted. */
  function lastActions(session: FakeSession) {
    const assistant = [...session.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    return (assistant?.parts ?? []).filter((p) => p.type.startsWith("tool-"));
  }

  /** The HITL request data part on the last event published. */
  function raisedRequest(bus: { published: PublishedEvent[] }) {
    return (statusEventAt(bus, -1).status?.message?.parts ?? [])
      .map((p) => dataOf(p) as Record<string, unknown> | undefined)
      .find((d) => d?.type === HITL_REQUEST_TYPE);
  }

  it("pauses on a gated call and keeps it until someone decides", async () => {
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    const gate = gatedTool();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        return toolCallResult("danger", input) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("delete arc-player"),
      bus.eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    // The call is blocked, so it produces no output and the loop stops on it.
    expect(calls).toBe(1);
    expect(gate.ran).toHaveLength(0);
    expect(statusEventAt(bus, -1)).toMatchObject({
      status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }
    });
    const request = raisedRequest(bus);
    expect(request).toMatchObject({ requestKind: "approval", prompt: reason });

    // Kept under the SDK's own approval id — the replay has to quote it back.
    const held = [...openCalls.held.values()][0];
    expect(held).toMatchObject({ toolName: "danger", input });
    expect(held.requestId).toBe(request?.requestId);
    expect(publishedStates(bus)).not.toContain(TaskState.TASK_STATE_COMPLETED);
  });

  it("does not stop for anyone when the policy denies outright", async () => {
    // Nobody should be asked to approve a call that would be refused whatever
    // they answered. The model reads the refusal and ends the turn itself.
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    const gate = gatedTool();
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("danger", input)
          : finalReplyResult("I can't do that.")) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("delete arc-player"),
      bus.eventBus,
      gatedCfg(
        session,
        model,
        gate,
        { danger: async () => ({ type: "denied", reason: "Not yours." }) },
        { openCalls }
      )
    );

    expect(gate.ran).toHaveLength(0);
    expect(openCalls.held.size).toBe(0);
    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(publishedText(bus)).toContain("I can't do that.");
  });

  it("lets a question out-rank an approval raised in the same step", async () => {
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    const gate = gatedTool();
    const question = {
      question: "Which one?",
      options: [{ label: "arc-player" }]
    };
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          ...toolCallResult("ask_user", question),
          content: [
            {
              type: "tool-call",
              toolCallId: "tc-ask",
              toolName: "ask_user",
              input: JSON.stringify(question)
            },
            {
              type: "tool-call",
              toolCallId: "tc-danger",
              toolName: "danger",
              input: JSON.stringify(input)
            }
          ]
        }) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("delete one of them"),
      bus.eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    // Asking means the model is unsure what was wanted, and an approval decided
    // against an unclear request is the one decision a human should not be handed.
    expect(raisedRequest(bus)).toMatchObject({ requestKind: "choice" });
    expect([...openCalls.held.values()][0].toolName).toBe("ask_user");
    expect(gate.ran).toHaveLength(0);
    expect(lastActions(session)).toEqual([
      expect.objectContaining({
        type: "tool-danger",
        state: "output-error",
        errorText: NOT_ASKED_NOTE
      })
    ]);
  });

  it("resumes an approval by running the call the model actually made", async () => {
    const session = new FakeSession();
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Deleted it.") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      resumeContext(decision(HITL_APPROVE_OPTION_ID, "Approve")),
      bus.eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    // Exactly once, with the input that was on screen — not a re-description of it.
    expect(gate.ran).toEqual([input]);
    expect(publishedText(bus)).toContain("Deleted it.");
    expect(openCalls.held.size).toBe(0);
    // The decision and its outcome land on one part, so neither can be read alone.
    expect(lastActions(session)[0]).toMatchObject({
      type: "tool-danger",
      state: "output-available",
      output: { ok: true, deleted: "arc-player" },
      approval: { id: "aitxt-1", approved: true }
    });
  });

  it("names an approved call the turn carried out, which its model never asked for", async () => {
    // The gap Copilot found in the first draft. A replayed approval executes
    // *before* the first model step, so it appears in no model call's content —
    // and `tools` is built from that content. Logging nothing for it would leave
    // the single most consequential thing an admin turn does, a destructive call
    // a human signed off, invisible in the one line that says what the turn did.
    const session = new FakeSession();
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Deleted it.") as never
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await executeAgentTurn(
      resumeContext(decision(HITL_APPROVE_OPTION_ID, "Approve")),
      fakeEventBus().eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    const line = info.mock.calls.find((c) => c[0] === "[agent-turn]")?.[1] as
      Record<string, unknown> | undefined;
    info.mockRestore();

    expect(gate.ran).toEqual([input]);
    expect(line).toMatchObject({ ending: "reply", replayed: "danger" });
    // Named separately rather than folded into `tools`: this turn's model asked
    // only for `final_reply`, and conflating the two would lose the distinction
    // between deciding to delete and carrying out someone else's decision.
    expect(line?.tools).toEqual({ final_reply: 1 });
  });

  it("runs nothing when the human rejects, and records why", async () => {
    const session = new FakeSession();
    // The turn that raised the prompt. A resume adds no user turn of its own, so
    // without this the model would be handed an empty conversation.
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Left it alone.") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      resumeContext(decision(HITL_REJECT_OPTION_ID, "Reject")),
      bus.eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    expect(gate.ran).toHaveLength(0);
    expect(lastActions(session)[0]).toMatchObject({
      type: "tool-danger",
      state: "output-denied",
      approval: { approved: false, reason: "Rejected in Slack by Grace." }
    });
  });

  it("tells the model what was refused, and why", async () => {
    // A rejection the model never sees is one it will simply make again — which is
    // the whole thing a rejection is supposed to prevent.
    const session = new FakeSession();
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return finalReplyResult("Left it alone.") as never;
      }
    });

    await executeAgentTurn(
      resumeContext(decision(HITL_REJECT_OPTION_ID, "Reject")),
      fakeEventBus().eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    expect(gate.ran).toHaveLength(0);
    // Both the call it made and the refusal against it are in front of the model.
    expect(prompts[0]).toContain("tc-danger");
    expect(prompts[0]).toContain("Rejected in Slack by Grace.");
  });

  it("runs nothing when nobody answered in time", async () => {
    const session = new FakeSession();
    // The turn that raised the prompt. A resume adds no user turn of its own, so
    // without this the model would be handed an empty conversation.
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Nobody answered.") as never
    });

    await executeAgentTurn(
      resumeContext(buildHitlTimeoutParts("aitxt-1")),
      fakeEventBus().eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    expect(gate.ran).toHaveLength(0);
    expect(lastActions(session)[0]).toMatchObject({
      state: "output-denied",
      approval: { reason: "The approval request expired with no response." }
    });
  });

  it("withholds both the question and the gated tool after a timeout", async () => {
    // Either one left on the table is the same unbounded loop: raise a prompt,
    // wait out the TTL, raise it again. The turn is left one way out — say so
    // and finish.
    const session = new FakeSession();
    // The turn that raised the prompt. A resume adds no user turn of its own, so
    // without this the model would be handed an empty conversation.
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    const offered: string[][] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        offered.push((options.tools ?? []).map((t) => t.name));
        return finalReplyResult("Nobody answered, so I left it.") as never;
      }
    });

    await executeAgentTurn(
      resumeContext(buildHitlTimeoutParts("aitxt-1")),
      fakeEventBus().eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    expect(offered[0]).not.toContain("danger");
    expect(offered[0]).not.toContain("ask_user");
    // The ending still has the turn's own work to report.
    expect(offered[0]).toEqual(expect.arrayContaining(["final_reply", "work"]));
  });

  it("refuses an approver the policy will not have, and runs nothing", async () => {
    // Anyone in the thread can press Approve. The SDK re-runs the policy against
    // whoever did, which is the whole reason it is re-run at all.
    const session = new FakeSession();
    // The turn that raised the prompt. A resume adds no user turn of its own, so
    // without this the model would be handed an empty conversation.
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        finalReplyResult("You're not allowed to.") as never
    });

    await executeAgentTurn(
      resumeContext(decision(HITL_APPROVE_OPTION_ID, "Approve")),
      fakeEventBus().eventBus,
      gatedCfg(
        session,
        model,
        gate,
        {
          danger: async () => ({
            type: "denied",
            reason: "You don't administer this workspace."
          })
        },
        { openCalls }
      )
    );

    expect(gate.ran).toHaveLength(0);
    expect(lastActions(session)[0]).toMatchObject({
      state: "output-denied",
      approval: {
        approved: false,
        reason: "You don't administer this workspace."
      }
    });
  });

  it("lets a 🛑 out-rank an approved call: nothing runs, no call is spent", async () => {
    // The approved call runs before the first model call, so by the first step
    // boundary the deletion would already have happened. This is the only point
    // at which stopping still means anything.
    const session = new FakeSession();
    // The turn that raised the prompt. A resume adds no user turn of its own, so
    // without this the model would be handed an empty conversation.
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        return finalReplyResult("unreachable") as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      resumeContext(decision(HITL_APPROVE_OPTION_ID, "Approve")),
      bus.eventBus,
      gatedCfg(session, model, gate, asksAHuman, {
        openCalls,
        isCanceled: async () => true
      })
    );

    expect(gate.ran).toHaveLength(0);
    expect(calls).toBe(0);
    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
    expect(lastActions(session)[0]).toMatchObject({
      state: "output-denied",
      approval: { approved: false }
    });
  });

  it("records an approval that never ran as not carried out", async () => {
    // A turn that died before the call could run must not leave the decision in
    // history still marked approved with no outcome: that reads as a call waiting
    // to happen, and nothing is waiting — the store has already let it go.
    class BrokenSession extends FakeSession {
      async refreshSystemPrompt(): Promise<string> {
        throw new Error("memory boom");
      }
    }
    const session = new BrokenSession();
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("unreachable") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      resumeContext(decision(HITL_APPROVE_OPTION_ID, "Approve")),
      bus.eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    expect(gate.ran).toHaveLength(0);
    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_FAILED);
    expect(lastActions(session)[0]).toMatchObject({
      type: "tool-danger",
      state: "output-denied",
      approval: { approved: false }
    });
  });

  it("records a carried-out approval even when the turn then fails", async () => {
    // The agent is gone. A turn that failed afterwards must not leave history
    // silent about it — nothing else will ever record it.
    const session = new FakeSession();
    // The turn that raised the prompt. A resume adds no user turn of its own, so
    // without this the model would be handed an empty conversation.
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("model exploded");
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      resumeContext(decision(HITL_APPROVE_OPTION_ID, "Approve")),
      bus.eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    expect(gate.ran).toEqual([input]);
    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_FAILED);
    expect(lastActions(session)[0]).toMatchObject({
      type: "tool-danger",
      state: "output-available",
      output: { ok: true, deleted: "arc-player" }
    });
  });

  it("replays the approved input in full, however long", async () => {
    // A stored record is capped, and this one must not be: the SDK re-validates the
    // replayed input and executes it, so a truncated property would run a call the
    // human never saw — and a schema that still accepts the shorter value would not
    // object to it.
    const long = `arc-${"x".repeat(2000)}`;
    const session = new FakeSession();
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put({ ...heldApproval(), input: { name: long } });
    const gate = gatedTool();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Deleted it.") as never
    });

    await executeAgentTurn(
      resumeContext(decision(HITL_APPROVE_OPTION_ID, "Approve")),
      fakeEventBus().eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    expect(gate.ran).toEqual([{ name: long }]);
  });

  it("hands the salvage the approved call's result, not the decision again", async () => {
    // By the time an ending has to be salvaged, the approved call has already run.
    // Seeding that from `messages` would hand the SDK the same decision a second
    // time with no result against it, so the settled record goes in instead.
    const session = new FakeSession();
    session.messages.push(assistantSessionMessage(reason));
    const openCalls = new MemoryOpenCalls();
    await openCalls.put(heldApproval());
    const gate = gatedTool();
    const prompts: string[] = [];
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return (
          n++ === 0
            ? okResult("Deleted it! ✅")
            : finalReplyResult("Deleted arc-player.")
        ) as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      resumeContext(decision(HITL_APPROVE_OPTION_ID, "Approve")),
      bus.eventBus,
      gatedCfg(session, model, gate, asksAHuman, { openCalls })
    );

    // It ran once, ahead of the first call, and the salvage does not run it again.
    expect(gate.ran).toEqual([input]);
    expect(prompts).toHaveLength(2);
    // The salvage is shown what the call produced — which is the evidence that the
    // decision was settled before it was replayed.
    expect(prompts[1]).toContain("deleted");
    expect(publishedText(bus)).toContain("Deleted arc-player.");
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
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("work", { name: "arc-player" })
          : finalReplyResult("Updated the endpoint.")) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update it"),
      bus.eventBus,
      forcedCfg(session, model)
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
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Feito! ✅") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update it"),
      bus.eventBus,
      forcedCfg(session, model)
    );

    // A later turn asked "did that go through?" can now see that it did not.
    expect(persistedActions(session)).toHaveLength(0);
    expect(sessionText(session.messages[1])).toBe("Feito! ✅");
  });

  it("never records final_reply itself as an action", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("done") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      forcedCfg(session, model)
    );

    expect(persistedActions(session)).toHaveLength(0);
  });

  it("keeps calls that ran before a 🛑 — the side effects are real", async () => {
    const session = new FakeSession();
    let stopped = false;
    const model = new MockLanguageModelV4({
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
      forcedCfg(session, model, { isCanceled: async () => stopped })
    );

    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
    expect(persistedActions(session)).toHaveLength(1);
    expect(sessionText(session.messages[1])).toContain("stopped by the user");
  });

  it("records a failed call so a later turn cannot confirm it as a success", async () => {
    const session = new FakeSession();
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("work", {})
          : finalReplyResult("That didn't work.")) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update it"),
      bus.eventBus,
      forcedCfg(session, model, {
        prepare: async () => ({
          ...fakeAgentSession(session),
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
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("work", {})
          : okResult("Feito! ✅")) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("update it"),
      bus.eventBus,
      forcedCfg(session, model)
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
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        (n++ === 0
          ? toolCallResult("work", {})
          : okResult("Here is what I found.")) as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, model, {
        prepare: async () => ({
          ...fakeAgentSession(session),
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

// ---------------------------------------------------------------------------
// The turn log — one `[agent-turn]` line per turn, whatever exit it takes.
// The arithmetic inside that line is `turn-log.spec.ts`; what is checked here is
// that every exit reaches it, and that it says which exit was taken.
// ---------------------------------------------------------------------------

describe("executeAgentTurn — the turn log", () => {
  const adminMetadata = {
    agentKind: "local",
    tenant: "admin",
    adminWorkspaceId: 7,
    user: { slackUserId: "U123" }
  };

  /** Run a turn with `console.info` captured, and return the `[agent-turn]` lines. */
  async function turnLines(
    cfg: AgentTurnConfig,
    context = fakeRequestContext("hi", { metadata: adminMetadata })
  ) {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await executeAgentTurn(context, fakeEventBus().eventBus, cfg);
      return info.mock.calls
        .filter((call) => call[0] === "[agent-turn]")
        .map((call) => call[1] as Record<string, unknown>);
    } finally {
      info.mockRestore();
    }
  }

  it("logs one line for a turn that replied, carrying who it was for", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Done.") as never
    });

    const lines = await turnLines(forcedCfg(session, model));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      contextId: "ctx-1",
      taskId: "task-1",
      tenant: "admin",
      workspaceId: 7,
      user: "U123",
      ending: "reply",
      modelCalls: 1,
      fallbacks: 0,
      salvaged: false,
      tools: { final_reply: 1 }
    });
  });

  it("reports a throw as failed, from the `finally` no exit reached", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("the binding is gone");
      }
    });

    const lines = await turnLines(forcedCfg(session, model));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ending: "failed", modelCalls: 0 });
  });

  it("distinguishes a turn that parked on a human from one that answered", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        toolCallResult("ask_user", {
          question: "Which environment?",
          options: [{ label: "dev" }, { label: "prod" }]
        }) as never
    });

    const lines = await turnLines(
      forcedCfg(session, model, {
        openCalls: new MemoryOpenCalls(),
        prepare: async () => ({
          ...fakeAgentSession(session),
          systemSuffix: "",
          tools: { ask_user: askUserTool }
        })
      })
    );

    expect(lines).toHaveLength(1);
    // Not "none": the turn produced no reply, but it produced a question, and
    // counting it as a failure to answer is how a healthy agent looks broken.
    expect(lines[0]).toMatchObject({
      ending: "parked",
      tools: { ask_user: 1 }
    });
  });

  it("names the workspace of a remote agent's turn, which spells it differently", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Done.") as never
    });

    const lines = await turnLines(
      forcedCfg(session, model),
      fakeRequestContext("hi", {
        metadata: {
          agentKind: "remote",
          tenant: "acme",
          workspaceId: 42,
          user: { slackUserId: "U9" }
        }
      })
    );

    expect(lines[0]).toMatchObject({ tenant: "acme", workspaceId: 42 });
  });

  it("counts calls the turn was billed for and never got to use", async () => {
    // Both the turn and its salvage narrate under an enforced tool choice, so
    // `generateText` rejects with `ToolChoiceViolationError` twice and neither
    // promise ever resolves to a result. Both calls were still charged, and both
    // wrote a row to the AI Gateway log. Read from the resolved result, this
    // whole turn would report zero calls and zero tokens — the most expensive
    // shape a turn has, logged as if nothing had happened.
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () => okResult("I have updated the endpoint.") as never
    });

    const lines = await turnLines(forcedCfg(session, model));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ending: "none",
      modelCalls: 2,
      salvaged: true
    });
    expect(lines[0]?.inputTokens).toBeGreaterThan(0);
    expect(lines[0]?.outputTokens).toBeGreaterThan(0);
  });
});
