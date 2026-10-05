import type { ThinkModel } from "@cloudflare/think";
import {
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
 * - `boom` fails the step.
 * - anything else is answered with {@link SCRIPTED_REPLY}.
 */
function rule(view: ModelTurnView): MockStep {
  const text = body(view.lastUserText);
  if (text === "boom") return { error: "told to fail" };
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
      : call("ask_user", { question: ask, options: ["Yes", "No"] });
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

export class TestAdminStepAgent extends AdminStepAgent {
  override getModel(): ThinkModel {
    return scriptedModel(rule);
  }
  protected override compactionModel() {
    return scriptedModel(rule);
  }
  override getTools(): ToolSet {
    return { ...super.getTools(), test_wait: testWait };
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
    return { ...super.getTools(), test_wait: testWait };
  }
}
