import { describe, it, expect } from "vitest";
import {
  adminIdentity,
  adminWorkspaceOf,
  isBuiltinIdentity,
  onboardingChannelOf,
  onboardingIdentity
} from "@/agents/identity";

// The identity the gatekeeper mints for a built-in is what core names the
// tenant's objects by, and `isBuiltinIdentity` is what keeps a remote agent's
// token — valid, signed by this same gatekeeper — out of the built-in tenants.

describe("the built-in identities", () => {
  it("names the admin by its workspace and onboarding by its DM channel", () => {
    expect(adminIdentity(7)).toEqual({
      key: "admin:7",
      name: "admin",
      kind: "local",
      workspaceId: 7
    });
    expect(onboardingIdentity("D123", 0)).toEqual({
      key: "onboarding:D123",
      name: "onboarding",
      kind: "local",
      workspaceId: 0
    });
  });

  it("reads each key back, and nothing else", () => {
    expect(adminWorkspaceOf("admin:7")).toBe(7);
    expect(adminWorkspaceOf("admin:0")).toBe(0);
    expect(onboardingChannelOf("onboarding:D123")).toBe("D123");

    for (const key of [
      undefined,
      "",
      "admin:",
      "admin:7:admin",
      "admin:x",
      "remote:7:admin",
      "onboarding:D123"
    ]) {
      expect(adminWorkspaceOf(key)).toBeNull();
    }
    for (const key of [
      undefined,
      "onboarding:",
      "onboarding:U123",
      "onboarding:D_1",
      "onboarding:d123",
      "admin:7"
    ]) {
      expect(onboardingChannelOf(key)).toBeNull();
    }
  });
});

describe("isBuiltinIdentity", () => {
  it("accepts the identity minted for that tenant", () => {
    expect(isBuiltinIdentity("admin", adminIdentity(3))).toBe(true);
    expect(isBuiltinIdentity("onboarding", onboardingIdentity("D9", 0))).toBe(
      true
    );
  });

  it("refuses a remote agent's identity, even one keyed like a built-in", () => {
    // What a remote row registered against this origin with tenant `admin`
    // would carry: a real gatekeeper token, but `kind: "remote"`.
    expect(
      isBuiltinIdentity("admin", { ...adminIdentity(3), kind: "remote" })
    ).toBe(false);
    expect(
      isBuiltinIdentity("admin", {
        key: "remote:3:evil",
        name: "evil",
        kind: "remote",
        workspaceId: 3
      })
    ).toBe(false);
  });

  it("refuses one tenant's identity on the other", () => {
    expect(isBuiltinIdentity("onboarding", adminIdentity(3))).toBe(false);
    expect(isBuiltinIdentity("admin", onboardingIdentity("D9", 0))).toBe(false);
  });

  it("refuses a missing or malformed key, and a missing kind", () => {
    expect(isBuiltinIdentity("admin", { kind: "local" })).toBe(false);
    expect(isBuiltinIdentity("admin", { kind: "local", key: "admin:" })).toBe(
      false
    );
    expect(isBuiltinIdentity("admin", { key: "admin:3" })).toBe(false);
    expect(isBuiltinIdentity("admin", {})).toBe(false);
  });
});
