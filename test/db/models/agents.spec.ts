import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  getAgent,
  listAgents,
  getAgentsForChannel,
  getAgentInChannel,
  agentRenderIdentity,
  registerAgent,
  updateAgent
} from "@/db/models/agents";
import { upsertWorkspace } from "@/db/models/workspaces";
import {
  getAdminDisplayName,
  setAdminDisplayName,
  setAdminIconUrl
} from "@/db/models/workspace-configs";
import { DEFAULT_TASK_DEADLINE_SECONDS } from "@/config";
import { useStorageReset } from "../../helpers/storage";

useStorageReset();

describe("agents", () => {
  it("migration seed: admin and onboarding agents exist", async () => {
    const admin = await getAgent("admin");
    // `kind` says only where an agent runs; `tenantId` says which one it is.
    // Both built-ins are `local`, and the seed spec below pins the tenants.
    expect(admin?.kind).toBe("local");
    expect(admin?.displayName).toBe("Admin Agent");
    expect(admin?.enabled).toBe(true);
    expect(admin?.workspaceId).toBe(0);

    const onboarding = await getAgent("onboarding");
    expect(onboarding?.kind).toBe("local");
    expect(onboarding?.displayName).toBe("Onboarding Agent");
  });

  it("backfills built-in tenant ids rather than leaving them empty", async () => {
    // The seed predates the column (0001 vs 0019), so these come from the
    // migration's backfill. They are what `localNamespaceFor` switches on, so
    // an empty or wrong tenant here stops built-in dispatch resolving at all.
    expect((await getAgent("admin"))?.tenantId).toBe("admin");
    expect((await getAgent("onboarding"))?.tenantId).toBe("onboarding");
  });

  it("refuses a row with no tenant, and one with an empty tenant", async () => {
    // `NOT NULL` with no default, plus a CHECK — "required" is the database's
    // rule rather than every insert remembering. Without the CHECK, `''` would
    // satisfy NOT NULL and become the sentinel this column exists to avoid.
    // Every other required column is supplied, so the rejection can only be
    // about the tenant this test is named for.
    await expect(
      env.DB.prepare(
        "INSERT INTO agents (name, kind, enabled, notify_on, a2a_endpoint, task_deadline_seconds, workspace_id) VALUES ('no-tenant', 'remote', 1, 'mention', 'https://example.com/x', 3600, 0)"
      ).run()
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        "INSERT INTO agents (name, kind, enabled, notify_on, a2a_endpoint, tenant_id, task_deadline_seconds, workspace_id) VALUES ('empty-tenant', 'remote', 1, 'mention', 'https://example.com/x', '', 3600, 0)"
      ).run()
    ).rejects.toThrow();
  });

  it("listAgents returns at least the two seeded agents", async () => {
    const agents = await listAgents();
    const names = agents.map((a) => a.name);
    expect(names).toContain("admin");
    expect(names).toContain("onboarding");
  });

  it("resolves an agent for a mapped channel", async () => {
    // Insert a custom agent directly, then map it to a channel.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agents (name, kind, enabled, notify_on, a2a_endpoint, tenant_id, task_deadline_seconds, workspace_id) VALUES ('custom-x', 'remote', 1, 'mention', 'https://example.com/custom-x', 'main', 3600, 0)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO agent_channels (channel_id, agent_name) VALUES ('C_MAP', 'custom-x')"
    ).run();
    const all = await getAgentsForChannel("C_MAP");
    expect(all.map((e) => e.agent.name)).toContain("custom-x");
    expect(await getAgentInChannel("C_MAP", "custom-x")).not.toBeNull();
    expect(await getAgentInChannel("C_UNMAPPED", "custom-x")).toBeNull();
  });
});

describe("agents.task_deadline_seconds", () => {
  it("backfills the built-ins and leaves no default in the live DDL", async () => {
    // The seed predates the column (0001 vs 0021), so an hour here is 0021's
    // copy step having covered it — the same shape as the tenant backfill above.
    expect((await getAgent("admin"))?.taskDeadlineSeconds).toBe(
      DEFAULT_TASK_DEADLINE_SECONDS
    );
    expect((await getAgent("onboarding"))?.taskDeadlineSeconds).toBe(
      DEFAULT_TASK_DEADLINE_SECONDS
    );

    // And the point of the rebuild: the table itself names no default, so the
    // only default that exists is the config constant. Matched per line rather
    // than over the whole statement — `enabled integer DEFAULT true` would
    // satisfy a whole-statement check — and the rebuild does put the column on
    // its own line.
    const ddl = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'"
    ).first<{ sql: string }>();
    expect(ddl?.sql).toContain("task_deadline_seconds");
    const column = ddl!.sql
      .split("\n")
      .find((l) => l.includes("task_deadline_seconds"));
    expect(column).toBeDefined();
    expect(column!.toUpperCase()).toContain("NOT NULL");
    expect(column!.toUpperCase()).not.toContain("DEFAULT");
  });

  it("is required by the database, and can never be null", async () => {
    // The shape the insert had before this column existed. With no database
    // default, a write path that forgets it fails loudly instead of silently
    // storing an hour nobody chose.
    await expect(
      env.DB.prepare(
        "INSERT INTO agents (name, kind, enabled, notify_on, a2a_endpoint, tenant_id, workspace_id) VALUES ('no-deadline', 'remote', 1, 'mention', 'https://example.com/n', 'main', 0)"
      ).run()
    ).rejects.toThrow(/NOT NULL/i);

    // And "no limit" is unreachable even going round the models.
    await registerAgent({
      name: "nullable-deadline",
      kind: "remote",
      a2aEndpoint: "https://example.com/nullable",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: 0
    });
    await expect(
      env.DB.prepare(
        "UPDATE agents SET task_deadline_seconds = NULL WHERE name = 'nullable-deadline'"
      ).run()
    ).rejects.toThrow(/NOT NULL/i);
  });

  it("is written by registerAgent and patched by updateAgent", async () => {
    // Omitted → the config constant. This is the test that fails if a future
    // change leans on a database default instead of writing one here.
    const defaulted = await registerAgent({
      name: "deadline-default",
      kind: "remote",
      a2aEndpoint: "https://example.com/deadline-default",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: 0
    });
    expect(defaulted.taskDeadlineSeconds).toBe(DEFAULT_TASK_DEADLINE_SECONDS);

    // Given → stored as given.
    const chosen = await registerAgent({
      name: "deadline-chosen",
      kind: "remote",
      a2aEndpoint: "https://example.com/deadline-chosen",
      tenantId: "main",
      notifyOn: "mention",
      taskDeadlineSeconds: 7200,
      workspaceId: 0
    });
    expect(chosen.taskDeadlineSeconds).toBe(7200);

    await updateAgent("deadline-chosen", { taskDeadlineSeconds: 1800 });
    expect((await getAgent("deadline-chosen"))?.taskDeadlineSeconds).toBe(1800);

    // Absent leaves the stored value alone, like every other patch field.
    await updateAgent("deadline-chosen", { enabled: false });
    expect((await getAgent("deadline-chosen"))?.taskDeadlineSeconds).toBe(1800);

    // There is no way to clear it — resetting means naming the default.
    await updateAgent("deadline-chosen", {
      taskDeadlineSeconds: DEFAULT_TASK_DEADLINE_SECONDS
    });
    expect((await getAgent("deadline-chosen"))?.taskDeadlineSeconds).toBe(
      DEFAULT_TASK_DEADLINE_SECONDS
    );
  });
});

