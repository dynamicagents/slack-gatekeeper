import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentCard, Task, TaskState } from "@a2a-js/sdk";
import { registerAgent } from "@/db/models/agents";
import {
  setPublicUrl,
  setAllowedRemoteAgentDomains
} from "@/db/models/workspace-configs";
import { createAgentTask, getAgentTaskByToken } from "@/db/models/agent-tasks";
import { cancelTaskRow } from "@/workflows/message-helpers";
import { buildAgentCard } from "@/a2a/card";
import { makeTask } from "../helpers/a2a";

const ENDPOINT = "https://agent.example.com/a2a";
const ISSUER = "https://gw.example.com";

/** Serve the agent card on GET and a fixed JSON-RPC payload on POST (tasks/cancel). */
function stubCancelRemote(postPayload: (id: unknown) => unknown) {
  const card = buildAgentCard({
    name: "Remote",
    description: "remote test agent",
    url: ENDPOINT
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const isReq = input instanceof Request;
      const method = init?.method ?? (isReq ? input.method : "GET");
      const body = isReq
        ? await input.clone().text()
        : String(init?.body ?? "");
      if (method.toUpperCase() === "POST") {
        let id: unknown = 1;
        try {
          id = JSON.parse(body).id ?? 1;
        } catch {
          /* ignore */
        }
        return new Response(JSON.stringify(postPayload(id)), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify(AgentCard.toJSON(card)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    })
  );
}

/** `CancelTask` returns the Task itself, as protobuf-JSON on the wire. */
const canceledTask: unknown = Task.toJSON(
  makeTask({
    id: "task-9",
    contextId: "C1:T1",
    state: TaskState.TASK_STATE_CANCELED
  })
);

beforeEach(async () => {
  await registerAgent({
    name: "remoteagent",
    kind: "remote",
    a2aEndpoint: ENDPOINT,
    tenantId: "main",
    notifyOn: "mention",
    workspaceId: 0
  });
  await setPublicUrl(ISSUER);
  await setAllowedRemoteAgentDomains(["agent.example.com"]);
});

afterEach(() => vi.unstubAllGlobals());

async function seedTask(token: string, taskId: string | null): Promise<void> {
  await createAgentTask({
    token,
    taskId,
    agentName: "remoteagent",
    channelId: "C1",
    messageTs: "1700.1",
    replyThreadTs: null,
    eventId: "Ev1"
  });
}

/** A human tapping the 🛑 — the origin for every case that isn't about the timeout. */
const USER_ORIGIN = { reason: "user", actorUserId: "U123" } as const;

describe("cancelTaskRow", () => {
  it("cancels a task with a known taskId and terminalizes the ledger row", async () => {
    stubCancelRemote((id) => ({ jsonrpc: "2.0", id, result: canceledTask }));
    await seedTask("t1", "task-9");
    const row = await getAgentTaskByToken("t1");

    const res = await cancelTaskRow(row!, USER_ORIGIN);
    expect(res).toEqual({ agentName: "remoteagent", kind: "stopped" });
    expect((await getAgentTaskByToken("t1"))?.status).toBe("canceled");
  });

  it("records intent (no cancel call) when the taskId isn't known yet", async () => {
    // No POST should happen — a bare fetch would 500 the card discovery instead.
    const fetchSpy = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    await seedTask("t2", null);
    const row = await getAgentTaskByToken("t2");

    const res = await cancelTaskRow(row!, USER_ORIGIN);
    expect(res).toEqual({ agentName: "remoteagent", kind: "stopped" });
    // The row stays pending, flagged for the dispatch's accept path to honor.
    const after = await getAgentTaskByToken("t2");
    expect(after?.status).toBe("pending");
    expect(after?.cancelRequested).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("terminalizes even when the agent refuses to cancel (unsupported)", async () => {
    stubCancelRemote((id) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32004, message: "unsupported" }
    }));
    await seedTask("t3", "task-9");
    const row = await getAgentTaskByToken("t3");

    const res = await cancelTaskRow(row!, USER_ORIGIN);
    expect(res).toEqual({ agentName: "remoteagent", kind: "unsupported" });
    // The agent may run on, but the stop stands: the row is terminal and the reply
    // it still produces is dropped at the notification boundary.
    expect((await getAgentTaskByToken("t3"))?.status).toBe("canceled");
  });

  it("terminalizes even when the cancel attempt fails (error)", async () => {
    stubCancelRemote((id) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "boom" }
    }));
    await seedTask("t5", "task-9");
    const row = await getAgentTaskByToken("t5");

    const res = await cancelTaskRow(row!, USER_ORIGIN);
    expect(res).toEqual({ agentName: "remoteagent", kind: "error" });
    // A failed attempt doesn't reprieve the task — the user asked for it to stop,
    // so the row goes terminal and any late callback is dropped.
    expect((await getAgentTaskByToken("t5"))?.status).toBe("canceled");
  });

  it("treats an already-terminal task as stopped (idempotent)", async () => {
    stubCancelRemote((id) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32002, message: "not cancelable" }
    }));
    await seedTask("t4", "task-9");
    const row = await getAgentTaskByToken("t4");

    const res = await cancelTaskRow(row!, USER_ORIGIN);
    expect(res).toEqual({ agentName: "remoteagent", kind: "stopped" });
    expect((await getAgentTaskByToken("t4"))?.status).toBe("canceled");
  });

  it("records the same canceled status when the gatekeeper times the task out", async () => {
    stubCancelRemote((id) => ({ jsonrpc: "2.0", id, result: canceledTask }));
    await seedTask("t6", "task-9");
    const row = await getAgentTaskByToken("t6");

    const res = await cancelTaskRow(row!, {
      reason: "task-timeout",
      actorUserId: null
    });
    // One terminal state for both triggers — which one fired lives in the log line,
    // since the actor is not a column.
    expect(res).toEqual({ agentName: "remoteagent", kind: "stopped" });
    expect((await getAgentTaskByToken("t6"))?.status).toBe("canceled");
  });
});
