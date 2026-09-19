import { describe, it, expect, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { UserAuthContext } from "@/auth";
import {
  directoryAgents,
  directoryWorkspaces,
  directoryHealth,
  buildOnboardingTools,
  type OnboardingToolDeps
} from "@/agents/onboarding/tools";
import { createWorkspace } from "@/db/models/workspaces";
import { registerAgent, updateAgent } from "@/db/models/agents";
import { upsertSlackUser } from "@/db/models/users";
import { makeAuthCtx, freshWsId } from "../../helpers/workspace";
import { useStorageReset } from "../../helpers/storage";

useStorageReset();

afterEach(() => vi.restoreAllMocks());

const ctx = makeAuthCtx;

function deps(c: UserAuthContext | null): OnboardingToolDeps {
  return {
    ctx: c
  };
}

type AgentList = { agents: Array<{ name: string; kind: string }> };
type WsList = {
  workspaces: Array<{ id: number; adminChannelConfigured: boolean }>;
};

describe("onboarding tools — directory_read agents", () => {
  it("shows every enabled agent to any caller, regardless of workspace", async () => {
    const mine = await freshWsId("onb-mine");
    const other = await freshWsId("onb-other");
    await registerAgent({
      name: "onb-mine-agent",
      kind: "remote",
      a2aEndpoint: "https://example.com/onb-mine",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: mine
    });
    await registerAgent({
      name: "onb-other-agent",
      kind: "remote",
      a2aEndpoint: "https://example.com/onb-other",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: other
    });

    // A plain member (admins nothing) still sees the whole directory.
    const res = (await directoryAgents()) as AgentList;
    const names = res.agents.map((a) => a.name);

    // Built-in concierge/admin are always reachable.
    expect(names).toContain("admin");
    expect(names).toContain("onboarding");
    // Custom agents from any workspace are routing info, not secrets.
    expect(names).toContain("onb-mine-agent");
    expect(names).toContain("onb-other-agent");
  });

  it("hides disabled agents", async () => {
    const wsId = await freshWsId("onb-disabled");
    await registerAgent({
      name: "onb-disabled-agent",
      kind: "remote",
      a2aEndpoint: "https://example.com/onb-disabled",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: wsId
    });
    await updateAgent("onb-disabled-agent", { enabled: false });

    const res = (await directoryAgents()) as AgentList;
    expect(res.agents.map((a) => a.name)).not.toContain("onb-disabled-agent");
  });
});

describe("onboarding tools — directory_read workspaces", () => {
  it("returns only the workspaces the caller administers", async () => {
    const a = await freshWsId("onb-ws-a");
    await freshWsId("onb-ws-b");
    const res = (await directoryWorkspaces(
      deps(ctx({ adminWorkspaces: [a] }))
    )) as WsList;
    expect(res.workspaces.map((w) => w.id)).toEqual([a]);
  });

  it("returns nothing for an unauthenticated caller", async () => {
    const res = (await directoryWorkspaces(deps(null))) as WsList;
    expect(res.workspaces).toHaveLength(0);
  });

  it("an org admin sees every workspace", async () => {
    const created = await freshWsId("onb-ws-org");
    const res = (await directoryWorkspaces(
      deps(ctx({ isOrgAdmin: true }))
    )) as WsList;
    expect(res.workspaces.map((w) => w.id)).toContain(created);
  });
});

describe("onboarding tools — directory_read health", () => {
  it("reports a registered user and admin-channel status", async () => {
    const wsId = (
      await createWorkspace({
        name: "onb-health-ws",
        adminChannelId: "C_HEALTH"
      })
    ).id;
    await upsertSlackUser({
      slackUserId: "U_health",
      displayName: "Healthy"
    });

    const res = (await directoryHealth(
      deps(ctx({ slackUserId: "U_health", adminWorkspaces: [wsId] }))
    )) as {
      registered: boolean;
      enabledAgentCount: number;
      administersWorkspaces: Array<{ adminChannelConfigured: boolean }>;
    };

    expect(res.registered).toBe(true);
    expect(res.enabledAgentCount).toBeGreaterThanOrEqual(2);
    expect(res.administersWorkspaces[0].adminChannelConfigured).toBe(true);
  });

  it("reports an unregistered user with a reconcile note", async () => {
    const res = (await directoryHealth(
      deps(ctx({ slackUserId: "U_never_seen" }))
    )) as { registered: boolean; note?: string };
    expect(res.registered).toBe(false);
    expect(res.note).toMatch(/sync|reconcile/i);
  });
});

describe("onboarding tools — buildOnboardingTools", () => {
  it("exposes directory_read and trigger_reconcile tools", () => {
    const tools = buildOnboardingTools(deps(ctx()));
    expect(Object.keys(tools)).toEqual(["directory_read", "trigger_reconcile"]);
  });

  it("trigger_reconcile is denied for non-admin callers", async () => {
    const tools = buildOnboardingTools(deps(ctx()));
    const result = await (
      tools.trigger_reconcile as unknown as { execute: () => Promise<unknown> }
    ).execute();
    expect(result).toMatchObject({
      triggered: false,
      error: expect.stringMatching(/only org admins|primary owner/i)
    });
  });

  it("trigger_reconcile starts workflow for org admin callers", async () => {
    vi.spyOn(env.RECONCILE_WORKFLOW, "create").mockResolvedValue({
      id: "wf-real"
    } as WorkflowInstance);
    const tools = buildOnboardingTools({
      ctx: ctx({ isOrgAdmin: true })
    });
    const result = await (
      tools.trigger_reconcile as unknown as { execute: () => Promise<unknown> }
    ).execute();
    expect(result).toMatchObject({ triggered: true, instanceId: "wf-real" });
  });
});
