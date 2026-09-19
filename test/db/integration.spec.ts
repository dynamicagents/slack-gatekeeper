import { describe, it, expect } from "vitest";
import {
  getAgent,
  getAgentChannels,
  listAgentsForWorkspace,
  registerAgent,
  updateAgent,
  unregisterAgent,
  attachAgentChannel,
  detachAgentChannel
} from "@/db/models/agents";
import {
  createWorkspace,
  getWorkspace,
  ORG_WORKSPACE_ID
} from "@/db/models/workspaces";
import { createAgentTask, getAgentTaskByToken } from "@/db/models/agent-tasks";
import { createHitlRequest, getHitlRequest } from "@/db/models/hitl-requests";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

describe("workspaces — createWorkspace", () => {
  it("allocates an id above the org sentinel and persists the row", async () => {
    const ws = await createWorkspace({ name: "crud-team-a" });
    expect(ws.id).toBeGreaterThan(ORG_WORKSPACE_ID);
    expect(ws.name).toBe("crud-team-a");
    expect(await getWorkspace(ws.id)).toMatchObject({
      name: "crud-team-a"
    });
  });

  it("allocates monotonically increasing ids", async () => {
    const a = await createWorkspace({ name: "crud-team-b" });
    const b = await createWorkspace({ name: "crud-team-c" });
    expect(b.id).toBeGreaterThan(a.id);
  });
});

describe("agents — registry CRUD", () => {
  it("registers, updates, and unregisters a custom agent", async () => {
    const ws = await createWorkspace({ name: "crud-agents-1" });
    const row = await registerAgent({
      name: "crud-agent-1",
      kind: "remote",
      displayName: "Crud Agent 1",
      a2aEndpoint: "https://example.com/crud-1",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: ws.id
    });
    expect(row).toMatchObject({
      name: "crud-agent-1",
      kind: "remote",
      workspaceId: ws.id
    });
    expect(row.enabled).toBe(true);

    const updated = await updateAgent("crud-agent-1", {
      displayName: "Renamed",
      enabled: false,
      a2aEndpoint: "https://example.com/a2a",
      tenantId: "main"
    });
    expect(updated).toMatchObject({
      displayName: "Renamed",
      enabled: false,
      a2aEndpoint: "https://example.com/a2a",
      tenantId: "main"
    });

    await unregisterAgent("crud-agent-1");
    expect(await getAgent("crud-agent-1")).toBeNull();
  });

  it("listAgentsForWorkspace scopes by workspace", async () => {
    const wsA = await createWorkspace({ name: "crud-scope-a" });
    const wsB = await createWorkspace({ name: "crud-scope-b" });
    await registerAgent({
      name: "crud-agent-scoped",
      kind: "remote",
      a2aEndpoint: "https://example.com/crud-scoped",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: wsA.id
    });
    const inA = await listAgentsForWorkspace(wsA.id);
    expect(inA.map((a) => a.name)).toContain("crud-agent-scoped");
    const inB = await listAgentsForWorkspace(wsB.id);
    expect(inB.map((a) => a.name)).not.toContain("crud-agent-scoped");
  });

  it("attach/detach channels and cascade on unregister", async () => {
    const ws = await createWorkspace({ name: "crud-channels" });
    await registerAgent({
      name: "crud-agent-ch",
      kind: "remote",
      a2aEndpoint: "https://example.com/crud-ch",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: ws.id
    });
    await attachAgentChannel({
      agentName: "crud-agent-ch",
      channelId: "C_CRUD",
      workspaceId: ws.id
    });
    // idempotent
    await attachAgentChannel({
      agentName: "crud-agent-ch",
      channelId: "C_CRUD",
      workspaceId: ws.id
    });
    expect(await getAgentChannels("crud-agent-ch")).toEqual(["C_CRUD"]);

    await detachAgentChannel("crud-agent-ch", "C_CRUD");
    expect(await getAgentChannels("crud-agent-ch")).toEqual([]);

    // re-attach, then unregister should remove channel rows too
    await attachAgentChannel({
      agentName: "crud-agent-ch",
      channelId: "C_CRUD2",
      workspaceId: ws.id
    });
    await unregisterAgent("crud-agent-ch");
    expect(await getAgentChannels("crud-agent-ch")).toEqual([]);
  });

  it("unregister cascades past dispatch history and open prompts", async () => {
    // An agent that has actually been used owns rows in every table keyed on
    // its name. Those FKs are enforced, so a cascade that stops at
    // agent_channels cannot delete the agent at all — it strips the channels,
    // then the parent delete is rejected and the agent lives on, unreachable.
    const ws = await createWorkspace({ name: "crud-cascade" });
    await registerAgent({
      name: "crud-agent-used",
      kind: "remote",
      a2aEndpoint: "https://example.com/crud-used",
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: ws.id
    });
    await attachAgentChannel({
      agentName: "crud-agent-used",
      channelId: "C_USED",
      workspaceId: ws.id
    });
    await createAgentTask({
      token: "tok-cascade",
      taskId: "task-cascade",
      agentName: "crud-agent-used",
      channelId: "C_USED",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev_CASCADE"
    });
    await createHitlRequest({
      requestId: "req-cascade",
      token: "tok-cascade",
      taskId: "task-cascade",
      contextId: "C_USED:1700.1",
      agentName: "crud-agent-used",
      channelId: "C_USED",
      threadTs: null,
      requestKind: "approval",
      promptText: "Approve?",
      optionsJson: null,
      allowFreeform: false,
      deadlineAt: Math.floor(Date.now() / 1000) + 3600
    });

    await unregisterAgent("crud-agent-used");

    expect(await getAgent("crud-agent-used")).toBeNull();
    expect(await getAgentChannels("crud-agent-used")).toEqual([]);
    expect(await getAgentTaskByToken("tok-cascade")).toBeNull();
    expect(await getHitlRequest("req-cascade")).toBeNull();
  });
});
