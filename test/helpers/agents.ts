import { vi } from "vitest";
import { env } from "cloudflare:workers";
import type { SessionMessage, Sessions } from "agents/sessions";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";
import type { TaskState } from "@a2a-js/sdk";
import { partsText } from "@/a2a/parts";
import { EMBED_MODEL_ID } from "@/config";
import type {
  AgentSession,
  ContextLike,
  SessionHost,
  SessionLike
} from "@/agents/shared/session";
import type { OpenCall, OpenCallStore } from "@/agents/shared/open-call";
import { userMessage } from "./a2a";

/**
 * In-memory stand-in for the `{ session, context }` pair an agent DO owns, for
 * driving executors and turns without a Durable Object. One object plays both
 * halves — a fake has no reason to keep history and the prompt blocks apart —
 * and {@link fakeAgentSession} splits it back into the pair the seams take.
 *
 * `appendSpy` lets tests assert on persisted messages; `compactions` seeds
 * `getCompactions` (non-empty ⇒ the executor treats an episodic archive as present).
 */
export class FakeSession implements SessionLike, ContextLike {
  messages: SessionMessage[] = [];
  appendSpy = vi.fn(async (m: SessionMessage) => {
    this.messages.push(m);
  });
  constructor(private compactions: unknown[] = []) {}
  async appendMessage(m: SessionMessage) {
    return this.appendSpy(m);
  }
  async getHistory() {
    return this.messages;
  }
  async refreshSystemPrompt() {
    return "SYSTEM PROMPT";
  }
  async tools() {
    return {};
  }
  async getCompactions() {
    return this.compactions;
  }
}

/** A {@link FakeSession} as the `{ session, context }` pair the seams expect. */
export function fakeAgentSession(fake: FakeSession): AgentSession {
  return { session: fake, context: fake };
}

/**
 * The `SessionHost` an executor is constructed with, for specs that drive one
 * without a Durable Object. Every such spec also supplies `createSession`, so
 * neither half of the host is ever read — `sessions` throws rather than
 * returning an empty stub, so a spec that stops passing that seam fails loudly
 * instead of silently building a session on nothing.
 */
export function fakeSessionHost(): SessionHost {
  return {
    sql: () => [],
    get sessions(): Sessions {
      throw new Error("fakeSessionHost: `sessions` should not be reached");
    }
  };
}

/**
 * A Map-backed `OpenCallStore`: `held` lets a spec seed a question a turn asked
 * earlier, or check what a pausing turn kept.
 */
export class MemoryOpenCalls implements OpenCallStore {
  held = new Map<string, OpenCall>();
  async put(call: OpenCall) {
    this.held.set(call.requestId, call);
  }
  async settle(requestId: string, record: (call: OpenCall) => Promise<void>) {
    const call = this.held.get(requestId) ?? null;
    if (!call) return null;
    await record(call);
    this.held.delete(requestId);
    return call;
  }
}

/**
 * Spy on the global `env` AI + VECTORIZE bindings (no network needed). Recall
 * code reads them off `cloudflare:workers`, so tests stub the real bindings.
 * Restore with `vi.restoreAllMocks()` in an `afterEach`.
 */
export function fakeRecallEnv() {
  const run = vi.spyOn(env.AI, "run").mockImplementation((async () => ({
    data: [Array(1024).fill(0.1)]
  })) as never);
  const query = vi
    .spyOn(env.VECTORIZE, "query")
    .mockImplementation((async () => ({ count: 0, matches: [] })) as never);
  return { run, query };
}

/**
 * Stub the whole `AI` binding so a built-in agent's turn completes offline.
 *
 * `remoteBindings: false` (vitest.config.ts) makes the real binding throw
 * "Binding AI needs to be run remotely". Specs that only trigger an agent turn
 * as a *side effect* — a Slack event that wakes the admin/onboarding DO — never
 * await that turn, so the failure escapes on the DO's detached promise and
 * vitest reports it as an unhandled rejection. Chat calls answer with `text`,
 * embedding calls with one filler vector per input. Restore with
 * `vi.restoreAllMocks()`.
 */
