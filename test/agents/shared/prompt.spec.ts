import { describe, it, expect } from "vitest";
import {
  DYNAMIC_AGENTS_CONSTITUTION,
  callerContext
} from "@/agents/shared/prompt";
import { makeAuthCtx } from "../../helpers/workspace";

const baseCtx = makeAuthCtx({ slackUserId: "U123", displayName: "Alice" });

describe("DYNAMIC_AGENTS_CONSTITUTION", () => {
  it("is an array of exactly 4 strings", () => {
    expect(Array.isArray(DYNAMIC_AGENTS_CONSTITUTION)).toBe(true);
    expect(DYNAMIC_AGENTS_CONSTITUTION).toHaveLength(4);
    DYNAMIC_AGENTS_CONSTITUTION.forEach((line) =>
      expect(typeof line).toBe("string")
    );
  });

  it("opens with the Dynamic Agents identity line", () => {
    expect(DYNAMIC_AGENTS_CONSTITUTION[0]).toContain("Dynamic Agents");
  });

  it("references Slack as the interaction channel", () => {
    expect(DYNAMIC_AGENTS_CONSTITUTION.join(" ")).toContain("Slack");
  });
});

describe("callerContext", () => {
  it("returns an unknown-caller refusal when ctx is null", () => {
    const out = callerContext(null);
    expect(out).toContain("unknown");
    expect(out).toMatch(/refuse any write operation/i);
  });

  it("uses displayName when present", () => {
    const out = callerContext({ ...baseCtx, displayName: "Bob" });
    expect(out).toContain("Bob");
  });

  it("falls back to slackUserId when displayName is null", () => {
    const out = callerContext({ ...baseCtx, displayName: null });
    expect(out).toContain("U123");
  });

  it("includes slackUserId in parentheses regardless of displayName", () => {
    const out = callerContext({ ...baseCtx, displayName: "Bob" });
    expect(out).toContain("(U123)");
  });

  it("lists primary-owner role when isPrimaryOwner is true", () => {
    const out = callerContext({ ...baseCtx, isPrimaryOwner: true });
    expect(out).toContain("primary-owner");
  });

  it("lists org-admin role when isOrgAdmin is true", () => {
    const out = callerContext({ ...baseCtx, isOrgAdmin: true });
    expect(out).toContain("org-admin");
  });

  it("lists workspace-admin role with workspace ids when adminWorkspaces is non-empty", () => {
    const out = callerContext({ ...baseCtx, adminWorkspaces: [42, 7] });
    expect(out).toContain("workspace-admin");
    expect(out).toContain("42");
    expect(out).toContain("7");
  });

  it("shows 'member (no admin rights)' when the caller has no roles", () => {
    const out = callerContext(baseCtx);
    expect(out).toContain("member (no admin rights)");
  });

  it("lists all roles when all flags are set", () => {
    const out = callerContext({
      slackUserId: "U1",
      displayName: "Super",
      isPrimaryOwner: true,
      isOrgAdmin: true,
      adminWorkspaces: [1]
    });
    expect(out).toContain("primary-owner");
    expect(out).toContain("org-admin");
    expect(out).toContain("workspace-admin");
  });

  it("includes the workspace context line when opts.workspaceId is provided", () => {
    const out = callerContext(baseCtx, { workspaceId: 7 });
    expect(out).toContain("Active workspace context: 7.");
  });

  it("omits the workspace context line when opts.workspaceId is not provided", () => {
    const out = callerContext(baseCtx);
    expect(out).not.toContain("Active workspace context");
  });

  it("omits the workspace context line when opts is an empty object", () => {
    const out = callerContext(baseCtx, {});
    expect(out).not.toContain("Active workspace context");
  });

  it("output starts with a double newline separator", () => {
    const out = callerContext(baseCtx);
    expect(out.startsWith("\n\n")).toBe(true);
  });
});
