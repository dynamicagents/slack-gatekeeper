import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { resolveTargets } from "@/router/resolve";
import {
  setWorkspaceAdminChannel,
  upsertWorkspace
} from "@/db/models/workspaces";
import {
  setAdminIconUrl,
  setAdminDisplayName
} from "@/db/models/workspace-configs";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

const names = (ts: Awaited<ReturnType<typeof resolveTargets>>) =>
  ts.map((t) => t.agent.name).sort();

beforeEach(async () => {
  // Org (ws 0) admin channel + a second workspace.
  await setWorkspaceAdminChannel(0, "C_ORGADMIN");
  await upsertWorkspace({
    id: 1,
    name: "ws1",
    adminChannelId: "C_WS1ADMIN"
  });

  // Custom agents: weather is mention-only, sales is a channel_messages co-worker.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agents (name, kind, enabled, workspace_id, a2a_endpoint, tenant_id, notify_on) VALUES ('weather','remote',1,0,'https://example.com/weather','main','mention')"
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agents (name, kind, enabled, workspace_id, a2a_endpoint, tenant_id, notify_on) VALUES ('sales','remote',1,0,'https://example.com/sales','main','channel_messages')"
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agents (name, kind, enabled, workspace_id, a2a_endpoint, tenant_id, notify_on) VALUES ('off','remote',0,0,'https://example.com/off','main','channel_messages')"
  ).run();

  // C_WEATHER → weather (mention) only. C_MULTI → weather + sales.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C_WEATHER','weather')"
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C_MULTI','weather')"
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C_MULTI','sales')"
  ).run();
});

describe("resolveTargets — built-in context routing", () => {
  it("admin channel always includes the admin agent (workspace 0)", async () => {
    const t = await resolveTargets({ channelId: "C_ORGADMIN", text: "hi" });
    expect(t.map((x) => x.agent.name)).toContain("admin");
    expect(t.find((x) => x.agent.name === "admin")?.workspaceId).toBe(0);
  });

  it("scopes the admin agent to the channel's workspace", async () => {
    const t = await resolveTargets({ channelId: "C_WS1ADMIN", text: "hi" });
    expect(t.find((x) => x.agent.name === "admin")?.workspaceId).toBe(1);
  });

  // Routing resolves WHICH agent runs, not how it renders — the admin's
  // per-workspace avatar/display name are layered on at delivery time by
  // `agentRenderIdentity` (see test/db/models/agents.spec.ts).
  it("returns the shared admin row unmodified by the workspace's overrides", async () => {
    await setAdminIconUrl(1, "https://gw.example.com/icons/1/admin/abc.jpg");
    await setAdminDisplayName(1, "Ops Bot");
    const t = await resolveTargets({ channelId: "C_WS1ADMIN", text: "hi" });
    const admin = t.find((x) => x.agent.name === "admin");
    expect(admin?.agent.iconUrl ?? null).toBeNull();
    expect(admin?.agent.displayName).toBe("Admin Agent");
  });

  it("a DM always includes onboarding (DM is an implicit mention)", async () => {
    const t = await resolveTargets({ channelId: "D999", text: "hello" });
    expect(names(t)).toEqual(["onboarding"]);
  });
});

describe("resolveTargets — fan-out (mention vs channel_messages)", () => {
  it("channel_messages agents are always included; mention agents are not", async () => {
    const t = await resolveTargets({ channelId: "C_MULTI", text: "help" });
    expect(names(t)).toEqual(["sales"]); // weather is mention-only, not named
  });

  it("a named mention agent is added alongside proactive agents", async () => {
    const t = await resolveTargets({
      channelId: "C_MULTI",
      text: "weather forecast"
    });
    expect(names(t)).toEqual(["sales", "weather"]);
  });

  it("mention-only agent stays silent without a mention", async () => {
    const t = await resolveTargets({
      channelId: "C_WEATHER",
      text: "forecast"
    });
    expect(t).toHaveLength(0);
  });

  it("mention-only agent fires when named", async () => {
    const t = await resolveTargets({
      channelId: "C_WEATHER",
      text: "weather what is the forecast?"
    });
    expect(names(t)).toEqual(["weather"]);
  });

  it("returns empty for an unconfigured channel", async () => {
    const t = await resolveTargets({ channelId: "C_NOWHERE", text: "?" });
    expect(t).toHaveLength(0);
  });

  it("disabled agents are excluded even when channel_messages", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C_OFF','off')"
    ).run();
    const t = await resolveTargets({ channelId: "C_OFF", text: "hi" });
    expect(t).toHaveLength(0);
  });

  it("matches a mention agent by display name", async () => {
    await env.DB.prepare(
      "UPDATE agents SET display_name = 'Forecast Service' WHERE name = 'weather'"
    ).run();
    const t = await resolveTargets({
      channelId: "C_MULTI",
      text: "Forecast Service what's up"
    });
    expect(names(t)).toEqual(["sales", "weather"]);
  });
});
