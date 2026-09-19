import { describe, it, expect } from "vitest";
import { hasSlackBroadcast, sanitizeSlackText } from "@/util/slack-text";
import { sanitizeDisplayName } from "@/util/display-name";
import { normalizeWhitespace, renderEditDiff } from "@/util/text-diff";

// The pure text helpers. Neither touches storage, so neither pays the D1 reset —
// see test/apply-migrations.ts.

describe("sanitizeSlackText", () => {
  it("neutralizes command-sequence broadcasts", () => {
    const out = sanitizeSlackText(
      "<!channel> <!here> <!everyone> <!subteam^S1|@grp>"
    );
    expect(out).not.toContain("<!");
    expect(out).toBe("channel here everyone subteam^S1|@grp");
  });

  it("neutralizes plain @channel / @here / @everyone", () => {
    expect(sanitizeSlackText("hey @channel and @Here and @everyone")).toBe(
      "hey channel and Here and everyone"
    );
  });

  it("leaves lookalikes and single mentions alone", () => {
    expect(
      sanitizeSlackText("mail ops@here.com about @channels via <@U1> in <#C2>")
    ).toBe("mail ops@here.com about @channels via <@U1> in <#C2>");
  });

  it("strips control characters but keeps tabs and newlines", () => {
    expect(sanitizeSlackText("ab\tc\nd")).toBe("ab\tc\nd");
  });
});

describe("hasSlackBroadcast", () => {
  it("detects both spellings anywhere in the string", () => {
    expect(hasSlackBroadcast("Ops <!here> Bot")).toBe(true);
    expect(hasSlackBroadcast("Ops @here Bot")).toBe(true);
    // Regex reuse must not carry lastIndex state between calls.
    expect(hasSlackBroadcast("Ops @here Bot")).toBe(true);
  });

  it("does not flag ordinary names, addresses or single mentions", () => {
    expect(hasSlackBroadcast("Ops Bot")).toBe(false);
    expect(hasSlackBroadcast("Ops <@U123> Bot")).toBe(false);
    expect(hasSlackBroadcast("ops@here.com")).toBe(false);
    expect(hasSlackBroadcast("@channels")).toBe(false);
  });
});

describe("sanitizeDisplayName", () => {
  it("neutralizes a broadcast name in either spelling", () => {
    expect(sanitizeDisplayName("<!channel>")).toBe("channel");
    expect(sanitizeDisplayName("@everyone Bot")).toBe("everyone Bot");
  });

  it("collapses whitespace and trims so the name stays one line", () => {
    expect(sanitizeDisplayName("  Ops\n  Bot  ")).toBe("Ops Bot");
  });

  it("returns empty when nothing renderable survives", () => {
    expect(sanitizeDisplayName("  ")).toBe("");
  });
});

describe("normalizeWhitespace", () => {
  it("collapses runs of whitespace and trims the ends", () => {
    expect(normalizeWhitespace("  a\n\n b   c ")).toBe("a b c");
  });

  it("treats whitespace-only differences as equal", () => {
    expect(normalizeWhitespace("hello  world ")).toBe(
      normalizeWhitespace("hello world")
    );
  });
});

describe("renderEditDiff", () => {
  it("returns an empty string when the texts are token-identical", () => {
    expect(renderEditDiff("same text", "same text")).toBe("");
  });

  it("marks a single replaced word wdiff-style with surrounding context", () => {
    const out = renderEditDiff("the old text here", "the new text here");
    expect(out).toBe("the [-old-][+new+] text here");
  });

  it("marks a pure insertion", () => {
    const out = renderEditDiff("keep this", "keep the this");
    expect(out).toMatch(/\[\+the ?\+\]/); // added word (may carry an adjacent space)
    expect(out).not.toContain("[-");
  });

  it("marks a pure deletion", () => {
    const out = renderEditDiff("keep the this", "keep this");
    expect(out).toMatch(/\[-the ?-\]/); // removed word (may carry an adjacent space)
    expect(out).not.toContain("[+");
  });

  it("emits one hunk per distant change, newline-separated", () => {
    const filler = "word ".repeat(30).trim(); // > 2*25 chars between changes
    const prev = `alpha ${filler} bravo`;
    const next = `ALPHA ${filler} BRAVO`;
    const out = renderEditDiff(prev, next);
    const lines = out!.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[-alpha-][+ALPHA+]");
    expect(lines[1]).toContain("[-bravo-][+BRAVO+]");
  });

  it("merges nearby changes into one hunk, showing the connecting text in full", () => {
    const out = renderEditDiff("aa mid bb tail", "AA mid BB tail");
    // "mid" (short gap ≤ 50) keeps both changes on one line with the gap intact.
    expect(out!.split("\n")).toHaveLength(1);
    expect(out).toContain("[-aa-][+AA+] mid [-bb-][+BB+]");
  });

  it("completes in under 100ms for a fully-different 4000-char input", () => {
    // Build two strings of 4000 printable chars (codes 33–126), spaced every 5
    // chars. Offset the second by 47 (half of the 94-char range) so every word
    // is a different token — worst case for the LCS diff.
    function buildString(offset: number): string {
      const parts: string[] = [];
      for (let i = 0; i < 4000; i++) {
        if (i > 0 && i % 5 === 0) parts.push(" ");
        parts.push(String.fromCharCode(33 + ((i ^ offset) % 94)));
      }
      return parts.join("");
    }
    const prev = buildString(0);
    const next = buildString(47);

    const t0 = performance.now();
    const d = renderEditDiff(prev, next);
    const elapsed = performance.now() - t0;

    // Baseline is ~25ms locally; the loose ceiling guards against an algorithmic
    // regression (O(n³) or worse would be seconds) without flaking on slower CI.
    expect(elapsed).toBeLessThan(100);

    // Wholesale rewrite: the new side is sent in full (the agent needs it), but
    // the old side is peeked — so we still send far less than resending both.
    expect(d).toContain(`[+${next}+]`);
    expect(d).not.toContain(prev);
    expect(d.length).toBeLessThan(prev.length + next.length);
  });

  it("truncates long context to the window with an ellipsis and never resends the full body", () => {
    const block = "z".repeat(400);
    const out = renderEditDiff(
      `${block} old ${block}`,
      `${block} new ${block}`
    );
    expect(out).toContain("[-old-][+new+]");
    expect(out).toContain("…");
    expect(out).not.toContain(block);
    expect(out!.length).toBeLessThan(120);
  });

  it("peeks the old side but sends the new side in full on a wholesale rewrite", () => {
    const prev = "alpha ".repeat(80).trim(); // ~480 chars, every word...
    const next = "omega ".repeat(80).trim(); // ...replaced
    const out = renderEditDiff(prev, next);
    expect(out).toMatch(/^\[-.*-\]\[\+.*\+\]$/); // single before/after peek
    expect(out).toContain("…"); // old side truncated
    expect(out).not.toContain(prev); // old side is NOT sent in full
    expect(out).toContain(`[+${next}+]`); // new side sent whole — agent needs it
  });
});
