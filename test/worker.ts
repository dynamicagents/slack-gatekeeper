import type { ThinkModel } from "@cloudflare/think";
import {
  askUser,
  call,
  scriptedModel,
  type MockStep,
  type ModelTurnView
} from "@dynamicagents/core/testing";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { AdminStepAgent } from "@/agents/admin/agent";
import { OnboardingStepAgent } from "@/agents/onboarding/agent";

/**
 * The Worker the suite runs: the gatekeeper's own, plus its built-in step
 * agents on a scripted model.
 *
 * Workers AI has no local mode, so a built-in's real `getModel()` cannot finish
 * a turn here. `vitest.config.ts` binds `AdminStepAgent` and
 * `OnboardingStepAgent` to the classes below instead, so everything else —
 * dispatch, core's A2A edge, the task hosts and workflows, the push callback —
 * runs exactly as deployed, and only the model answering the turn is fake.
 */

export * from "@/server";
export { default } from "@/server";

/** What a scripted built-in says when nothing in its script claims the turn. */
export const SCRIPTED_REPLY = "stubbed agent reply";

/** The turn's words, less the gatekeeper's `<turn>` wrapper and any leading mentions. */
function body(text: string): string {
  const inner = /^<turn\b[^>]*>([\s\S]*)<\/turn>$/.exec(text)?.[1] ?? text;
  return inner.replace(/^(\s*<@[A-Z0-9]+>)+\s*/, "").trim();
}

function after(text: string, prefix: string): string | undefined {
  return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
}

/** The text of the most recent tool result, as the model was shown it. */
function lastToolOutput(view: ModelTurnView): string {
  for (let i = view.prompt.length - 1; i >= 0; i--) {
    const message = view.prompt[i]!;
    if (message.role !== "tool") continue;
    const part = message.content.find((p) => p.type === "tool-result") as
      { output?: { value: unknown } } | undefined;
    const value = part?.output?.value;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return "";
}

/**
 * The script both built-ins follow, keyed on the message that started the turn:
 *
 * - `tool:<name> <json>` calls that tool, then replies with what it returned.
 * - `ask:<question>` asks through `ask_user`; the answer is replied.
 * - `wait:<seconds>` waits in a tool, for a spec that stops a turn mid-flight.
 * - `hold` waits in a tool until the spec releases {@link useTestLatch}'s latch.
 * - `boom` fails the step.
 * - anything else is answered with {@link SCRIPTED_REPLY}.
 */
function rule(view: ModelTurnView): MockStep {
  const text = body(view.lastUserText);
  if (text === "boom") return { error: "told to fail" };
  if (text === "hold")
    return view.answered ? { text: "released" } : call("test_hold", {});
  const invoke = after(text, "tool:");
  if (invoke !== undefined) {
    if (view.answered) return { text: lastToolOutput(view) };
    const [name, ...rest] = invoke.split(" ");
    return call(name!, rest.length ? JSON.parse(rest.join(" ")) : {});
  }
  const ask = after(text, "ask:");
  if (ask !== undefined) {
    return view.answered
      ? { text: `answered: ${view.lastUserText}` }
      : askUser(ask, ["Yes", "No"]);
  }
  const wait = after(text, "wait:");
  if (wait !== undefined) {
    return view.answered
      ? { text: `waited ${wait}` }
      : call("test_wait", { seconds: Number(wait) });
  }
  return { text: SCRIPTED_REPLY };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

/** A tool that waits in the turn, for a spec that cancels one mid-flight. */
const testWait = tool({
  description: "Wait.",
  inputSchema: z.object({ seconds: z.number().min(0) }),
  execute: async ({ seconds }, { abortSignal }) => {
    await sleep(seconds * 1000, abortSignal);
    return { slept: seconds };
  }
});

/**
 * The latch `hold` waits on, for a spec that needs a turn open for as long as it
 * takes rather than for a number of seconds.
 *
 * The step agents run in this module's isolate — which is why a spec's
 * `vi.stubGlobal("fetch")` already catches a task host's push callback — so
 * module state is a rendezvous between the spec and the turn.
 *
 * **Flags that each side polls, not a promise either side awaits.** A spec and a
 * Durable Object are different I/O contexts, and handing a promise built in one
 * to the other takes workerd down on teardown with `Promise callback destroyed
 * itself` — a process crash, after the awaits have apparently worked. Reading a
 * boolean is not I/O, so each side only ever awaits a promise of its own making.
 */
let latch = { armed: false, entered: false, released: false };

/**
 * Arm the latch, before the message whose turn is to be held.
 *
 * `entered` goes true as the turn reaches the tool, and core notes a step job —
 * with the `joins: true` on it — before it starts the job that runs that turn.
 * So a spec polling `entered` is synchronized on the step being joinable, where
 * one waiting on the task being accepted is not. `release` lets the turn finish.
 */
export function useTestLatch(): {
  entered: () => boolean;
  release: () => void;
} {
  latch = { armed: true, entered: false, released: false };
  return {
    entered: () => latch.entered,
    release: () => {
      latch.released = true;
    }
  };
}

/** A tool that holds the turn until the spec that armed the latch releases it. */
const testHold = tool({
  description: "Wait to be released.",
  inputSchema: z.object({}),
  execute: async (_args, { abortSignal }) => {
    if (!latch.armed)
      throw new Error("test_hold: no latch armed; call useTestLatch()");
    latch.entered = true;
    while (!latch.released) await sleep(25, abortSignal);
    return { held: true };
  }
});

export class TestAdminStepAgent extends AdminStepAgent {
  override getModel(): ThinkModel {
    return scriptedModel(rule);
  }
  protected override compactionModel() {
    return scriptedModel(rule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), test_wait: testWait, test_hold: testHold };
  }
}

export class TestOnboardingStepAgent extends OnboardingStepAgent {
  override getModel(): ThinkModel {
    return scriptedModel(rule);
  }
  protected override compactionModel() {
    return scriptedModel(rule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), test_wait: testWait, test_hold: testHold };
  }
}
