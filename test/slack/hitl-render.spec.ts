import { describe, it, expect } from "vitest";
import type { SlackViewStateValue } from "@chat-adapter/slack/webhook";
import {
  HITL_REQUEST_TYPE,
  MAX_MESSAGE_TEXT_BYTES,
  type HitlQuestion,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import {
  answeredBlocks,
  clipMrkdwn,
  fallbackText,
  formPages,
  formView,
  requestBlocks,
  requestFallbackText,
  resolvedBlocks,
  splitMrkdwn,
  wordsView
} from "@/slack/hitl/render";
import {
  enteredAnswers,
  formAnswers,
  formErrors,
  pickAnswers,
  readControl,
  readViewMeta,
  viewValues
} from "@/slack/hitl/answer";
import {
  blocksText,
  messageViolations,
  viewViolations
} from "../helpers/slack-limits";
import { approvalForm, choiceForm } from "../helpers/hitl";

// Pure rendering and parsing; no storage, so no `useStorageReset()` — see
// test/helpers/storage.ts.

function form(
  questions: HitlQuestion[],
  prompt?: string,
  requestId = "req-1"
): HitlRequestData {
  return {
    type: HITL_REQUEST_TYPE,
    requestId,
    ...(prompt ? { prompt } : {}),
    questions
  };
}

/**
 * A prompt shaped like the one that lost its questions: a long preamble, then
 * numbered questions that all start past the 3,000th character — now asked as
 * the form they always were.
 */
function longForm(): HitlRequestData {
  const preamble = Array.from(
    { length: 30 },
    (_, i) =>
      `Context paragraph ${i + 1}. ${"Detail about the plan. ".repeat(4)}`
  ).join("\n\n");
  return form(
    [1, 2, 3, 4, 5].map((n) => ({
      kind: "text",
      id: `q${n}`,
      prompt: `**Question ${n}:** ${"Which way should this go? ".repeat(3)}`
    })),
    preamble
  );
}

/** A form of `n` short choices, past what one modal holds from about 33. */
function manyQuestions(
  n: number,
  prompt = "Some context first."
): HitlRequestData {
  return form(
    Array.from({ length: n }, (_, i) => ({
      kind: "choice" as const,
      id: `c${i}`,
      prompt: `Question ${i}?`,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" }
      ]
    })),
    prompt
  );
}

const longLabels = [
  "x".repeat(218),
  "Rebase the branch onto main and keep every commit as it is, then merge",
  "Squash and merge",
  "y".repeat(93)
];

interface Button {
  action_id: string;
  text: { text: string };
  value: string;
  style?: string;
}

function buttonsOf(blocks: unknown[]): Button[] {
  const actions = blocks.find(
    (b) => (b as { type?: string }).type === "actions"
  ) as { elements: Button[] } | undefined;
  return actions?.elements ?? [];
}

function inputsOf(view: Record<string, unknown>) {
  return (view.blocks as Record<string, unknown>[]).filter(
    (b) => b.type === "input"
  ) as {
    block_id: string;
    optional: boolean;
    label: { text: string };
    element: Record<string, unknown> & { type: string; options?: unknown[] };
  }[];
}

/** A modal's state as Slack reports it, one entry per input. */
function state(
  ...entries: [string, { picks?: string[]; text?: string }][]
): SlackViewStateValue[] {
  return entries.map(([blockId, v]) => ({
    blockId,
    actionId: "value",
    raw: v.picks
      ? v.picks.length === 1
        ? { selected_option: { value: v.picks[0] } }
        : { selected_options: v.picks.map((value) => ({ value })) }
      : {},
    ...(v.text !== undefined ? { value: v.text } : {})
  }));
}

describe("splitMrkdwn", () => {
  it("splits at paragraph breaks, every piece within the limit", () => {
    const text = Array.from(
      { length: 20 },
      (_, i) => `p${i} ${"a".repeat(300)}`
    ).join("\n\n");
    const pieces = splitMrkdwn(text, 1_000);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(1_000);
    for (let i = 0; i < 20; i++) {
      expect(pieces.some((p) => p.includes(`p${i} ${"a".repeat(300)}`))).toBe(
        true
      );
    }
  });

  it("closes a code block at a split and reopens it in the next piece", () => {
    const code = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const pieces = splitMrkdwn(`Before\n\`\`\`\n${code}\n\`\`\`\nAfter`, 300);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(300);
      expect((piece.split("```").length - 1) % 2).toBe(0);
    }
  });
});

