import { describe, it, expect, expectTypeOf } from "vitest";
import { Role, TaskState, type Message, type Part } from "@a2a-js/sdk";
import {
  HITL_QUESTION_KINDS,
  HITL_REQUEST_TYPE,
  type HitlQuestion,
  type HitlAnswer,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import { buildAskingTask, readHumanReply } from "@dynamicagents/core/a2a";
import { MAX_ASK_OPTIONS } from "@dynamicagents/core/agent";
import { buildMessage } from "@/a2a/parts";
import {
  buildHitlResponseParts,
  buildHitlTimeoutParts,
  parseHitlRequest,
  type HitlRequest
} from "@/a2a/hitl";
import { formView, requestBlocks } from "@/slack/hitl/render";
import { messageViolations, viewViolations } from "../helpers/slack-limits";

/**
 * The HITL half of the wire contract, as a conformance test — the counterpart to
 * `test/auth/wire-contract.spec.ts`, and for the same reason.
 *
 * `@dynamicagents/g2a-protocol` declares these shapes as **types only**: it holds
 * no runtime and no validator, because a validator there would be behaviour and
 * a dependency. So each side validates with the schema library it already
 * carries, and the gatekeeper's zod schema for a request is a hand-written
 * restatement of a contract nothing compares it against. This file is that
 * comparison.
 *
 * It is a comparison against the other side's **code**, not against a local
 * restatement of it: the request comes from `@dynamicagents/core/a2a`'s own
 * encoder and the answer goes back through its own reader, so a fixture that
 * drifts from what a core agent builds, or an answer core would refuse, fails
 * here rather than in production.
 *
 * **What this catches and what it does not.** A field renamed, removed, or
 * retyped upstream fails these — assignability breaks in one direction or the
 * other. A field *added* upstream does not: an optional property is assignable
 * both ways, so a request carrying a new field parses fine and the gatekeeper
 * ignores it, which is the behaviour you want from a reader anyway. Both sides
 * are pinned at one resolved version of core, so nothing here substitutes for
 * reading a protocol or core bump's diff.
 */

/** A message carrying `parts`, as the far side would have sent it. */
function sent(parts: Part[], role: Role = Role.ROLE_AGENT): Message {
  return buildMessage({ messageId: "m1", role, parts });
}

/**
 * The status message a core agent asks with, built by core's own encoder: the
 * questions as data, for the gatekeeper, and as the form text beside it, for a
 * client that renders none of it.
 */
function asked(request: HitlRequestData): Message | undefined {
  return buildAskingTask("t1", "ctx-1", request).status?.message;
}

/** One question of each kind, every optional field set. */
function questionOf(kind: HitlQuestion["kind"], id: string): HitlQuestion {
  const base = { id, prompt: `Decide: ${kind}`, header: kind };
  switch (kind) {
    case "choice":
      return {
        ...base,
        kind,
        multiple: true,
        options: [
          { id: `${id}.a`, label: "A", description: "first", example: "`a()`" },
          { id: `${id}.b`, label: "B" }
        ]
      };
    case "text":
      return { ...base, kind };
    case "approval":
      return {
        ...base,
        kind,
        artifact: { id: "plan-1", url: "https://agents.example/a/tok" }
      };
  }
}

describe("the gatekeeper's half of the contract", () => {
  it("accepts everything a conformant peer can send", () => {
    // Checked by `tsc -p test/tsconfig.json` and invisible to vitest, which
    // transpiles specs without typechecking them — so this passes a green
    // `npm test` no matter what it says. `npm run check` is the gate.
    expectTypeOf<HitlRequestData>().toExtend<HitlRequest>();
  });

  it("emits answers the agent's own reader takes whole", () => {
    const request: HitlRequestData = {
      type: HITL_REQUEST_TYPE,
      requestId: "r-1",
      questions: [questionOf("choice", "q1"), questionOf("text", "q2")]
    };
    const answers: Record<string, HitlAnswer> = {
      q1: { optionIds: ["q1.a", "q1.b"], text: "and C" },
      q2: { text: "forms" }
    };
    // Read by core's `readHumanReply` rather than by a reader of our own: this
    // direction is one the gatekeeper only ever writes, so the only reader worth
    // asserting against is the one that will actually run.
    const reply = readHumanReply(
      sent(
        buildHitlResponseParts({ request, answeredBy: "U123", answers }),
        Role.ROLE_USER
      )
    );

    expect(reply).toEqual({
      kind: "answer",
      requestId: "r-1",
      answer: { answeredBy: "U123", answers }
    });
  });

  it("emits an expiry the agent's own reader tells from an answer", () => {
    expect(
      readHumanReply(sent(buildHitlTimeoutParts("r-2"), Role.ROLE_USER))
    ).toEqual({ kind: "timeout", requestId: "r-2" });
  });

  it("covers every kind the contract defines, every field round-tripped", () => {
    // Driven by the protocol's tuple rather than a list spelled here, so a kind
    // added upstream is exercised on the next install with no edit to this file.
    const request: HitlRequestData = {
      type: HITL_REQUEST_TYPE,
      requestId: "r-all",
      prompt: "Before I start:",
      questions: HITL_QUESTION_KINDS.map((kind, i) => questionOf(kind, `q${i}`))
    };
    expect(parseHitlRequest(asked(request))).toEqual(request);
  });

  it("refuses a form whose answers could not say which question or option they mean", () => {
    const duplicateQuestion = {
      type: HITL_REQUEST_TYPE,
      requestId: "r-dup",
      questions: [questionOf("text", "q1"), questionOf("text", "q1")]
    };
    const duplicateOption = {
      type: HITL_REQUEST_TYPE,
      requestId: "r-dup-o",
      questions: [
        {
          kind: "choice",
          id: "q1",
          prompt: "Pick",
          options: [
            { id: "a", label: "A" },
            { id: "a", label: "B" }
          ]
        }
      ]
    };
    for (const request of [duplicateQuestion, duplicateOption]) {
      expect(parseHitlRequest(asked(request as HitlRequestData))).toBeNull();
    }
  });
});

/**
 * What core builds from a model's `ask_user`: ids it makes itself — `q1`, and
 * `q1.o1` for options — each option's label, description and example, and an
 * approval carrying its artifact. The widest question core's tool will accept,
 * since {@link MAX_ASK_OPTIONS} is the bound it validates `ask_user` against.
 */
describe("what core actually sends", () => {
  const core: HitlRequestData = {
    type: HITL_REQUEST_TYPE,
    requestId: "t1:main:call_1",
    prompt: "Before I open the PR:",
    questions: [
      {
        kind: "choice",
        id: "q1",
        prompt: "How should it merge?",
        header: "Merge",
        options: Array.from({ length: MAX_ASK_OPTIONS }, (_, i) => ({
          id: `q1.o${i + 1}`,
          label: `Option ${i + 1} — ${"a label longer than a button shows ".repeat(2)}`,
          description: "What picking it means.",
          example: "git merge --squash"
        }))
      },
      {
        kind: "choice",
        id: "q2",
        prompt: "Which checks must pass?",
        multiple: true,
        options: [
          { id: "q2.o1", label: "lint" },
          { id: "q2.o2", label: "test" }
        ]
      },
      { kind: "text", id: "q3", prompt: "What should the branch be called?" },
      {
        kind: "approval",
        id: "q4",
        prompt: "Approve the plan?",
        artifact: { id: "plan-1", url: "https://agents.example/a/tok" }
      }
    ]
  };

  it("asks from `working`, on an update this gatekeeper can deduplicate", () => {
    const status = buildAskingTask("t1", "ctx-1", core).status;
    // The state is not the trigger: core asks mid-turn and only goes
    // `input-required` once it is idle with nothing but open questions left.
    // `src/a2a/notifications/shared.ts` is where this side acts on that.
    expect(status?.state).toBe(TaskState.TASK_STATE_WORKING);
    // That same module refuses a non-terminal update carrying no messageId,
    // since it deduplicates at-least-once delivery on one.
    expect(status?.message?.messageId).toBe(core.requestId);
  });

  it("parses whole, and renders within Slack's limits in the thread and the modal", () => {
    const parsed = parseHitlRequest(asked(core));
    expect(parsed).toEqual(core);
    expect(messageViolations(requestBlocks(parsed!))).toEqual([]);
    expect(viewViolations(formView(parsed!))).toEqual([]);
  });
});
