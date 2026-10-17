import { describe, it, expect } from "vitest";
import {
  SLACK_FREEFORM_ACTION_ID,
  SLACK_FREEFORM_BLOCK_ID
} from "@chat-adapter/slack/blocks";
import {
  answeredBlocks,
  fallbackText,
  freeformView,
  promptBlocks,
  requestBlocks,
  resolvedBlocks,
  splitMrkdwn
} from "@/slack/hitl/render";
import {
  blocksText,
  messageViolations,
  viewViolations
} from "../helpers/slack-limits";

// Pure rendering; no storage, so no `useStorageReset()` — see
// test/helpers/storage.ts.

/**
 * A prompt shaped like the one that lost its questions: a long preamble, then
 * numbered questions that all start past the 3,000th character.
 */
function longPrompt(): string {
  const preamble = Array.from(
    { length: 30 },
    (_, i) =>
      `Context paragraph ${i + 1}. ${"Detail about the plan. ".repeat(4)}`
  ).join("\n\n");
  const questions = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `${n}. **Question ${n}:** ${"Which way should this go? ".repeat(3)}`
    )
    .join("\n");
  return `${preamble}\n\n${questions}`;
}

const longLabels = [
  "x".repeat(218),
  "Rebase the branch onto main and keep every commit as it is, then merge",
  "Squash and merge",
  "y".repeat(93)
];

function actionsOf(
  blocks: unknown[]
): { text: { text: string }; value?: string }[] {
  const actions = blocks.find(
    (b) => (b as { type?: string }).type === "actions"
  ) as { elements: { text: { text: string }; value?: string }[] } | undefined;
  return actions?.elements ?? [];
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
    // Nothing lost: every paragraph lands whole in some piece.
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

describe("requestBlocks", () => {
  it("shows every question of a prompt past 3,000 characters", () => {
    const blocks = requestBlocks({
      requestId: "req-long",
      prompt: longPrompt(),
      display: "buttons",
      allowFreeform: true
    });
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    for (const n of [1, 2, 3, 4, 5]) expect(text).toContain(`Question ${n}:`);
  });

  it("lists long options in full above buttons that show their numbers", () => {
    const blocks = requestBlocks({
      requestId: "req-opts",
      prompt: "Which merge?",
      display: "buttons",
      options: longLabels.map((label, i) => ({ id: `option_${i + 1}`, label }))
    });
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    for (const label of longLabels) expect(text).toContain(label);
    const buttons = actionsOf(blocks);
    expect(buttons.map((b) => b.text.text)).toEqual(["1", "2", "3", "4"]);
    // The value is still the option id, which is what comes back on a click.
    expect(buttons.map((b) => b.value)).toEqual([
      "option_1",
      "option_2",
      "option_3",
      "option_4"
    ]);
  });

  it("lists options that carry a description, even with short labels", () => {
    const blocks = requestBlocks({
      requestId: "req-desc",
      prompt: "Which?",
      display: "buttons",
      options: [
        { id: "a", label: "A", description: "The first way, explained." },
        { id: "b", label: "B" }
      ]
    });
    expect(blocksText(blocks)).toContain("The first way, explained.");
    expect(actionsOf(blocks).map((b) => b.text.text)).toEqual(["1", "2"]);
  });

  it("keeps short labels on their buttons, with no list", () => {
    const blocks = requestBlocks({
      requestId: "req-short",
      prompt: "Proceed?",
      display: "buttons",
      options: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "reject", label: "Reject", style: "danger" }
      ]
    });
    expect(blocks).toHaveLength(2);
    expect(actionsOf(blocks).map((b) => b.text.text)).toEqual([
      "Approve",
      "Reject"
    ]);
  });

  it("numbers radio options within Slack's 75 characters, marking the cut", () => {
    const blocks = requestBlocks({
      requestId: "req-radio",
      prompt: "Which?",
      display: "radio",
      options: longLabels.map((label, i) => ({ id: `o${i}`, label }))
    });
    expect(messageViolations(blocks)).toEqual([]);
    const radio = (
      blocks.find((b) => (b as { type?: string }).type === "actions") as {
        elements: { options: { text: { text: string } }[] }[];
      }
    ).elements[0];
    expect(radio.options[0].text.text).toMatch(/^1\. x+…$/);
    expect(radio.options[2].text.text).toBe("3. Squash and merge");
  });

  it("converts the agent's Markdown and defuses channel-wide mentions", () => {
    const text = blocksText(
      requestBlocks({
        requestId: "req-md",
        prompt: "**Bold** <!channel> and @here",
        display: "buttons"
      })
    );
    expect(text).toContain("*Bold*");
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("@here");
  });

  it("cuts a prompt past what a message holds, and says so", () => {
    const blocks = promptBlocks("word ".repeat(4_000));
    expect(messageViolations(blocks)).toEqual([]);
    expect(blocksText(blocks)).toContain("The question is cut here");
  });
});