describe("the open prompt", () => {
  it("answers one short choice by its own buttons, with Other… beside them", () => {
    const blocks = requestBlocks(
      choiceForm("req-short", "Proceed?", [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" }
      ])
    );
    expect(messageViolations(blocks)).toEqual([]);
    expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual([
      "Yes",
      "No",
      "Other…"
    ]);
    // Short labels on their buttons: no list repeating them.
    expect(blocksText(blocks)).not.toContain("*1.*");
  });

  it("lists long options in full above buttons that show their numbers", () => {
    const blocks = requestBlocks(
      choiceForm(
        "req-opts",
        "Which merge?",
        longLabels.map((label, i) => ({ id: `o${i}`, label }))
      )
    );
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    for (const label of longLabels) expect(text).toContain(label);
    expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "Other…"
    ]);
  });

  it("shows each option's description, and its example as a code block", () => {
    const text = blocksText(
      requestBlocks(
        choiceForm("req-ex", "How should it merge?", [
          {
            id: "squash",
            label: "Squash",
            description: "One commit on main.",
            example: "feat: forms (#142)"
          },
          { id: "rebase", label: "Rebase" }
        ])
      )
    );
    expect(text).toContain(
      "*1.* Squash\nOne commit on main.\n```\nfeat: forms (#142)\n```"
    );
    expect(text).toContain("*2.* Rebase");
  });

  it("asks an approval by Approve, Reject and Comment…, with the link to look at", () => {
    const blocks = requestBlocks(
      form([
        {
          kind: "approval",
          id: "q1",
          prompt: "Approve the plan?",
          artifact: { id: "plan-1", url: "https://agents.example/a/tok" }
        }
      ])
    );
    expect(blocksText(blocks)).toContain("<https://agents.example/a/tok>");
    expect(buttonsOf(blocks).map((b) => [b.text.text, b.style])).toEqual([
      ["Approve", "primary"],
      ["Reject", "danger"],
      ["Comment…", undefined]
    ]);
  });

  it("does not link an artifact that is not https", () => {
    const text = blocksText(
      requestBlocks(
        form([
          {
            kind: "approval",
            id: "q1",
            prompt: "Approve?",
            artifact: { id: "p", url: "javascript:alert(1)" }
          }
        ])
      )
    );
    expect(text).not.toContain("<javascript:");
  });

  /**
   * The questions are the modal's: said in the message too, a person reads
   * them twice. What the message holds is what the agent said around them.
   */
  it("shows a form's Answer button under the agent's words alone", () => {
    const request = longForm();
    const blocks = requestBlocks(request);
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    expect(text).toContain("Context paragraph 1.");
    expect(text).toContain("Context paragraph 30.");
    for (const n of [1, 2, 3, 4, 5]) {
      expect(text).not.toContain(`Question ${n}:`);
    }
    expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual(["Answer"]);
    // Nor are the agent's words said again in the modal.
    expect(blocksText(formView(request).blocks as unknown[])).not.toContain(
      "Context paragraph 1."
    );
  });

  it("names a form's questions in a line each when the agent said nothing around them", () => {
    const text = blocksText(
      requestBlocks(
        form([
          {
            kind: "text",
            id: "q1",
            prompt: "Which database?\nWe run Postgres today.",
            header: "Database"
          },
          { kind: "text", id: "q2", prompt: "Name it?\nShort, please." }
        ])
      )
    );
    expect(text).toBe("• *Database*\n• Name it?");
  });

  /**
   * The only numbers are an option's: a question numbered too reads as one of
   * them.
   */
  it("names a question by its header, unnumbered", () => {
    const text = blocksText(
      formView(
        form([
          {
            kind: "choice",
            id: "q1",
            prompt: "Which database?",
            header: "Database",
            options: [
              { id: "a", label: "Postgres", description: "What we run." },
              { id: "b", label: "SQLite" }
            ]
          },
          { kind: "text", id: "q2", prompt: "Name it?" }
        ])
      ).blocks as unknown[]
    );
    expect(text).toContain("*Database*\nWhich database?");
    expect(text).toContain("*1.* Postgres\nWhat we run.");
    expect(text).toContain("Name it?");
    expect(text).not.toMatch(/\*1\. Database|\*2\.\* Name it/);
  });

  it("converts the agent's Markdown and defuses channel-wide mentions", () => {
    const text = blocksText(
      requestBlocks(choiceForm("req-md", "**Bold** <!channel> and @here"))
    );
    expect(text).toContain("*Bold*");
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("@here");
  });

  it("answers a form too long for one modal from the same Answer button", () => {
    const blocks = requestBlocks(manyQuestions(40));
    expect(messageViolations(blocks)).toEqual([]);
    expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual(["Answer"]);
  });
});

/**
 * A question an agent stopped to ask is put in front of the person who asked for
 * the work: a mention of them, which is what Slack notifies on, in the message
 * and in the notification beside it. The words say what the form needs — an
 * approval is the one thing the agent cannot settle on its own, and anything
 * else is an ask, a pick or words, which leaves the agent just as idle until
 * somebody answers.
 *
 * `startedBy` is the trigger event's own Slack user, carried on the task row —
 * or, where no person started the task, one of that column's sentinels, which
 * name nobody.
 */
