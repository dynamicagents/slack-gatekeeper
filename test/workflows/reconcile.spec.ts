import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { stubSlack } from "../wrappers/slack-stub";
import {
  anchorTeamId,
  syncChannels,
  resolveOrgChannel,
  syncUsers,
  syncAdminMemberships
} from "@/workflows/reconcile";
import { getSlackUser, upsertSlackUser } from "@/db/models/users";
import { getSlackChannelName, upsertSlackChannel } from "@/db/models/channels";
import { upsertWorkspace, ORG_WORKSPACE_ID } from "@/db/models/workspaces";
import {
  addWorkspaceAdmin,
  listWorkspaceAdminIds
} from "@/db/models/workspace-admins";
import {
  getConfig,
  setConfig,
  SystemConfigKeys
} from "@/db/models/workspace-configs";
import { _resetBotInfoCacheForTest } from "@/wrappers/slack";

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// anchorTeamId
// ---------------------------------------------------------------------------

describe("anchorTeamId", () => {
  beforeEach(() => {
    // D1 is reset before each test (apply-migrations.ts); only the
    // isolate-level bot-info cache needs manual clearing.
    _resetBotInfoCacheForTest();
  });

  const baseStub = (method: string) => {
    if (method === "users.list") return { ok: true, members: [] };
    if (method === "conversations.list") return { ok: true, channels: [] };
    return { ok: true };
  };

  it("pins the team_id on the first run", async () => {
    stubSlack((method) => {
      if (method === "auth.test")
        return { ok: true, user_id: "UBOT", team_id: "T_FIRST" };
      return baseStub(method);
    });
    const r = await anchorTeamId();
    expect(r.teamIdBootstrapped).toBe(true);
    expect(r.drifted).toBe(false);
    expect(
      await getConfig(ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID)
    ).toBe("T_FIRST");
  });

  it("is a no-op on a subsequent call with the same team_id", async () => {
    await setConfig(
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID,
      "T_STABLE"
    );
    stubSlack((method) => {
      if (method === "auth.test")
        return { ok: true, user_id: "UBOT", team_id: "T_STABLE" };
      return baseStub(method);
    });
    const r = await anchorTeamId();
    expect(r.teamIdBootstrapped).toBe(false);
    expect(r.drifted).toBe(false);
    expect(
      await getConfig(ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID)
    ).toBe("T_STABLE");
  });

  it("reports drift and does NOT overwrite the anchor on mismatch", async () => {
    await setConfig(
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID,
      "T_ORIGINAL"
    );
    const calledMethods: string[] = [];
    stubSlack((method) => {
      calledMethods.push(method);
      if (method === "auth.test")
        return { ok: true, user_id: "UBOT", team_id: "T_DRIFTED" };
      return { ok: true, members: [], channels: [] };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await anchorTeamId();
    expect(r.drifted).toBe(true);
    expect(r.teamIdBootstrapped).toBe(false);
    // Anchor is preserved — never overwritten
    expect(
      await getConfig(ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID)
    ).toBe("T_ORIGINAL");
    // anchorTeamId only calls auth.test — no further Slack calls
    expect(calledMethods.filter((m) => m !== "auth.test")).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("drifted to a different Slack workspace"),
      expect.objectContaining({ pinned: "T_ORIGINAL", liveTeamId: "T_DRIFTED" })
    );
    errorSpy.mockRestore();
  });

  it("skips pinning when auth.test returns no team_id", async () => {
    stubSlack((method) => {
      if (method === "auth.test") return { ok: true, user_id: "UBOT" };
      return baseStub(method);
    });
    const r = await anchorTeamId();
    expect(r.teamIdBootstrapped).toBe(false);
    expect(r.drifted).toBe(false);
    expect(
      await getConfig(ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID)
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syncChannels
// ---------------------------------------------------------------------------

describe("syncChannels", () => {
  it("upserts every named channel from conversations.list", async () => {
    stubSlack((method, body) => {
      if (method !== "conversations.list") return { ok: true };
      return body.get("cursor")
        ? { ok: true, channels: [{ id: "C2", name: "random" }] }
        : {
            ok: true,
            channels: [{ id: "C1", name: "general" }],
            response_metadata: { next_cursor: "c2" }
          };
    });
    const r = await syncChannels();
    expect(r.channelsUpserted).toBe(2);
    expect(await getSlackChannelName("C1")).toBe("general");
    expect(await getSlackChannelName("C2")).toBe("random");
  });

  it("refreshes the name on a rename", async () => {
    await upsertSlackChannel({ channelId: "C_re", name: "old" });
    stubSlack((method) =>
      method === "conversations.list"
        ? { ok: true, channels: [{ id: "C_re", name: "new" }] }
        : { ok: true }
    );
    await syncChannels();
    expect(await getSlackChannelName("C_re")).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// resolveOrgChannel (reads from the D1 channel registry)
// ---------------------------------------------------------------------------

describe("resolveOrgChannel", () => {
  it("returns null when da-org-admin channel is absent", async () => {
    const result = await resolveOrgChannel();
    expect(result.channelId).toBeNull();
  });

  it("returns the channel id when present in D1", async () => {
    await upsertSlackChannel({
      channelId: "CORG",
      name: "da-org-admin"
    });
    const result = await resolveOrgChannel();
    expect(result.channelId).toBe("CORG");
  });
});

// ---------------------------------------------------------------------------
// syncUsers
// ---------------------------------------------------------------------------

describe("syncUsers", () => {
  it("syncs display names and isPrimaryOwner from users.list", async () => {
    stubSlack((method) => {
      if (method === "users.list")
        return {
          ok: true,
          members: [
            {
              id: "U1",
              profile: { real_name: "One" },
              is_primary_owner: true
            },
            { id: "U2", name: "two" }
          ]
        };
      return { ok: true };
    });
    const r = await syncUsers(null);
    expect((await getSlackUser("U1"))?.isPrimaryOwner).toBe(true);
    expect((await getSlackUser("U1"))?.displayName).toBe("One");
    expect((await getSlackUser("U2"))?.isPrimaryOwner).toBe(false);
    expect(r.usersUpserted).toBe(2);
  });

  it("sets isOrgAdmin from the supplied org-admin channel, not workspace flags", async () => {
    stubSlack((method, body) => {
      if (method === "users.list")
        return {
          ok: true,
          members: [
            // U1: Slack workspace admin but NOT in org-admin channel
            { id: "U1", is_admin: true },
            // U2: no Slack admin flags but IS in org-admin channel
            { id: "U2" }
          ]
        };
      if (method === "conversations.members")
        return body.get("channel") === "CORG"
          ? { ok: true, members: ["U2"] }
          : { ok: true, members: [] };
      return { ok: true };
    });
    await syncUsers("CORG");
    expect((await getSlackUser("U1"))?.isOrgAdmin).toBe(false);
    expect((await getSlackUser("U2"))?.isOrgAdmin).toBe(true);
  });

  it("marks a registry user absent from users.list as deleted", async () => {
    await upsertSlackUser({ slackUserId: "U_gone_recon" });
    stubSlack((method) => {
      if (method === "users.list")
        return { ok: true, members: [{ id: "U_present" }] };
      return { ok: true };
    });
    const r = await syncUsers(null);
    expect((await getSlackUser("U_gone_recon"))?.deleted).toBe(true);
    expect(r.usersDeactivated).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent on a second run", async () => {
    stubSlack((method, body) => {
      if (method === "users.list") return { ok: true, members: [{ id: "U1" }] };
      if (method === "conversations.members")
        return body.get("channel") === "CORG"
          ? { ok: true, members: ["U1"] }
          : { ok: true, members: [] };
      return { ok: true };
    });
    await syncUsers("CORG");
    const r2 = await syncUsers("CORG");
    expect(r2.usersDeactivated).toBe(0);
    expect(r2.usersUpserted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// syncAdminMemberships
// ---------------------------------------------------------------------------

describe("syncAdminMemberships", () => {
  it("adds desired members and removes stale ones (bot excluded)", async () => {
    await upsertWorkspace({ id: 60, name: "w60", adminChannelId: "C60" });
    await addWorkspaceAdmin(60, "U_stale");
    stubSlack((method, body) => {
      if (method === "auth.test") return { ok: true, user_id: "UBOT" };
      if (method === "conversations.members")
        return body.get("channel") === "C60"
          ? { ok: true, members: ["U_keep", "U_new", "UBOT"] }
          : { ok: true, members: [] };
      return { ok: true };
    });
    const r = await syncAdminMemberships();
    expect([...(await listWorkspaceAdminIds(60))].sort()).toEqual([
      "U_keep",
      "U_new"
    ]);
    expect(r.adminsAdded).toBe(2);
    expect(r.adminsRemoved).toBe(1);
  });

  it("is idempotent on a second run", async () => {
    await upsertWorkspace({ id: 62, name: "w62", adminChannelId: "C62" });
    stubSlack((method, body) => {
      if (method === "auth.test") return { ok: true, user_id: "UBOT" };
      if (method === "conversations.members")
        return body.get("channel") === "C62"
          ? { ok: true, members: ["U1"] }
          : { ok: true, members: [] };
      return { ok: true };
    });
    await syncAdminMemberships();
    const r2 = await syncAdminMemberships();
    expect(r2.adminsAdded).toBe(0);
    expect(r2.adminsRemoved).toBe(0);
  });

  it("skips workspaces with no admin channel configured", async () => {
    await upsertWorkspace({ id: 63, name: "w63" });
    stubSlack((method) => {
      if (method === "auth.test") return { ok: true, user_id: "UBOT" };
      return { ok: true };
    });
    const r = await syncAdminMemberships();
    expect(r.adminsAdded).toBe(0);
    expect(r.adminsRemoved).toBe(0);
  });
});
