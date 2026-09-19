import { describe, it, expect } from "vitest";
import {
  DYNAMIC_AGENTS_CONSTITUTION,
  callerContext
} from "@/agents/shared/prompt";
import type { UserAuthContext } from "@/auth";

// Inline rather than `helpers/workspace`: that helper can reach D1, which would
// oblige this spec to replay the migrations before every test for a value that
// is a plain object literal. `callerContext` is pure.
const baseCtx: UserAuthContext = {
  slackUserId: "U123",
  displayName: "Alice",
  isPrimaryOwner: false,
  isOrgAdmin: false,
  adminWorkspaces: []
};

describe("DYNAMIC_AGENTS_CONSTITUTION", () => {
  it("states the identity and the channel every agent inherits", () => {
    expect(DYNAMIC_AGENTS_CONSTITUTION.length).toBeGreaterThan(0);
    const text = DYNAMIC_AGENTS_CONSTITUTION.join(" ");
    expect(text).toContain("Dynamic Agents");
    expect(text).toContain("Slack");
  });
});

describe("callerContext", () => {
  it("refuses writes for an unauthenticated caller", () => {
    const out = callerContext(null);
    expect(out).toContain("unknown");
    expect(out).toMatch(/refuse any write operation/i);
  });

  it("names the caller by displayName, alongside the slack user id", () => {
    const out = callerContext({ ...baseCtx, displayName: "Bob" });
    expect(out).toContain("Bob");
    expect(out).toContain("U123");
  });

  it("falls back to the slack user id when displayName is null", () => {
    const out = callerContext({ ...baseCtx, displayName: null });
    expect(out).toContain("U123");
  });

  it("lists every role the caller holds, with the admined workspace ids", () => {
    const out = callerContext({
      ...baseCtx,
      isPrimaryOwner: true,
      isOrgAdmin: true,
      adminWorkspaces: [42, 7]
    });
    expect(out).toContain("primary-owner");
    expect(out).toContain("org-admin");
    expect(out).toContain("workspace-admin");
    expect(out).toContain("42");
    expect(out).toContain("7");
  });

  it("says so explicitly when the caller holds no role at all", () => {
    expect(callerContext(baseCtx)).toContain("member (no admin rights)");
  });

  it("carries the active workspace only when one is supplied", () => {
    expect(callerContext(baseCtx, { workspaceId: 7 })).toContain(
      "Active workspace context: 7."
    );
    expect(callerContext(baseCtx)).not.toContain("Active workspace context");
  });
});