describe("a prompt's mention of whoever started the task", () => {
  const APPROVAL_PING = "<@U1> — this needs your approval.";
  const ASK_PING = "<@U1> — this needs your answer.";
  const APPROVAL_BUTTONS = ["Approve", "Reject", "Comment…"];

  /**
   * One form of every kind a prompt can hold: what it asks the starter for, the
   * question it is still asking, and the controls it is answered by — which the
   * mention leaves exactly as they were.
   */
  const FORMS = [
    {
      what: "an approval",
      build: () => approvalForm("req-ping-ap"),
      ping: APPROVAL_PING,
      asks: "Approve the plan?",
      buttons: APPROVAL_BUTTONS
    },
    {
      what: "a pick",
      build: () =>
        choiceForm("req-ping-ch", "Which rollout?", [
          { id: "now", label: "Now" },
          { id: "later", label: "Later" }
        ]),
      ping: ASK_PING,
      asks: "Which rollout?",
      buttons: ["Now", "Later", "Other…"]
    },
    {
      what: "words",
      build: () =>
        form(
          [{ kind: "text", id: "q1", prompt: "Name it?" }],
          undefined,
          "req-ping-tx"
        ),
      ping: ASK_PING,
      asks: "Name it?",
      buttons: ["Answer"]
    }
  ];

  it.each(FORMS)(
    "mentions them for $what, and leads the notification with it",
    ({ build, ping, buttons }) => {
      const request = build();
      const blocks = requestBlocks(request, "U1");
      expect(messageViolations(blocks)).toEqual([]);
      // First, and a block of its own — not folded into the agent's words, whose
      // budget it would then eat into.
      expect(blocks[0]).toEqual({
        type: "section",
        text: { type: "mrkdwn", text: ping }
      });
      // Leading the fallback: a mobile notification is drawn from this text
      // alone, and a long form's is cut from the end. Everything after it is the
      // same form's fallback with nobody to name.
      expect(requestFallbackText(request, "U1")).toBe(
        `${ping}\n\n${requestFallbackText(request)}`
      );
      // The question is still asked the same way, by its own controls.
      expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual(buttons);
    }
  );

  /**
   * An approval anywhere in the form wins the wording, because it is the part a
   * person has to settle: a form holding both says so once, and says approval.
   */
  it("names the approval on a form that asks for one beside a pick", () => {
    const request = form(
      [
        {
          kind: "choice",
          id: "q1",
          prompt: "Which rollout?",
          options: [{ id: "now", label: "Now" }]
        },
        {
          kind: "approval",
          id: "q2",
          prompt: "Approve the rollout?",
          artifact: { id: "plan-1", url: "https://agents.example/a/tok" }
        }
      ],
      undefined,
      "req-ping-both"
    );
    const blocks = requestBlocks(request, "U1");
    expect(messageViolations(blocks)).toEqual([]);
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: APPROVAL_PING }
    });
    expect(blocksText(blocks)).not.toContain(ASK_PING);
  });

  it("mentions them for an approval among questions answered in the modal", () => {
    const request = form(
      [
        { kind: "text", id: "q1", prompt: "Anything to add?" },
        {
          kind: "approval",
          id: "q2",
          prompt: "Approve the rollout?",
          artifact: { id: "plan-1", url: "https://agents.example/a/tok" }
        }
      ],
      "Here is the plan.",
      "req-ping-form"
    );
    const blocks = requestBlocks(request, "U1");
    expect(messageViolations(blocks)).toEqual([]);
    expect(blocksText(blocks)).toContain(APPROVAL_PING);
    expect(requestFallbackText(request, "U1").startsWith(APPROVAL_PING)).toBe(
      true
    );
    expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual(["Answer"]);
  });

  /**
   * No person started the task, which `agent_tasks.started_by` says with a
   * sentinel rather than a null: `process` for a feed turn (an edit or a delete,
   * whose user id is the authored message's author, not the actor), `unknown` for
   * a row written before the column existed and backfilled by migration 0023.
   * Neither is shaped like a Slack user id, so neither is mentioned — and the
   * question is still worth asking, whichever kind it is.
   *
   * The ids below are the same thing from the other side: nothing but the
   * signature-verified envelope writes this column today, but the value is
   * interpolated into a `<@…>` token, where a `>` would close the mention early
   * and leave the rest as text, so rendering checks the shape rather than
   * trusting where the value came from.
   */
  it.each([
    // The sentinels as literals, not as `STARTED_BY_*`: importing them would be
    // an `@/db` import, which is what `check-storage-reset` reads as a spec that
    // touches storage, and this one does not. That they are *these* strings is
    // pinned where they are stored and delivered (`hitl-delivery.spec.ts`); what
    // is pinned here is that a value of this shape names nobody.
    ["the process sentinel", "process"],
    ["the unknown sentinel", "unknown"],
    ["not read at all by this caller", undefined],
    ["empty", ""],
    ["closing the mention early", "U1> ping <!channel"],
    ["a channel id rather than a user's", "C123ABC"],
    ["not an id at all", "not an id"]
  ])("asks nobody when the starter is %s", (_what, starter) => {
    for (const { build, asks, buttons } of FORMS) {
      const request = build();
      const blocks = requestBlocks(request, starter);
      expect(messageViolations(blocks)).toEqual([]);
      expect(blocksText(blocks)).not.toContain("<@");
      // Not as a mention, and not as text either.
      if (starter) expect(blocksText(blocks)).not.toContain(starter);
      // The question is still asked, and asked the same way, by its own controls.
      expect(blocksText(blocks)).toContain(asks);
      expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual(buttons);
      expect(requestFallbackText(request, starter)).toBe(
        requestFallbackText(request)
      );
    }
  });

  /**
   * The mention is a block of its own, so it costs the agent's words nothing: a
   * form already past the message budget is cut in exactly the same place, and
   * the message still fits what Slack accepts.
   */
  it("costs the agent's words none of their room on a form already cut", () => {
    const request = form(
      [
        {
          kind: "approval",
          id: "q1",
          prompt: "Approve the rollout?",
          artifact: { id: "plan-1", url: "https://agents.example/a/tok" }
        }
      ],
      "p ".repeat(9_000),
      "req-ping-long"
    );
    const blocks = requestBlocks(request, "U1");
    expect(messageViolations(blocks)).toEqual([]);
    expect(blocksText(blocks)).toBe(
      `${APPROVAL_PING}\n${blocksText(requestBlocks(request))}`
    );
    // The cut falls where it did, and the mention is not what was cut.
    expect(blocksText(blocks)).toContain("Cut here to fit Slack");
  });

  /**
   * A prompt that is over pings nobody again. {@link resolvedBlocks} and
   * {@link answeredBlocks} take no starter at all — there is nothing left for
   * the person to do, so a second notification would only tell them so.
   */
  it("leaves a resolved or an answered prompt unpinged", () => {
    for (const { build, asks } of FORMS) {
      const request = build();
      const resolved = resolvedBlocks(request, "⏰ Expired — nobody answered.");
      expect(blocksText(resolved)).toContain(asks);
      expect(blocksText(resolved)).not.toContain("<@");

      const answered = answeredBlocks({
        request,
        answers: { q1: { text: "ok" } },
        answeredBy: "U1"
      });
      // The one mention an answered prompt carries is who answered it.
      expect(blocksText(answered)).toContain("Answered by <@U1>");
      expect(blocksText(answered).match(/<@/g)).toHaveLength(1);
      expect(blocksText(answered)).not.toContain("needs your");
    }
  });
});

