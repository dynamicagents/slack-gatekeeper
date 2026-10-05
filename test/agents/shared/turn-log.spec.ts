import { describe, it, expect, vi } from "vitest";
import type { LanguageModelUsage } from "ai";
import { startTurnLog, type ModelCallLike } from "@/agents/shared/turn-log";

/**
 * The one line a turn leaves behind.
 *
 * What is checked here is the arithmetic — adding up charged model calls, keeping
 * "the provider said nothing" distinct from "the provider said zero". That the
 * *shape* matches a real `onLanguageModelCallEnd` event is checked by the compiler
 * at the `loop.ts` call site, and that every exit reaches this is checked in
 * `loop.spec.ts`.
 */

const identity = {
  contextId: "C1:1700000000.0001",
  taskId: "task-1",
  tenant: "admin",
  workspaceId: 7,
  user: "U123",
  model: "@cf/zai-org/glm-5.3-flash"
};

function usage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cacheReadTokens?: number
): LanguageModelUsage {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens,
      cacheWriteTokens: undefined
    },
    outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined
  };
}

function modelCall({
  tools = [],
  responseTimeMs = 0,
  finishReason = "stop",
  tokens = usage(0, 0)
}: {
  tools?: string[];
  responseTimeMs?: number;
  finishReason?: string;
  tokens?: LanguageModelUsage;
} = {}): ModelCallLike {
  return {
    usage: tokens,
    finishReason,
    performance: { responseTimeMs },
    content: tools.map((toolName) => ({ type: "tool-call", toolName }))
  };
}

/** Run a turn log and return the object it logged. */
function emitted(build: (log: ReturnType<typeof startTurnLog>) => void) {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const log = startTurnLog(identity);
    build(log);
    log.flush();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe("[agent-turn]");
    return info.mock.calls[0]?.[1] as Record<string, unknown>;
  } finally {
    info.mockRestore();
  }
}

describe("the turn log", () => {
  it("carries the turn's identity even when nothing ran", () => {
    const line = emitted(() => {});

    expect(line).toMatchObject({ ...identity, modelCalls: 0 });
    // No exit claimed the turn, which from here is indistinguishable from a
    // throw — and is exactly what a throw leaves behind.
    expect(line.ending).toBe("failed");
  });

  it("adds up every charged model call and the tools they asked for", () => {
    const line = emitted((log) => {
      log.modelCall(
        modelCall({
          tools: ["agents_read"],
          responseTimeMs: 100,
          finishReason: "tool-calls",
          tokens: usage(1000, 50, 400)
        })
      );
      log.modelCall(
        modelCall({
          tools: ["agents_read", "final_reply"],
          responseTimeMs: 200,
          tokens: usage(1200, 20, 900)
        })
      );
      log.toolRan(5);
      log.toolRan(10);
      log.ending("reply");
    });

    expect(line).toMatchObject({
      ending: "reply",
      modelCalls: 2,
      // The last call's, not the first's: whatever came before was not the end.
      finishReason: "stop",
      modelMs: 300,
      toolMs: 15,
      inputTokens: 2200,
      cachedInputTokens: 1300,
      outputTokens: 70,
      // Counted, not listed: the same tool twice is the signal that a turn is
      // going in circles, and a flat list of names hides it.
      tools: { agents_read: 2, final_reply: 1 }
    });
  });

  it("counts a call the turn was billed for but never got to use", () => {
    // The case this design exists for. A model that narrates under an enforced
    // tool choice is charged and then discarded, so the turn has to record the
    // call as it happens rather than reading a result that never arrives — here,
    // a step that answered in prose and then one that reached the ending.
    const line = emitted((log) => {
      log.modelCall(
        modelCall({ tokens: usage(900, 40), finishReason: "stop" })
      );
      log.modelCall(
        modelCall({ tokens: usage(950, 60), tools: ["final_reply"] })
      );
      log.ending("reply");
    });

    expect(line).toMatchObject({
      modelCalls: 2,
      inputTokens: 1850,
      outputTokens: 100
    });
  });

  it("keeps an unreported token count out of the sum", () => {
    // A provider that went quiet and a model that used nothing are different
    // facts. Folding the first into 0 would understate the turn and, worse, make
    // the understatement invisible.
    const line = emitted((log) => {
      log.modelCall(modelCall({ tokens: usage(undefined, undefined) }));
      log.ending("reply");
    });

    expect(line.inputTokens).toBeUndefined();
    expect(line.outputTokens).toBeUndefined();
    expect(line.cachedInputTokens).toBeUndefined();
  });

  it("adds a reported count to an unreported one without losing it", () => {
    const line = emitted((log) => {
      log.modelCall(modelCall({ tokens: usage(undefined, undefined) }));
      log.modelCall(modelCall({ tokens: usage(42, 7) }));
      log.ending("reply");
    });

    expect(line).toMatchObject({ inputTokens: 42, outputTokens: 7 });
  });

  it("emits once however many times it is flushed", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = startTurnLog(identity);

    log.flush();
    log.flush();

    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });
});
