import { describe, it, expect } from "vitest";
import {
  handleTeamJoin,
  handleMemberJoined,
  handleMemberLeft
} from "@/workflows/lifecycle";
import { getSlackUser } from "@/db/models/users";
import { upsertWorkspace } from "@/db/models/workspaces";
import { listWorkspaceAdminIds } from "@/db/models/workspace-admins";
import type { LifecycleWorkflowParams } from "@/slack/types";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

const BOT = "UBOT";

function params(
  overrides: Partial<LifecycleWorkflowParams> & { type: string }
): LifecycleWorkflowParams {
  return { eventId: "ev", raw: {}, ...overrides };
}

describe("handleTeamJoin", () => {
  it("registers the new user with a display name from the envelope", async () => {
    await handleTeamJoin(
      params({
        type: "team_join",
        userId: "U_new",
        displayName: "New Bie"
      })
    );
    const u = await getSlackUser("U_new");
    expect(u?.displayName).toBe("New Bie");
    expect(u?.isPrimaryOwner).toBe(false);
    expect(u?.isOrgAdmin).toBe(false);
  });

  it("ignores a team_join with no user id", async () => {
    await expect(
      handleTeamJoin(params({ type: "team_join" }))
    ).resolves.toBeUndefined();
  });
});

describe("handleMemberJoined", () => {
  it("makes a member of an admin channel a workspace admin", async () => {
    await upsertWorkspace({
      id: 50,
      name: "w50",
      adminChannelId: "C_ADM50"
    });
    await handleMemberJoined(
      params({
        type: "member_joined_channel",
        userId: "U_join",
        channelId: "C_ADM50"
      }),
      BOT
    );
    expect((await listWorkspaceAdminIds(50)).has("U_join")).toBe(true);
  });

  it("ignores joins to a non-admin channel", async () => {
    await handleMemberJoined(
      params({
        type: "member_joined_channel",
        userId: "U_reg",
        channelId: "C_REGULAR"
      }),
      BOT
    );
    expect(await getSlackUser("U_reg")).toBeNull();
  });

  it("ignores the bot's own join to an admin channel", async () => {
    await upsertWorkspace({
      id: 51,
      name: "w51",
      adminChannelId: "C_ADM51"
    });
    await handleMemberJoined(
      params({
        type: "member_joined_channel",
        userId: BOT,
        channelId: "C_ADM51"
      }),
      BOT
    );
    expect((await listWorkspaceAdminIds(51)).size).toBe(0);
  });

  it("is idempotent on replay", async () => {
    await upsertWorkspace({
      id: 52,
      name: "w52",
      adminChannelId: "C_ADM52"
    });
    const p = params({
      type: "member_joined_channel",
      userId: "U_rep",
      channelId: "C_ADM52"
    });
    await handleMemberJoined(p, BOT);
    await handleMemberJoined(p, BOT);
    expect([...(await listWorkspaceAdminIds(52))]).toEqual(["U_rep"]);
  });
});

describe("handleMemberLeft", () => {
  it("removes the workspace admin when they leave the admin channel", async () => {
    await upsertWorkspace({
      id: 53,
      name: "w53",
      adminChannelId: "C_ADM53"
    });
    const join = params({
      type: "member_joined_channel",
      userId: "U_gone",
      channelId: "C_ADM53"
    });
    await handleMemberJoined(join, BOT);
    await handleMemberLeft(
      params({
        type: "member_left_channel",
        userId: "U_gone",
        channelId: "C_ADM53"
      }),
      BOT
    );
    expect((await listWorkspaceAdminIds(53)).size).toBe(0);
  });

  it("leaving a non-admin channel is a no-op", async () => {
    await expect(
      handleMemberLeft(
        params({
          type: "member_left_channel",
          userId: "U_any",
          channelId: "C_REG2"
        }),
        BOT
      )
    ).resolves.toBeUndefined();
  });
});