describe("the controls", () => {
  it("read back as the pick or the modal they stand for", () => {
    const request = choiceForm("req-c", "Which?", [
      { id: "first", label: "First" },
      { id: "second", label: "Second" }
    ]);
    const [, second, other] = buttonsOf(requestBlocks(request));
    const pick = readControl({
      actionId: second!.action_id,
      value: second!.value
    });
    expect(pick).toEqual({
      kind: "pick",
      requestId: "req-c",
      question: 0,
      option: 1
    });
    expect(
      pickAnswers(request, pick as Extract<typeof pick, { kind: "pick" }>)
    ).toEqual({ q1: { optionIds: ["second"] } });
    expect(
      readControl({ actionId: other!.action_id, value: other!.value })
    ).toEqual({ kind: "open", requestId: "req-c", question: 0 });
  });

  it("carry an agent's long request id in the value, not the capped action id", () => {
    const requestId = "r".repeat(400);
    const [button] = buttonsOf(requestBlocks(choiceForm(requestId)));
    expect(button!.action_id.length).toBeLessThan(255);
    expect(
      readControl({ actionId: button!.action_id, value: button!.value })
        ?.requestId
    ).toBe(requestId);
  });

  it("go back a page from a paged form's later one", () => {
    const view = formView(manyQuestions(40), 1);
    const back = (view.blocks as Record<string, unknown>[]).find(
      (b) => b.type === "actions"
    ) as { elements: Button[] };
    const [button] = back.elements;
    expect(button!.text.text).toBe("← Back");
    expect(
      readControl({ actionId: button!.action_id, value: button!.value })
    ).toEqual({ kind: "back", requestId: "req-1", page: 0 });
  });

  it("ignore anything that is not one of them", () => {
    expect(readControl({ actionId: "something", value: "x" })).toBeNull();
    expect(readControl({ actionId: "hitl-open", value: "{}" })).toBeNull();
  });
});

