import { describe, it, expect } from "vitest";
import { buildUserAuthContext } from "@/auth/build";
import { authorize } from "@/auth/authorize";
import { upsertSlackUser } from "@/db/models/users";
import { upsertWorkspace } from "@/db/models/workspaces";
import { addWorkspaceAdmin } from "@/db/models/workspace-admins";
import { makeAuthCtx } from "../helpers/workspace";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

// Building a caller's permissions from D1, and checking a requirement against
// them — the two halves of one decision, so they share a file.

describe("buildUserAuthContext", () => {
  it("returns a zero-permission context for an unknown user", async () => {
    const c = await buildUserAuthContext("U_unknown");
    expect(c).toEqual({
      slackUserId: "U_unknown",
      displayName: null,
      isPrimaryOwner: false,
      isOrgAdmin: false,
      adminWorkspaces: []
    });
  });

  it("assembles flags + derived adminWorkspaces from D1", async () => {
    await upsertWorkspace({ id: 40, name: "w40" });
    await upsertWorkspace({ id: 41, name: "w41" });
    await upsertSlackUser({
      slackUserId: "U_ctx",
      displayName: "Ctx User",
      isOrgAdmin: true
    });
    await addWorkspaceAdmin(40, "U_ctx");
    await addWorkspaceAdmin(41, "U_ctx");

    const c = await buildUserAuthContext("U_ctx");
    expect(c.displayName).toBe("Ctx User");
    expect(c.isOrgAdmin).toBe(true);
    expect(c.isPrimaryOwner).toBe(false);
    expect(c.adminWorkspaces.sort()).toEqual([40, 41]);
  });
});

const owner = makeAuthCtx({ isPrimaryOwner: true });
const orgAdmin = makeAuthCtx({ isOrgAdmin: true });
const wsAdmin5 = makeAuthCtx({ adminWorkspaces: [5] });
const none = makeAuthCtx();

describe("authorize — truth table", () => {
  it("IsPrimaryOwner: only the owner", () => {
    const req = { type: "IsPrimaryOwner" } as const;
    expect(authorize(owner, req)).toBe(true);
    expect(authorize(orgAdmin, req)).toBe(false);
    expect(authorize(wsAdmin5, req)).toBe(false);
    expect(authorize(none, req)).toBe(false);
  });

  it("IsOrgAdmin: org admin OR owner (owner implies)", () => {
    const req = { type: "IsOrgAdmin" } as const;
    expect(authorize(owner, req)).toBe(true);
    expect(authorize(orgAdmin, req)).toBe(true);
    expect(authorize(wsAdmin5, req)).toBe(false);
    expect(authorize(none, req)).toBe(false);
  });

  it("IsWorkspaceAdmin(5): ws-admin of 5, or any org-level role", () => {
    const req = { type: "IsWorkspaceAdmin", workspaceId: 5 } as const;
    expect(authorize(owner, req)).toBe(true);
    expect(authorize(orgAdmin, req)).toBe(true);
    expect(authorize(wsAdmin5, req)).toBe(true);
    expect(authorize(none, req)).toBe(false);
  });

  it("IsWorkspaceAdmin: rejects a different workspace id", () => {
    expect(
      authorize(wsAdmin5, { type: "IsWorkspaceAdmin", workspaceId: 9 })
    ).toBe(false);
  });

  it("array form is OR across requirements", () => {
    const reqs = [
      { type: "IsPrimaryOwner" },
      { type: "IsWorkspaceAdmin", workspaceId: 5 }
    ] as const;
    expect(authorize(wsAdmin5, [...reqs])).toBe(true);
    expect(authorize(none, [...reqs])).toBe(false);
  });

  it("an empty requirement list denies", () => {
    expect(authorize(owner, [])).toBe(false);
  });
});
