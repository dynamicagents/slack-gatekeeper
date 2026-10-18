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
  fallbackText,
  formView,
  requestBlocks,
  resolvedBlocks,
  splitMrkdwn
} from "@/slack/hitl/render";
import {
  formAnswers,
  formErrors,
  pickAnswers,
  readControl
} from "@/slack/hitl/answer";
import {
  blocksText,
  messageViolations,
  viewViolations
} from "../helpers/slack-limits";
import { choiceForm } from "../helpers/hitl";

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

  it("shows every question of a long form, and answers it from one button", () => {
    const blocks = requestBlocks(longForm());
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    for (const n of [1, 2, 3, 4, 5]) expect(text).toContain(`Question ${n}:`);
    expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual(["Answer"]);
  });

  it("numbers a form's questions, under their headers", () => {
    const text = blocksText(
      requestBlocks(
        form([
          {
            kind: "choice",
            id: "q1",
            prompt: "Which database?",
            header: "Database",
            options: [{ id: "a", label: "Postgres" }]
          },
          { kind: "text", id: "q2", prompt: "Name it?" }
        ])
      )
    );
    expect(text).toContain("*1. Database*\nWhich database?");
    expect(text).toContain("*1.* Postgres");
    expect(text).toContain("*2.* Name it?");
  });

  it("converts the agent's Markdown and defuses channel-wide mentions", () => {
    const text = blocksText(
      requestBlocks(choiceForm("req-md", "**Bold** <!channel> and @here"))
    );
    expect(text).toContain("*Bold*");
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("@here");
  });

  it("says a form too big for one modal cannot be answered here, rather than offer a button that fails", () => {
    const blocks = requestBlocks(
      form(
        Array.from({ length: 40 }, (_, i) => ({
          kind: "choice" as const,
          id: `q${i}`,
          prompt: `Question ${i}?`,
          options: [{ id: "a", label: "A" }]
        }))
      )
    );
    expect(buttonsOf(blocks)).toEqual([]);
    expect(blocksText(blocks)).toContain("too large to answer in Slack");
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
    expect(view.private_metadata).toBe("req-1");
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
    expect(inputsOf(view)[0]!.label.text).toBe("Database");
    // Answers past 3,000 characters reach the agent without a cap.
    expect(inputsOf(view)[6]!.element).not.toHaveProperty("max_length");
  });

  it("opens one question's words alone, for Other… and Comment…", () => {
    const view = formView(request, 4);
    expect(viewViolations(view)).toEqual([]);
    expect(inputsOf(view).map((b) => [b.block_id, b.optional])).toEqual([
      ["q4:other", false]
    ]);
    expect(blocksText(view.blocks)).toContain("Approve the plan?");
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
      "q0:choice": "Pick one, or answer in your own words below.",
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

  it("caps an input's label, the header above it shown whole", () => {
    const header = "h".repeat(2_001);
    const view = formView(
      form([
        { kind: "text", id: "a", prompt: "First?", header },
        { kind: "text", id: "b", prompt: "Second?" }
      ])
    );
    expect(viewViolations(view)).toEqual([]);
    expect(inputsOf(view)[0]!.label.text).toHaveLength(2_000);
    expect(blocksText(view.blocks).replace(/\s/g, "")).toContain(header);
  });
});

describe("the answered prompt", () => {
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
  it("re-renders a long form within the limits", () => {
    const blocks = resolvedBlocks(longForm(), "⏳ This prompt expired.");
    expect(messageViolations(blocks)).toEqual([]);
    expect(blocksText(blocks)).toContain("Question 5:");
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

  it("names every numbered option, however long the prompt and descriptions", () => {
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
                description: "d ".repeat(4_500)
              },
              { id: "b", label: "Second choice" }
            ]
          }
        ],
        "p ".repeat(4_500)
      )
    );
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    expect(text).toContain("*1.* First choice");
    expect(text).toContain("*2.* Second choice");
    expect(buttonsOf(blocks).map((b) => b.text.text)).toEqual([
      "1",
      "2",
      "Other…"
    ]);
  });

  it("keeps labels on the buttons when not even the options' headings fit", () => {
    const blocks = requestBlocks(
      form(
        [
          {
            kind: "choice",
            id: "q1",
            prompt: "Which?",
            // Headings past a message on their own: a preamble alone is
            // shortened instead.
            options: Array.from({ length: 5 }, (_, i) => ({
              id: `o${i}`,
              label: `${i} ${"long label ".repeat(250)}`
            }))
          }
        ],
        "p ".repeat(6_500)
      )
    );
    expect(messageViolations(blocks)).toEqual([]);
    const labels = buttonsOf(blocks).map((b) => b.text.text);
    expect(labels[0]).toMatch(/^0 long label .*…$/);
    expect(labels.every((l) => l.length <= 75)).toBe(true);
  });

  it("shortens a preamble that leaves the questions no room, rather than lose them", () => {
    const blocks = requestBlocks(
      form(
        [
          { kind: "text", id: "q1", prompt: "First question?" },
          { kind: "text", id: "q2", prompt: "Final question?" }
        ],
        `Context. ${"[a link](https://example.com/a-long-path) ".repeat(400)}`
      )
    );
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    expect(text).toContain("*1.* First question?");
    expect(text).toContain("*2.* Final question?");
    expect(text).not.toContain("Cut here");
    // Shortened visibly, and between links rather than inside one.
    const preamble = text.slice(0, text.indexOf("*1.*"));
    expect(preamble).toMatch(/\|a link>\s+…\s*$/);
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