describe("the form's modal", () => {
  const request = form(
    [
      {
        kind: "choice",
        id: "db",
        prompt: "Which database?",
        header: "Database",
        options: [
          { id: "pg", label: "Postgres", description: "In production." },
          { id: "lite", label: "SQLite" }
        ]
      },
      {
        kind: "choice",
        id: "checks",
        prompt: "Which checks?",
        multiple: true,
        options: [
          { id: "lint", label: "lint" },
          { id: "test", label: "test" }
        ]
      },
      {
        kind: "choice",
        id: "region",
        prompt: "Which region?",
        options: Array.from({ length: 12 }, (_, i) => ({
          id: `r${i}`,
          label: `Region ${i}`
        }))
      },
      { kind: "text", id: "name", prompt: "Name it?" },
      {
        kind: "approval",
        id: "plan",
        prompt: "Approve the plan?",
        artifact: { id: "plan-1", url: "https://agents.example/a/tok" }
      }
    ],
    "Before I start:"
  );

  it("gives each question an input of its kind, within Slack's limits", () => {
    const view = formView(request);
    expect(viewViolations(view)).toEqual([]);
    // One page: sent from it, with nothing to page back to.
    expect(readViewMeta(view.private_metadata as string)).toEqual({
      r: "req-1",
      p: 0
    });
    expect(view.title).toEqual({ type: "plain_text", text: "Your answer" });
    expect(view.submit).toEqual({ type: "plain_text", text: "Send" });
    expect(
      (view.blocks as { type: string }[]).some((b) => b.type === "actions")
    ).toBe(false);
    expect(
      inputsOf(view).map((b) => [b.block_id, b.element.type, b.optional])
    ).toEqual([
      ["q0:choice", "radio_buttons", true],
      ["q0:other", "plain_text_input", true],
      ["q1:choice+", "checkboxes", true],
      ["q1:other", "plain_text_input", true],
      ["q2:choice", "static_select", true],
      ["q2:other", "plain_text_input", true],
      ["q3:text", "plain_text_input", false],
      ["q4:approval", "radio_buttons", true],
      ["q4:other", "plain_text_input", true]
    ]);
    // A description is in the list above its options, not again under each.
    expect(
      inputsOf(view).flatMap(
        (b) => (b.element.options ?? []) as Record<string, unknown>[]
      )
    ).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ description: expect.anything() })
      ])
    );
    // Short labels and nothing more to them: the controls carry them alone.
    expect(blocksText(view.blocks as unknown[])).not.toContain("*1.* lint");
    // Answers past 3,000 characters reach the agent without a cap.
    expect(inputsOf(view)[6]!.element).not.toHaveProperty("max_length");
  });

  it("opens one question's words alone, for Other… and Comment…", () => {
    const view = wordsView(request, 4);
    expect(viewViolations(view)).toEqual([]);
    expect(readViewMeta(view.private_metadata as string)).toEqual({
      r: "req-1"
    });
    expect(inputsOf(view).map((b) => [b.block_id, b.optional])).toEqual([
      ["q4:other", false]
    ]);
    expect(blocksText(view.blocks)).toContain("Approve the plan?");
  });

  /** A page shown again — after Back, or reopened — holds what was entered. */
  it("holds the answers already given in each input", () => {
    const view = formView(request, 0, {
      db: { optionIds: ["lite"], text: "for now" },
      checks: { optionIds: ["lint", "test"] },
      region: { optionIds: ["r11"] },
      name: { text: "forms" },
      plan: { optionIds: ["reject"], text: "smaller" }
    });
    expect(viewViolations(view)).toEqual([]);
    const initial = inputsOf(view).map((b) => {
      const e = b.element as Record<string, unknown>;
      const one = e.initial_option as { value: string } | undefined;
      const many = e.initial_options as { value: string }[] | undefined;
      return [
        b.block_id,
        e.initial_value ?? one?.value ?? many?.map((o) => o.value)
      ];
    });
    expect(initial).toEqual([
      ["q0:choice", "1"],
      ["q0:other", "for now"],
      ["q1:choice+", ["0", "1"]],
      ["q1:other", undefined],
      ["q2:choice", "11"],
      ["q2:other", undefined],
      ["q3:text", "forms"],
      ["q4:approval", "reject"],
      ["q4:other", "smaller"]
    ]);
    // Slack takes an initial option only as one of the element's own.
    const select = inputsOf(view)[4]!.element;
    expect(select.options).toContainEqual(select.initial_option);
  });

  it("reads what is entered so far, unanswered questions left out", () => {
    expect(
      enteredAnswers(
        request,
        state(
          ["q0:choice", { picks: [] }],
          ["q0:other", { text: "" }],
          ["q3:text", { text: "forms" }]
        )
      )
    ).toEqual({ name: { text: "forms" } });
  });

  it("reads a modal's inputs from a click inside it, as a submission carries them", () => {
    const values = viewValues({
      state: {
        values: {
          "q0:choice": {
            value: { type: "radio_buttons", selected_option: { value: "0" } }
          },
          "q3:text": { value: { type: "plain_text_input", value: "forms" } }
        }
      }
    });
    expect(enteredAnswers(request, values)).toEqual({
      db: { optionIds: ["pg"] },
      name: { text: "forms" }
    });
    expect(viewValues(undefined)).toEqual([]);
  });

  it("reads a submission back as answers keyed by question", () => {
    const values = state(
      ["q0:choice", { picks: ["0"] }],
      ["q0:other", { text: "" }],
      ["q1:choice+", { picks: ["0", "1"] }],
      ["q1:other", { text: "and typecheck" }],
      ["q2:choice", { picks: [] }],
      ["q2:other", { text: "wherever is cheapest" }],
      ["q3:text", { text: "  forms  " }],
      ["q4:approval", { picks: ["approve"] }],
      ["q4:other", { text: "" }]
    );
    expect(formErrors(request, values)).toBeUndefined();
    expect(formAnswers(request, values)).toEqual({
      db: { optionIds: ["pg"] },
      checks: { optionIds: ["lint", "test"], text: "and typecheck" },
      region: { text: "wherever is cheapest" },
      name: { text: "forms" },
      plan: { optionIds: ["approve"] }
    });
  });

  it("refuses a question left without a pick or words, under that question", () => {
    expect(
      formErrors(
        request,
        state(
          ["q0:choice", { picks: [] }],
          ["q0:other", { text: "   " }],
          ["q3:text", { text: "   " }],
          ["q4:approval", { picks: [] }]
        )
      )
    ).toEqual({
      "q0:choice": "Pick an option, or write yours in Other below.",
      "q3:text": "Write an answer.",
      "q4:approval": "Approve, reject, or leave a comment below."
    });
  });

  it("refuses words longer together than the agent takes", () => {
    const half = "x".repeat(MAX_MESSAGE_TEXT_BYTES / 2 + 1);
    expect(
      formErrors(
        request,
        state(["q0:other", { text: half }], ["q3:text", { text: half }])
      )
    ).toEqual({
      "q3:text": "These answers are too long to send — please shorten them."
    });
  });

  /**
   * The agent measures the text part the answers go in, and that names each
   * question beside its words: words that fit on their own can still make a
   * message it refuses, after the question is spent.
   */
  it("measures the text the answers are sent with, headings included", () => {
    const two = form([
      { kind: "text", id: "a", prompt: "First?", header: "First" },
      { kind: "text", id: "b", prompt: "Second?", header: "Second" }
    ]);
    const half = "x".repeat(MAX_MESSAGE_TEXT_BYTES / 2 - 1);
    expect(
      formErrors(
        two,
        state(["q0:text", { text: half }], ["q1:text", { text: half }])
      )
    ).toEqual({
      "q1:text": "These answers are too long to send — please shorten them."
    });
  });

  it("keeps the answer to a question whatever its id", () => {
    const odd = form([
      { kind: "text", id: "__proto__", prompt: "First?" },
      { kind: "text", id: "constructor", prompt: "Second?" }
    ]);
    const answers = formAnswers(
      odd,
      state(["q0:text", { text: "one" }], ["q1:text", { text: "two" }])
    );
    expect(Object.keys(answers ?? {})).toEqual(["__proto__", "constructor"]);
    expect(JSON.parse(JSON.stringify(answers))).toEqual(
      JSON.parse('{"__proto__":{"text":"one"},"constructor":{"text":"two"}}')
    );
  });

  /** The question is right above its input: the label says what to do with it. */
  it("labels each input with what to do, not with the question again", () => {
    const view = formView(request);
    expect(inputsOf(view).map((b) => [b.block_id, b.label.text])).toEqual([
      ["q0:choice", "Pick one"],
      ["q0:other", "Other"],
      ["q1:choice+", "Pick any"],
      ["q1:other", "Other"],
      ["q2:choice", "Pick one"],
      ["q2:other", "Other"],
      ["q3:text", "Your answer"],
      ["q4:approval", "Approve or reject"],
      ["q4:other", "Comment"]
    ]);
  });
});

