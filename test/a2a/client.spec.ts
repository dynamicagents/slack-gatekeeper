import { describe, it, expect, afterEach, vi } from "vitest";
import {
  AgentCard,
  Message,
  SendMessageResponse,
  Task,
  TaskState,
  type TaskPushNotificationConfig
} from "@a2a-js/sdk";
import {
  sendA2ARemote,
  cancelA2ARemote,
  sanitizeAgentReply
} from "@/a2a/client";
import { buildAgentCard } from "@/a2a/card";
import {
  agentMessage,
  makeTask,
  userMessage as buildUserMessage
} from "../helpers/a2a";

const ENDPOINT = "https://remote.example.com/a2a";
/** Which agent at that endpoint — one endpoint may serve several. */
const TENANT = "main";

/** The push config the gatekeeper hands a remote agent (v1.0 flattened shape). */
const PUSH: TaskPushNotificationConfig = {
  tenant: "",
  id: "",
  taskId: "",
  url: "https://gw.example.com/a2a/notifications",
  token: "ntok-9",
  authentication: undefined
};

function userMessage(text: string): Message {
  return buildUserMessage(text, { contextId: "C1:T1" });
}

interface Captured {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
}

/**
 * Stub global fetch as a fake *async* remote A2A server:
 *  - GET  → the agent card (so the client's discovery succeeds),
 *  - POST → a `submitted` Task ack (the remote returns immediately and pushes the
 *    real reply later, per the push-notification contract).
 * Records every call so we can assert the injected Bearer header + params.
 */
function stubRemote(taskId: string, calls: Captured[]) {
  const card = buildAgentCard({
    name: "Remote",
    description: "remote test agent",
    url: ENDPOINT
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const isReq = input instanceof Request;
      const url = isReq
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
      const method = init?.method ?? (isReq ? input.method : "GET");
      const headers = new Headers(
        init?.headers ?? (isReq ? input.headers : undefined)
      );
      const body = isReq
        ? await input.clone().text()
        : String(init?.body ?? "");
      calls.push({
        url,
        method,
        authorization: headers.get("authorization"),
        body
      });

      if (method.toUpperCase() === "POST") {
        let id: unknown = 1;
        try {
          id = JSON.parse(body).id ?? 1;
        } catch {
          /* ignore */
        }
        const task = makeTask({
          id: taskId,
          contextId: "C1:T1",
          state: TaskState.TASK_STATE_SUBMITTED
        });
        // v1.0 returns the protobuf-JSON of SendMessageResponse — the payload
        // oneof appears as a `task` key, not an inline `kind` discriminator.
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: SendMessageResponse.toJSON({
              payload: { $case: "task", value: task }
            })
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify(AgentCard.toJSON(card)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  );
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendA2ARemote — async remote accept", () => {
  it("injects the gatekeeper JWT as a Bearer header and sends the push config", async () => {
    const calls: Captured[] = [];
    stubRemote("task-1", calls);

    const result = await sendA2ARemote(
      { endpoint: ENDPOINT, authToken: "tok-123", tenant: TENANT },
      userMessage("hi"),
      PUSH
    );

    expect(result).toEqual({ kind: "accepted", taskId: "task-1" });

    const post = calls.find((c) => c.method.toUpperCase() === "POST");
    expect(post).toBeDefined();
    expect(post?.authorization).toBe("Bearer tok-123");
    // The push-notification config must ride on the SendMessage params. v1.0
    // renamed the field and flattened the config into it.
    const parsed = JSON.parse(post?.body ?? "{}");
    const push = parsed.params?.configuration?.taskPushNotificationConfig;
    expect(push?.url).toBe("https://gw.example.com/a2a/notifications");
    expect(push?.token).toBe("ntok-9");
  });

  it("returns contract_violation when required Task acceptance/id is missing", async () => {
    const calls: Captured[] = [];
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
        if (method.toUpperCase() === "POST") {
          const reply = agentMessage("sync reply", { contextId: "C1:T1" });
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: SendMessageResponse.toJSON({
                payload: { $case: "message", value: reply }
              })
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify(AgentCard.toJSON(card)), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );
    void calls;

    const result = await sendA2ARemote(
      { endpoint: ENDPOINT, authToken: "t", tenant: TENANT },
      userMessage("hi"),
      { ...PUSH, token: "n" }
    );
    expect(result).toEqual({ kind: "contract_violation" });
  });
});

/**
 * Stub a remote whose GET serves the card and whose POST returns a fixed
 * JSON-RPC payload (a result or an error), so we can drive `tasks/cancel`
 * through the SDK client's typed-error mapping.
 */
function stubRemoteRpc(postPayload: (id: unknown) => unknown) {
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
      return new Response(JSON.stringify(card), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    })
  );
}

