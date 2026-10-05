import { describe, it, expect } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { compactionSummarizer } from "@/agents/shared/session";

describe("compactionSummarizer", () => {
  // The guard for the summarizer's telemetry opt-out. With telemetry on, a
  // rejecting `generateText` leaves an unhandled duplicate on workerd: this test
  // still passes, but the run fails on the unhandled rejection. That failure is
  // the regression signal.
  it("rejects with the model's error and leaves no unhandled duplicate", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("summary model down");
      }
    });

    await expect(compactionSummarizer(model)("summarize this")).rejects.toThrow(
      "summary model down"
    );
  });
});