/**
 * Past what one modal holds, the form is paged rather than refused: the agent
 * asked one form, and the gate keeps each page's answers until the last sends
 * them all.
 */
describe("a form too long for one modal", () => {
  const request = manyQuestions(40);

  it("is paged, every question whole on one page, in order", () => {
    const pages = formPages(request);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(request.questions.map((_, i) => i));
    pages.forEach((_, p) => {
      expect(viewViolations(formView(request, p))).toEqual([]);
    });
  });

  it("goes Next page by page, and is sent from its last", () => {
    const pages = formPages(request);
    const views = pages.map((_, p) => formView(request, p));
    expect(views.map((v) => (v.title as { text: string }).text)).toEqual(
      pages.map((_, p) => `Your answer · ${p + 1} of ${pages.length}`)
    );
    expect(views.map((v) => (v.submit as { text: string }).text)).toEqual(
      pages.map((_, p) => (p === pages.length - 1 ? "Send" : "Next"))
    );
    expect(
      views.map((v) => readViewMeta(v.private_metadata as string)?.p)
    ).toEqual(pages.map((_, p) => p));
    // The agent's words are the message's, not said again on any page.
    for (const v of views) {
      expect(blocksText(v.blocks as unknown[])).not.toContain(
        "Some context first."
      );
    }
  });

  it("offers Back on every page but the first", () => {
    const pages = formPages(request);
    const backs = pages.map((_, p) =>
      (formView(request, p).blocks as { type: string }[]).some(
        (b) => b.type === "actions"
      )
    );
    expect(backs).toEqual(pages.map((_, p) => p > 0));
  });

  it("keeps a form that fits on one page whole", () => {
    expect(formPages(manyQuestions(20))).toEqual([
      Array.from({ length: 20 }, (_, i) => i)
    ]);
  });
});