const rpcResult = (id: unknown, result: unknown) => ({
  jsonrpc: "2.0",
  id,
  result
});
const rpcError = (id: unknown, code: number, message = "err") => ({
  jsonrpc: "2.0",
  id,
  error: { code, message }
});

describe("sendA2ARemote — A2A protocol refusals", () => {
  it.each([
    [-32009, "version not supported"],
    [-32602, "malformed request"],
    [-32004, "unsupported operation"],
    [-32003, "push notifications unsupported"]
  ])(
    "folds %i into a protocol_error instead of throwing (%s)",
    async (code) => {
      stubRemoteRpc((id) => rpcError(id, code));
      const out = await sendA2ARemote(
        { endpoint: ENDPOINT, authToken: "t", tenant: TENANT },
        userMessage("hi"),
        PUSH
      );
      expect(out).toEqual({
        kind: "protocol_error",
        code,
        reason: expect.any(String)
      });
    }
  );

  it("rethrows -32603 so the workflow still retries an agent-side fault", async () => {
    // The carve-out that keeps a recoverable blip from becoming a hard failure.
    stubRemoteRpc((id) => rpcError(id, -32603, "boom"));
    await expect(
      sendA2ARemote(
        { endpoint: ENDPOINT, authToken: "t", tenant: TENANT },
        userMessage("hi"),
        PUSH
      )
    ).rejects.toThrow(/boom/);
  });

  it("rethrows a transport failure with its original message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    await expect(
      sendA2ARemote(
        { endpoint: ENDPOINT, authToken: "t", tenant: TENANT },
        userMessage("hi"),
        PUSH
      )
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("cancelA2ARemote — A2A tasks/cancel", () => {
  it("returns canceled with the updated task on success", async () => {
    const canceled = makeTask({
      id: "task-9",
      contextId: "C1:T1",
      state: TaskState.TASK_STATE_CANCELED
    });
    // `CancelTask` returns the Task itself (not a payload envelope), as protoJSON.
    stubRemoteRpc((id) => rpcResult(id, Task.toJSON(canceled)));

    const out = await cancelA2ARemote(
      { endpoint: ENDPOINT, authToken: "t", tenant: TENANT },
      "task-9"
    );
    expect(out.kind).toBe("canceled");
    if (out.kind === "canceled") {
      expect(out.task.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    }
  });

  it("maps -32002 to not_cancelable (already terminal)", async () => {
    stubRemoteRpc((id) => rpcError(id, -32002));
    const out = await cancelA2ARemote(
      { endpoint: ENDPOINT, authToken: "t", tenant: TENANT },
      "task-9"
    );
    expect(out).toEqual({ kind: "not_cancelable" });
  });

  it("maps -32001 to not_found (idempotent no-op)", async () => {
    stubRemoteRpc((id) => rpcError(id, -32001));
    const out = await cancelA2ARemote(
      { endpoint: ENDPOINT, authToken: "t", tenant: TENANT },
      "task-9"
    );
    expect(out).toEqual({ kind: "not_found" });
  });

  it("maps -32004 to unsupported (agent doesn't implement cancel)", async () => {
    stubRemoteRpc((id) => rpcError(id, -32004));
    const out = await cancelA2ARemote(
      { endpoint: ENDPOINT, authToken: "t", tenant: TENANT },
      "task-9"
    );
    expect(out).toEqual({ kind: "unsupported" });
  });

  it("maps any other error code to error", async () => {
    stubRemoteRpc((id) => rpcError(id, -32603, "boom"));
    const out = await cancelA2ARemote(
      { endpoint: ENDPOINT, authToken: "t", tenant: TENANT },
      "task-9"
    );
    expect(out.kind).toBe("error");
  });
});

describe("sanitizeAgentReply — untrusted reply hardening", () => {
  it("strips control characters and caps an oversized reply", () => {
    const hostile = "x".repeat(20_000) + "\u0007bell";
    const reply = sanitizeAgentReply(hostile);
    expect(reply).not.toContain("\u0007");
    // 16_000 chars + the truncation ellipsis.
    expect(reply.length).toBe(16_001);
    expect(reply.endsWith("…")).toBe(true);
  });

  it("keeps tabs and newlines", () => {
    expect(sanitizeAgentReply("a\tb\nc")).toBe("a\tb\nc");
  });

  it("neutralizes channel-wide mentions so a hostile reply can't notify everyone", () => {
    const reply = sanitizeAgentReply(
      "urgent <!channel> and <!here> and <!subteam^S1|@grp> now"
    );
    expect(reply).toBe("urgent channel and here and subteam^S1|@grp now");

    // The plain spelling too — Slack links these up when link_names is set.
    expect(sanitizeAgentReply("ping @channel and @everyone")).toBe(
      "ping channel and everyone"
    );
  });
});
