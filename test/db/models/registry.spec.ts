import { describe, it, expect } from "vitest";
import {
  upsertSlackChannel,
  getSlackChannelName,
  getSlackChannelIdByName
} from "@/db/models/channels";
import {
  upsertWorkspace,
  getWorkspace,
  getWorkspaceByAdminChannel,
  setWorkspaceAdminChannel
} from "@/db/models/workspaces";
import {
  upsertSlackUser,
  getSlackUser,
  markUserDeleted
} from "@/db/models/users";
import {
  addWorkspaceAdmin,
  removeWorkspaceAdmin,
  listWorkspaceAdminIds,
  getAdminWorkspaces
} from "@/db/models/workspace-admins";
import {
  getConfig,
  setConfig,
  unsetConfig,
  getAdminIconUrl,
  setAdminIconUrl,
  getAdminDisplayName,
  setAdminDisplayName,
  SystemConfigKeys
} from "@/db/models/workspace-configs";

// The small per-table registry suites, in one file: each pays a full D1 reset and
// migration replay per test, and a separate file for four assertions costs more in
// worker startup than the assertions cost to run. One `describe` per table, so a
// failure still names the table it came from.

describe("slack_channels", () => {
  it("inserts then updates the name by id (rename)", async () => {
    await upsertSlackChannel({ channelId: "C_up", name: "old-name" });
    await upsertSlackChannel({ channelId: "C_up", name: "new-name" });
    expect(await getSlackChannelName("C_up")).toBe("new-name");
  });

  it("resolves a channel id by name", async () => {
    await upsertSlackChannel({ channelId: "C_byname", name: "general" });
    expect(await getSlackChannelIdByName("general")).toBe("C_byname");
  });

  it("returns null for an unknown channel id", async () => {
    expect(await getSlackChannelName("C_nope")).toBeNull();
  });

  it("returns null for an unknown name", async () => {
    expect(await getSlackChannelIdByName("no-such-channel")).toBeNull();
  });
});

describe("workspaces", () => {
  it("upserts and reads back, including by admin channel", async () => {
    await upsertWorkspace({
      id: 10,
      name: "payments",
      adminChannelId: "C_PAY"
    });
    expect((await getWorkspace(10))?.name).toBe("payments");
    expect((await getWorkspaceByAdminChannel("C_PAY"))?.id).toBe(10);
  });

  it("upsert without an admin channel does not clobber an existing one", async () => {
    await upsertWorkspace({ id: 11, name: "ws", adminChannelId: "C_KEEP" });
    await upsertWorkspace({ id: 11, name: "ws-renamed" });
    const ws = await getWorkspace(11);
    expect(ws?.name).toBe("ws-renamed");
    expect(ws?.adminChannelId).toBe("C_KEEP");
  });

  it("sets the admin channel later", async () => {
    await upsertWorkspace({ id: 12, name: "later" });
    await setWorkspaceAdminChannel(12, "C_LATER");
    expect((await getWorkspace(12))?.adminChannelId).toBe("C_LATER");
  });
});

describe("slack_users", () => {
  it("inserts then updates by id (upsert)", async () => {
    await upsertSlackUser({ slackUserId: "U_up", displayName: "First" });
    await upsertSlackUser({ slackUserId: "U_up", displayName: "Second" });
    const u = await getSlackUser("U_up");
    expect(u?.displayName).toBe("Second");
  });

  it("does NOT clobber owner/admin flags on a membership-only upsert", async () => {
    await upsertSlackUser({
      slackUserId: "U_flags",
      isPrimaryOwner: true,
      isOrgAdmin: true
    });
    await upsertSlackUser({ slackUserId: "U_flags" });
    const u = await getSlackUser("U_flags");
    expect(u?.isPrimaryOwner).toBe(true);
    expect(u?.isOrgAdmin).toBe(true);
  });

  it("does NOT clobber a known display name with a null", async () => {
    await upsertSlackUser({ slackUserId: "U_name", displayName: "Known" });
    await upsertSlackUser({ slackUserId: "U_name", displayName: null });
    const u = await getSlackUser("U_name");
    expect(u?.displayName).toBe("Known");
  });

  it("marks a user deleted", async () => {
    await upsertSlackUser({ slackUserId: "U_del" });
    await markUserDeleted("U_del", true);
    expect((await getSlackUser("U_del"))?.deleted).toBe(true);
  });

  it("returns null for an unknown user", async () => {
    expect(await getSlackUser("U_nope")).toBeNull();
  });
});