describe("the answered prompt", () => {
  it("shortens a long preamble rather than lose the answers under it", () => {
    const request = form(
      [
        { kind: "text", id: "a", prompt: "First question?" },
        { kind: "text", id: "b", prompt: "Final question?" }
      ],
      "Context. ".repeat(1_500)
    );
    const blocks = answeredBlocks({
      request,
      answers: { a: { text: "first answer" }, b: { text: "final answer" } },
      answeredBy: "U1"
    });
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    expect(text).toContain("first answer");
    expect(text).toContain("final answer");
    expect(text).not.toContain("the agent has the full answer");
    // Shortened, visibly.
    expect(text).toMatch(/^Context\. [^…]*…/);
  });

  it("fits a long answer under a long form, marking where it is cut", () => {
    const request = longForm();
    const blocks = answeredBlocks({
      request,
      answers: Object.fromEntries(
        request.questions.map((q) => [
          q.id,
          { text: "I never merge work in progress. ".repeat(80) }
        ])
      ),
      answeredBy: "U1"
    });
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    expect(text).toContain("the agent has the full answer");
    expect(text).toContain("Answered by <@U1>");
  });

  it("shows picks by label and words as written, each under its question", () => {
    const text = blocksText(
      answeredBlocks({
        request: form([
          {
            kind: "choice",
            id: "db",
            prompt: "Which database?",
            options: [{ id: "pg", label: "Postgres" }]
          },
          { kind: "text", id: "name", prompt: "Name it?" }
        ]),
        answers: {
          db: { optionIds: ["pg"] },
          name: { text: "<@U2> & <!here>" }
        },
        answeredBy: "U1"
      })
    );
    expect(text).toContain("Which database?\n:white_check_mark: *Postgres*");
    expect(text).toContain("&lt;@U2&gt; &amp;");
    expect(text).not.toContain("<!here>");
  });
});

describe("a closed prompt", () => {
  it("re-renders a long form within the limits, as the agent's words it was asked under", () => {
    const blocks = resolvedBlocks(longForm(), "⏳ This prompt expired.");
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    expect(text).toContain("Context paragraph 30.");
    expect(text).not.toContain("Question 5:");
    expect(text).toContain("This prompt expired.");
    expect(buttonsOf(blocks)).toEqual([]);
  });
});

describe("fallbackText", () => {
  it("cuts the notification text", () => {
    expect(fallbackText("z".repeat(10_000))).toHaveLength(3_000);
    expect(fallbackText("short")).toBe("short");
  });
});