describe("display names are sanitized at the write", () => {
  it("registerAgent neutralizes a card-derived name", async () => {
    const row = await registerAgent({
      name: "bcast-register",
      kind: "remote",
      // What a hostile remote agent publishes as its A2A card name.
      displayName: "<!channel> Helper",
      a2aEndpoint: "https://bcast-register.example.com/a2a",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: 0
    });
    expect(row.displayName).toBe("channel Helper");
    const stored = await env.DB.prepare(
      "SELECT display_name FROM agents WHERE name = 'bcast-register'"
    ).first<{ display_name: string }>();
    expect(stored?.display_name).toBe("channel Helper");
  });

  it("updateAgent neutralizes a re-derived card name", async () => {
    await registerAgent({
      name: "bcast-update",
      kind: "remote",
      displayName: "Fine",
      a2aEndpoint: "https://bcast-update.example.com/a2a",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: 0
    });
    await updateAgent("bcast-update", { displayName: "<!here>\nHelper" });
    expect((await getAgent("bcast-update"))?.displayName).toBe("here Helper");
  });

  it("setAdminDisplayName neutralizes the config value", async () => {
    await upsertWorkspace({ id: 24, name: "ws24", adminChannelId: null });
    await setAdminDisplayName(24, "@channel");
    expect(await getAdminDisplayName(24)).toBe("channel");
  });
});

describe("agentRenderIdentity", () => {
  it("layers the workspace's avatar and name onto the shared admin row", async () => {
    await upsertWorkspace({
      id: 21,
      name: "ws21",
      adminChannelId: "C_WS21_ADMIN"
    });
    await setAdminDisplayName(21, "Ops Bot");
    await setAdminIconUrl(21, "https://gw.example.com/icons/21/admin/aa.jpg");

    const admin = await getAgent("admin");
    expect(await agentRenderIdentity(admin!, "C_WS21_ADMIN")).toEqual({
      displayName: "Ops Bot",
      iconUrl: "https://gw.example.com/icons/21/admin/aa.jpg"
    });
  });

  it("keeps each workspace's admin identity independent", async () => {
    await upsertWorkspace({
      id: 22,
      name: "ws22",
      adminChannelId: "C_WS22_ADMIN"
    });
    await upsertWorkspace({
      id: 23,
      name: "ws23",
      adminChannelId: "C_WS23_ADMIN"
    });
    await setAdminIconUrl(22, "https://gw.example.com/icons/22/admin/bb.jpg");

    const admin = await getAgent("admin");
    // ws23 never generated one — it falls back to the registry row, not ws22's.
    expect(await agentRenderIdentity(admin!, "C_WS23_ADMIN")).toEqual({
      displayName: "Admin Agent",
      iconUrl: null
    });
  });

  it("uses the row as-is for a custom agent (its identity is not workspace-scoped)", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agents (name, kind, display_name, icon_url, enabled, notify_on, a2a_endpoint, tenant_id, task_deadline_seconds, workspace_id) VALUES ('custom-y', 'remote', 'Custom Y', 'https://gw.example.com/icons/0/custom-y/cc.jpg', 1, 'mention', 'https://example.com/y', 'main', 3600, 0)"
    ).run();
    const agent = await getAgent("custom-y");
    expect(await agentRenderIdentity(agent!, "C_ANY")).toEqual({
      displayName: "Custom Y",
      iconUrl: "https://gw.example.com/icons/0/custom-y/cc.jpg"
    });
  });

  it("falls back to the machine name when an agent has no display name", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agents (name, kind, enabled, notify_on, a2a_endpoint, tenant_id, task_deadline_seconds, workspace_id) VALUES ('custom-z', 'remote', 1, 'mention', 'https://example.com/z', 'main', 3600, 0)"
    ).run();
    const agent = await getAgent("custom-z");
    expect(await agentRenderIdentity(agent!, "C_ANY")).toEqual({
      displayName: "custom-z",
      iconUrl: null
    });
  });
});