describe("workspace_admins", () => {
  it("adds an admin idempotently and auto-stubs an unknown user", async () => {
    await upsertWorkspace({ id: 20, name: "w20" });
    await addWorkspaceAdmin(20, "U_admin");
    await addWorkspaceAdmin(20, "U_admin"); // duplicate → no error
    expect([...(await listWorkspaceAdminIds(20))]).toEqual(["U_admin"]);
    expect(await getSlackUser("U_admin")).not.toBeNull();
  });

  it("removing a missing admin row is a no-op", async () => {
    await upsertWorkspace({ id: 21, name: "w21" });
    await expect(removeWorkspaceAdmin(21, "U_ghost")).resolves.toBeUndefined();
  });

  it("add then remove clears the row", async () => {
    await upsertWorkspace({ id: 22, name: "w22" });
    await addWorkspaceAdmin(22, "U_x");
    await removeWorkspaceAdmin(22, "U_x");
    expect((await listWorkspaceAdminIds(22)).size).toBe(0);
  });

  it("does not remove a bootstrap-source admin via removeWorkspaceAdmin", async () => {
    await upsertWorkspace({ id: 23, name: "w23" });
    await addWorkspaceAdmin(23, "U_boot", "bootstrap");
    await removeWorkspaceAdmin(23, "U_boot"); // no-op: only removes membership rows
    expect((await listWorkspaceAdminIds(23)).size).toBe(1);
  });

  it("tracks a user that administers multiple workspaces", async () => {
    await upsertWorkspace({ id: 30, name: "a" });
    await upsertWorkspace({ id: 31, name: "b" });
    await addWorkspaceAdmin(30, "U_multi");
    await addWorkspaceAdmin(31, "U_multi");
    const ws = await getAdminWorkspaces("U_multi");
    expect(ws.sort()).toEqual([30, 31]);
  });
});

// Workspace 0 is seeded by migrations; we use a unique workspace for
// isolation between parallel test runs.
const WS_ID = 200;

describe("workspace_configs", () => {
  it("returns null for an absent key", async () => {
    await upsertWorkspace({ id: WS_ID, name: "cfgtest" });
    expect(await getConfig(WS_ID, "missing_key")).toBeNull();
  });

  it("sets a value and reads it back", async () => {
    await upsertWorkspace({ id: WS_ID, name: "cfgtest" });
    await setConfig(WS_ID, "my_key", "my_value");
    expect(await getConfig(WS_ID, "my_key")).toBe("my_value");
  });

  it("upserts (overwrites) an existing value", async () => {
    await upsertWorkspace({ id: WS_ID, name: "cfgtest" });
    await setConfig(WS_ID, "over_key", "v1");
    await setConfig(WS_ID, "over_key", "v2");
    expect(await getConfig(WS_ID, "over_key")).toBe("v2");
  });

  it("unsets a key (row deleted, get returns null)", async () => {
    await upsertWorkspace({ id: WS_ID, name: "cfgtest" });
    await setConfig(WS_ID, "del_key", "delete_me");
    await unsetConfig(WS_ID, "del_key");
    expect(await getConfig(WS_ID, "del_key")).toBeNull();
  });

  it("unset is a no-op when the key is absent", async () => {
    await upsertWorkspace({ id: WS_ID, name: "cfgtest" });
    await expect(unsetConfig(WS_ID, "never_set")).resolves.toBeUndefined();
  });

  it("different workspaces hold independent values for the same key", async () => {
    await upsertWorkspace({ id: 201, name: "cfgtest_a" });
    await upsertWorkspace({ id: 202, name: "cfgtest_b" });
    await setConfig(201, "shared_key", "ws201_value");
    await setConfig(202, "shared_key", "ws202_value");
    expect(await getConfig(201, "shared_key")).toBe("ws201_value");
    expect(await getConfig(202, "shared_key")).toBe("ws202_value");
  });

  it("SystemConfigKeys.SLACK_TEAM_ID is the reserved system key", () => {
    expect(SystemConfigKeys.SLACK_TEAM_ID).toBe("slack_team_id");
  });

  it("admin icon URL is workspace-scoped (null when unset, round-trips per ws)", async () => {
    await upsertWorkspace({ id: 203, name: "iconcfg_a" });
    await upsertWorkspace({ id: 204, name: "iconcfg_b" });
    expect(await getAdminIconUrl(203)).toBeNull();

    await setAdminIconUrl(203, "https://gw.example.com/icons/203/admin/a.jpg");
    await setAdminIconUrl(204, "https://gw.example.com/icons/204/admin/b.jpg");
    expect(await getAdminIconUrl(203)).toBe(
      "https://gw.example.com/icons/203/admin/a.jpg"
    );
    expect(await getAdminIconUrl(204)).toBe(
      "https://gw.example.com/icons/204/admin/b.jpg"
    );
  });

  it("admin display name is workspace-scoped (null when unset, round-trips per ws)", async () => {
    await upsertWorkspace({ id: 205, name: "namecfg_a" });
    await upsertWorkspace({ id: 206, name: "namecfg_b" });
    expect(await getAdminDisplayName(205)).toBeNull();

    await setAdminDisplayName(205, "Ops Bot");
    await setAdminDisplayName(206, "Support Bot");
    expect(await getAdminDisplayName(205)).toBe("Ops Bot");
    expect(await getAdminDisplayName(206)).toBe("Support Bot");
  });
});