describe("what a cut may not lose", () => {
  /**
   * A cut shares out what room is left, and a share can be a character or
   * two: a cut that overruns its share pushes the end of the message — an
   * option's heading — past where Slack keeps it.
   */
  it("keeps every cut within its room, however little", () => {
    const texts = [
      "word ".repeat(40),
      `see ${"<https://example.com/x|a link> ".repeat(5)}`,
      `${"```"}\n${"code ".repeat(40)}`
    ];
    for (const text of texts) {
      for (let max = 0; max <= 40; max++) {
        expect(clipMrkdwn(text, max).length).toBeLessThanOrEqual(max);
      }
    }
    expect(clipMrkdwn("short", 5)).toBe("short");
    expect(clipMrkdwn("longer", 1)).toBe("…");
    expect(clipMrkdwn("longer", 0)).toBe("");
  });

  it("keeps a Slack link whole when the last space before the cut is inside it", () => {
    const link = `<https://example.com/${"p".repeat(30)}|a label ${"with words ".repeat(7)}to end on>`;
    const pieces = splitMrkdwn(`${"word ".repeat(576)}${link} after`);
    expect(pieces.some((p) => p.includes(link))).toBe(true);
    for (const p of pieces) {
      expect(p.split("<").length).toBe(p.split(">").length);
    }
  });

  it("keeps a closing fence whole when a hard cut lands on it", () => {
    const pieces = splitMrkdwn(`\`\`\`\n${"x".repeat(2987)}\`\`\`After`);
    const last = pieces.find((p) => p.includes("After"))!;
    const before = last.slice(0, last.indexOf("After"));
    expect((before.split("```").length - 1) % 2).toBe(0);
    expect(pieces.join("")).toContain("x".repeat(2987));
    // The block closed at the cut is not reopened only to close again.
    expect(pieces.some((p) => p.startsWith("```\n```"))).toBe(false);
  });

  it("cuts a link longer than a whole section like prose, every piece within the limit", () => {
    const link = `<https://example.com/${"p".repeat(4_000)}|label>`;
    const pieces = splitMrkdwn(`Before ${link} after`);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(3_000);
    expect(pieces.join("")).toContain("p".repeat(2_000));
  });

  /**
   * A message shortened to fit would show buttons beside options nobody can
   * read in full, so a question too long for one is answered in the modal,
   * which shows it whole.
   */
  it("answers in the modal a question too long for one message, shown whole there", () => {
    const request = form(
      [
        {
          kind: "choice",
          id: "q1",
          prompt: "Which?",
          options: [
            {
              id: "a",
              label: "First choice",
              description: `${"d ".repeat(4_500)}the end of it.`
            },
            { id: "b", label: "Second choice" }
          ]
        }
      ],
      "p ".repeat(4_500)
    );
    const blocks = requestBlocks(request);
    expect(messageViolations(blocks)).toEqual([]);
    expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual(["Answer"]);
    expect(blocksText(blocks)).not.toContain("First choice");
    const view = formView(request);
    expect(viewViolations(view)).toEqual([]);
    const text = blocksText(view.blocks as unknown[]);
    expect(text).toContain("*1.* First choice");
    expect(text).toContain("the end of it.");
  });

  it("answers a question in the thread when it fits one message whole", () => {
    const blocks = requestBlocks(
      form(
        [
          {
            kind: "choice",
            id: "q1",
            prompt: "Which?",
            options: [
              {
                id: "a",
                label: "First choice",
                description: "d ".repeat(2_000)
              },
              { id: "b", label: "Second choice" }
            ]
          }
        ],
        "p ".repeat(2_000)
      )
    );
    expect(messageViolations(blocks)).toEqual([]);
    expect(blocksText(blocks)).toContain("*2.* Second choice");
    expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual([
      "1",
      "2",
      "Other…"
    ]);
  });

  it("cuts agent words past the message between links, and opens the modal with them whole", () => {
    const words = `Context. ${"[a link](https://example.com/a-long-path) ".repeat(400)}The end.`;
    const request = form(
      [
        {
          kind: "choice",
          id: "q1",
          prompt: "Which side?",
          options: [
            { id: "l", label: "Left" },
            { id: "r", label: "Right" }
          ]
        }
      ],
      words
    );
    const blocks = requestBlocks(request);
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual(["Answer"]);
    // Cut visibly, between links rather than inside one.
    expect(text).toMatch(/\|a link>\s*…\s+_Cut here/);
    const modal = blocksText(formView(request).blocks as unknown[]);
    expect(modal).toContain("The end.");
    expect(modal).toContain("Which side?");
  });

  /**
   * The message is the one place a form's agent words are shown, so words
   * past what it holds would be lost: the modal opens with them whole instead.
   */
  it("opens a form's modal with agent words the message had to cut", () => {
    const words = `Context. ${"Some more of it. ".repeat(900)}The end.`;
    const request = form(
      [
        { kind: "text", id: "q1", prompt: "First question?" },
        { kind: "text", id: "q2", prompt: "Final question?" }
      ],
      words
    );
    const blocks = requestBlocks(request);
    expect(messageViolations(blocks)).toEqual([]);
    expect(blocksText(blocks)).toContain("the rest opens with the questions");
    const view = formView(request);
    expect(viewViolations(view)).toEqual([]);
    expect(blocksText(view.blocks as unknown[])).toContain("The end.");
  });

  it("shows the modal every question, past what a message holds", () => {
    const request = form(
      [
        { kind: "text", id: "q1", prompt: "First question?" },
        { kind: "text", id: "q2", prompt: "Final question?" }
      ],
      "Context. ".repeat(1_500)
    );
    const view = formView(request);
    expect(viewViolations(view)).toEqual([]);
    expect(blocksText(view.blocks)).toContain("Final question?");
  });
});
