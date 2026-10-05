import { describe, it, expect } from "vitest";
import { buildUserAuthContext } from "@/auth/authorize";
import { upsertSlackUser } from "@/db/models/users";
import { upsertWorkspace } from "@/db/models/workspaces";
import { addWorkspaceAdmin } from "@/db/models/workspace-admins";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

// Building a caller's standing from D1.

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