export function stubAgentAi(text = "stubbed agent reply") {
  return vi.spyOn(env.AI, "run").mockImplementation((async (
    model: string,
    inputs?: { text?: string[]; tools?: { function?: { name?: string } }[] }
  ) => {
    if (model === EMBED_MODEL_ID) {
      return { data: (inputs?.text ?? [""]).map(() => Array(1024).fill(0.1)) };
    }
    // An agent running with `requireFinalReply` cannot end a turn in prose, so
    // the stub has to answer the way the real contract does. Replying with text
    // would make the turn spend its whole step budget and then a salvage call,
    // outliving the test that stubbed this binding and rejecting against the real
    // one on its detached promise.
    const requiresFinalReply = (inputs?.tools ?? []).some(
      (t) => t?.function?.name === "final_reply"
    );
    return requiresFinalReply
      ? {
          response: "",
          tool_calls: [{ name: "final_reply", arguments: { text } }]
        }
      : { response: text };
  }) as never);
}

// Minimal valid generate result. The shape is the v4 one the provider actually
// speaks — `finishReason` as an object, structured `usage` — and `MockLanguageModelV4`
// declares that same spec, so what a spec returns here is what the SDK reads with
// nothing converting in between.
export function okResult(text: string) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1 },
      totalTokens: 2
    },
    warnings: []
  };
}

/** Like `okResult` but signals the model hit its output-length cap. */
export function lengthResult(text: string) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "length" },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1 },
      totalTokens: 2
    },
    warnings: []
  };
}

export function toolCallResult(toolName: string, input: unknown) {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName,
        input: JSON.stringify(input)
      }
    ],
    finishReason: { unified: "tool-calls" },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1 },
      totalTokens: 2
    },
    warnings: []
  };
}

/**
 * How an agent running with `requireFinalReply` ends a turn: the reply arrives as
 * the `final_reply` control call's input, not as plain text. Use this wherever a
 * spec would otherwise have used {@link okResult} to answer.
 */
export function finalReplyResult(text: string, toolCallId = "fr1") {
  return {
    ...toolCallResult("final_reply", { text }),
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName: "final_reply",
        input: JSON.stringify({ text })
      }
    ]
  };
}

/** Extract text from the terminal A2A task-status event captured by a test bus. */
export function terminalTaskText(
  events: AgentExecutionEvent[]
): string | undefined {
  const event = events.at(-1);
  if (event?.kind !== "statusUpdate") return undefined;
  return partsText(event.data.status?.message?.parts);
}

/**
 * The terminal A2A state a test bus captured. A2A v1.0 carries no structured
 * task error, so this state is the only machine-readable signal that a turn
 * failed — assert on it rather than on wording in the reply.
 */
export function terminalTaskState(
  events: AgentExecutionEvent[]
): TaskState | undefined {
  const event = events.at(-1);
  if (event?.kind !== "statusUpdate") return undefined;
  return event.data.status?.state;
}

/** A one-turn agent request plus a capturing event bus, shared by executor specs. */
export function makeRequest(opts: {
  contextId: string;
  text: string;
  metadata: Record<string, unknown>;
}) {
  const published: AgentExecutionEvent[] = [];
  let finished = false;
  const eventBus = {
    publish: (e: unknown) => published.push(e as never),
    finished: () => {
      finished = true;
    }
  };
  const requestContext = {
    contextId: opts.contextId,
    taskId: "task-test",
    userMessage: userMessage(opts.text, {
      contextId: opts.contextId,
      metadata: opts.metadata
    })
  };
  return {
    published,
    isFinished: () => finished,
    // Cast at the boundary — we only exercise the fields the executor reads.
    eventBus: eventBus as never,
    requestContext: requestContext as never
  };
}