describe("answeredBlocks", () => {
  it("fits a long answer under a long prompt, marking where it is cut", () => {
    const blocks = answeredBlocks({
      prompt: longPrompt(),
      answer: "I never merge work in progress. ".repeat(320),
      answeredBy: "U1"
    });
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    expect(text).toContain("Question 5:");
    expect(text).toContain("the agent has the full answer");
    expect(text).toContain("Answered by <@U1>");
  });

  it("shows a typed answer as written, not as Slack markup", () => {
    const text = blocksText(
      answeredBlocks({
        prompt: "Name it",
        answer: "<@U2> & <!here>\nsecond line",
        answeredBy: "U1"
      })
    );
    expect(text).toContain("&lt;@U2&gt; &amp;");
    expect(text).not.toContain("<!here>");
  });

  it("bolds a short one-line answer", () => {
    expect(
      blocksText(
        answeredBlocks({
          prompt: "Proceed?",
          answer: "Approve",
          answeredBy: "U1"
        })
      )
    ).toContain(":white_check_mark: *Approve*");
  });
});

describe("resolvedBlocks", () => {
  it("re-renders a long prompt within the limits", () => {
    const blocks = resolvedBlocks(longPrompt(), "⏳ This prompt expired.");
    expect(messageViolations(blocks)).toEqual([]);
    expect(blocksText(blocks)).toContain("Question 5:");
  });
});

describe("freeformView", () => {
  it("shows the whole question and leaves the answer's length to the agent", () => {
    const view = freeformView({ requestId: "req-1", prompt: longPrompt() });
    expect(viewViolations(view)).toEqual([]);
    expect(blocksText(view.blocks)).toContain("Question 5:");
    const input = (view.blocks as Record<string, unknown>[]).find(
      (b) => b.type === "input"
    ) as { block_id: string; element: Record<string, unknown> };
    expect(input.block_id).toBe(SLACK_FREEFORM_BLOCK_ID);
    expect(input.element.action_id).toBe(SLACK_FREEFORM_ACTION_ID);
    expect(input.element).not.toHaveProperty("max_length");
    expect(view.private_metadata).toBe("req-1");
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
    expect(pieces.join("")).toContain("x".repeat(2987)); // The block closed at the cut is not reopened only to close again.
    expect(pieces.some((p) => p.startsWith("```\n```"))).toBe(false);
  });

  it("cuts a link longer than a whole section like prose, every piece within the limit", () => {
    const link = `<https://example.com/${"p".repeat(4_000)}|label>`;
    const pieces = splitMrkdwn(`Before ${link} after`);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(3_000);
    expect(pieces.join("")).toContain("p".repeat(2_000));
  });

  it("names every numbered option, however long the prompt and descriptions", () => {
    const blocks = requestBlocks({
      requestId: "req-budget",
      prompt: "p ".repeat(4_500),
      display: "buttons",
      options: [
        { id: "a", label: "First choice", description: "d ".repeat(4_500) },
        { id: "b", label: "Second choice" }
      ]
    });
    expect(messageViolations(blocks)).toEqual([]);
    const text = blocksText(blocks);
    expect(text).toContain("*1.* First choice");
    expect(text).toContain("*2.* Second choice");
  });

  it("keeps labels on the buttons when not even the options' headings fit", () => {
    const blocks = requestBlocks({
      requestId: "req-heads",
      prompt: "p ".repeat(4_500),
      display: "buttons",
      options: Array.from({ length: 5 }, (_, i) => ({
        id: `o${i}`,
        label: `${i} ${"long label ".repeat(100)}`
      }))
    });
    expect(messageViolations(blocks)).toEqual([]);
    const labels = (
      blocks.find((b) => (b as { type?: string }).type === "actions") as {
        elements: { text: { text: string } }[];
      }
    ).elements.map((e) => e.text.text);
    expect(labels[0]).toMatch(/^0 long label .*…$/);
    expect(labels.every((l) => l.length <= 75)).toBe(true);
  });

  it("shows the modal the whole question, past what a message holds", () => {
    const view = freeformView({
      requestId: "req-modal",
      prompt: `${"Context. ".repeat(1_000)}\n\nFinal question?`
    });
    expect(viewViolations(view)).toEqual([]);
    expect(blocksText(view.blocks)).toContain("Final question?");
  });
});
