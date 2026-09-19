import { describe, it, expect, vi } from "vitest";
import {
  generateText,
  wrapLanguageModel,
  type LanguageModelMiddleware
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { normalizeToolInputMiddleware } from "@/agents/model-middleware";
import { okResult } from "../helpers/agents";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

/**
 * The middleware only ever rewrites `params`, so the tests drive `transformParams`
 * directly rather than standing up a model.
 */
type TransformParams = NonNullable<LanguageModelMiddleware["transformParams"]>;
type CallOptions = Parameters<TransformParams>[0]["params"];

const transform = normalizeToolInputMiddleware.transformParams!;

/** A one-message prompt carrying a single assistant tool call with `input`. */
function promptWithToolCall(input: unknown, toolName = "set_context") {
  return [
    { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
    {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "call_1",
          toolName,
          input
        }
      ]
    }
  ];
}

async function run(prompt: unknown): Promise<CallOptions> {
  return transform({
    type: "generate",
    params: { prompt } as CallOptions,
    model: {} as Parameters<TransformParams>[0]["model"]
  });
}

/** The `input` of the first tool call in a transformed prompt. */
function toolInput(params: CallOptions): unknown {
  const assistant = params.prompt[1];
  if (assistant.role !== "assistant")
    throw new Error("expected an assistant message");
  const part = assistant.content[0];
  if (part.type !== "tool-call") throw new Error("expected a tool call");
  return part.input;
}

describe("normalizeToolInputMiddleware", () => {
  it("leaves a well-formed prompt untouched, and does not copy it", async () => {
    const prompt = promptWithToolCall({ label: "memory", content: "hi" });
    const out = await run(prompt);
    // Same reference: an untouched prompt should cost nothing.
    expect(out.prompt).toBe(prompt);
  });

  it("recovers the real arguments from a double-encoded input", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = {
      label: "memory",
      content: "## Facts",
      action: "replace"
    };

    const out = await run(promptWithToolCall(JSON.stringify(original)));

    expect(toolInput(out)).toEqual(original);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // The exact shape that bricked the admin agent: `cap()` cut a 1640-char
  // `set_context` input mid-JSON and stored the truncation marker as the input,
  // which then replayed as `arguments` on every later turn.
  it("wraps a truncated-JSON input, which cannot be parsed back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const poisoned =
      '{"label":"memory","content":"## Workspace 1 — Key Facts' +
      "… [truncated, 1640 chars total]";

    const out = await run(promptWithToolCall(poisoned));

    expect(toolInput(out)).toEqual({ _raw: poisoned });
    warn.mockRestore();
  });

  // The middleware is the last guard before serialization, so it must survive
  // input it cannot serialize rather than becoming the crash it exists to prevent.
  it("survives an input that cannot be JSON-serialized", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // An *array* holding the cycle: a bare object would be passed through as a
    // valid arguments object without ever reaching the wrapper.
    const out = await run(promptWithToolCall([cyclic]));

    expect(typeof toolInput(out)).toBe("object");
    expect(toolInput(out)).toHaveProperty("_raw");
    warn.mockRestore();
  });

  it("keeps a BigInt input from throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await run(promptWithToolCall([1n]));
    expect(toolInput(out)).toHaveProperty("_raw");
    warn.mockRestore();
  });

  it("wraps a non-string, non-object input", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await run(promptWithToolCall(["not", "an", "object"]));
    expect(toolInput(out)).toEqual({ _raw: '["not","an","object"]' });
    warn.mockRestore();
  });

  it("names the offending tools in the warning, once each", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await run([
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "a",
            toolName: "set_context",
            input: "x"
          },
          {
            type: "tool-call" as const,
            toolCallId: "b",
            toolName: "set_context",
            input: "y"
          },
          {
            type: "tool-call" as const,
            toolCallId: "c",
            toolName: "agents_read",
            input: {}
          }
        ]
      }
    ]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      count: 2,
      tools: ["set_context"]
    });
    warn.mockRestore();
  });

  it("does not touch tool-result messages", async () => {
    const prompt = [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call_1",
            toolName: "set_context",
            output: { type: "text" as const, value: "Written to memory." }
          }
        ]
      }
    ];
    const out = await run(prompt);
    expect(out.prompt).toBe(prompt);
  });
});

/**
 * The unit tests above call `transformParams` directly. This one proves the wiring
 * — that `wrapLanguageModel` reaches the hook at all, and that what the provider
 * finally sees is repaired — by driving a real `generateText` over a mock model.
 */
describe("normalizeToolInputMiddleware — wired into a model", () => {
  it("repairs the prompt the model is actually called with", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = { label: "memory", content: "## Facts" };
    let seen: unknown;

    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({
        doGenerate: async (options) => {
          seen = options.prompt;
          return okResult("done") as never;
        }
      }),
      middleware: normalizeToolInputMiddleware
    });

    await generateText({
      model,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "set_context",
              // The double-encoded shape a capped record replays as.
              input: JSON.stringify(original)
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "set_context",
              output: { type: "text", value: "Written to memory." }
            }
          ]
        }
      ]
    });

    const prompt = seen as { role: string; content: { input?: unknown }[] }[];
    const assistant = prompt.find((m) => m.role === "assistant");
    expect(assistant?.content[0].input).toEqual(original);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
