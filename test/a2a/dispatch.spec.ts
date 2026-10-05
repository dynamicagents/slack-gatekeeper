import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  AgentCard,
  Message,
  SendMessageResponse,
  Task,
  TaskState
} from "@a2a-js/sdk";
import { decodeJwt, jwtVerify } from "jose";
import {
  _resetIssuerCacheForTest,
  dispatchToAgent,
  cancelAgentTask,
  timeoutAgentTask,
  buildDispatchId,
  buildAgentInstanceKey
} from "@/a2a/dispatch";
import { slackTsToIso } from "@/a2a/turn";
import type { UserAuthContext } from "@/auth";
import { IDENTITY_CLAIM } from "@/auth/agent-outbound";
import { importGatekeeperPublicKey } from "../helpers/auth";
import { buildAgentCard } from "@/a2a/card";
import { HITL_TIMEOUT_TYPE } from "@/a2a/hitl";
import { dataPart, partsText, textPart } from "@/a2a/parts";
import { agentMessage, makeTask } from "../helpers/a2a";
import { stubOutbound } from "../helpers/agents";
import { registerAgent } from "@/db/models/agents";
import {
  createAgentTask,
  suspendForInput,
  getAgentTaskByToken
} from "@/db/models/agent-tasks";
import {
  createHitlRequest,
  getHitlRequest,
  type HitlRequestRow
} from "@/db/models/hitl-requests";
import {
  setAllowedRemoteAgentDomains,
  setPublicUrl
} from "@/db/models/workspace-configs";
import { setWorkspaceAdminChannel } from "@/db/models/workspaces";
import { signGatekeeperToken } from "@/auth/agent-outbound";
import {
  AGENTS_RPC_PATH,
  agentsWorker,
  builtinEndpoint
} from "@/agents/worker";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

const user = (slackUserId: string): UserAuthContext => ({
  slackUserId,
  displayName: null,
  isPrimaryOwner: false,
  isOrgAdmin: false,
  adminWorkspaces: []
});

const ENDPOINT = "https://remote.example.com/a2a";

interface RemotePost {
  /** Where the request actually went — the POST target, not what was stored. */
  url: string;
  authorization: string | null;
  message: Message;
  /** Which agent at the endpoint the request addressed (A2A §8.3.2). */
  tenant: string | undefined;
}

/** A `chat.postMessage` the gatekeeper sent to the thread (e.g. a failure notice). */
interface SlackNotice {
  channel: string;
  text: string;
  thread_ts?: string;
}

/** Record a `chat.postMessage` call into `notices` and ack it like Slack would. */
async function captureSlackNotice(
  request: Request,
  notices?: SlackNotice[]
): Promise<Response> {
  if (notices) {
    const body = new URLSearchParams(await request.clone().text());
    notices.push({
      channel: body.get("channel") ?? "",
      text: body.get("text") ?? "",
      thread_ts: body.get("thread_ts") ?? undefined
    });
  }
  return Response.json({ ok: true, ts: "1700.notice" });
}

/**
 * Record a captured A2A POST. The message arrives as protobuf-JSON, so it is
 * decoded through the generated codec — the specs then assert against the same
 * typed shape the gatekeeper sent.
 */
async function readRpc(
  request: Request,
  posts: RemotePost[]
): Promise<{ id?: unknown; method?: string }> {
  const rpc = (await request.clone().json()) as {
    id?: unknown;
    method?: string;
    params?: { message?: unknown; tenant?: string };
  };
  posts.push({
    url: request.url,
    authorization: request.headers.get("authorization"),
    message: Message.fromJSON(rpc.params?.message ?? {}),
    tenant: rpc.params?.tenant
  });
  return rpc;
}

function stubRemote(
  posts: RemotePost[],
  notices?: SlackNotice[],
  /** Card fetches the remote received — expected to stay empty at dispatch. */
  gets?: string[]
) {
  const card = buildAgentCard({
    name: "Remote",
    description: "remote dispatch test agent",
    url: ENDPOINT
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const method = request.method.toUpperCase();
      if (request.url.includes("chat.postMessage")) {
        return captureSlackNotice(request, notices);
      }
      if (method === "GET") gets?.push(request.url);
      if (method === "POST") {
        const rpc = await readRpc(request, posts);
        // `CancelTask` answers with the Task itself; `SendMessage` answers with
        // a SendMessageResponse envelope. v1.0 gave the two distinct result
        // shapes, so the stub has to branch on the method.
        if (rpc.method === "CancelTask") {
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: Task.toJSON(
              makeTask({
                id: "task-9",
                contextId: "reply",
                state: TaskState.TASK_STATE_CANCELED
              })
            )
          });
        }
        // Async contract: a remote returns a Task ack immediately, not a reply.
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: SendMessageResponse.toJSON({
            payload: {
              $case: "task",
              value: makeTask({
                id: "task-remote-1",
                contextId: "reply",
                state: TaskState.TASK_STATE_SUBMITTED
              })
            }
          })
        });
      }
      return Response.json(AgentCard.toJSON(card));
    })
  );
}

function stubRemoteContractViolation(
  posts: RemotePost[],
  notices?: SlackNotice[]
) {
  const card = buildAgentCard({
    name: "Remote",
    description: "remote dispatch test agent",
    url: ENDPOINT
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const method = request.method.toUpperCase();
      if (request.url.includes("chat.postMessage")) {
        return captureSlackNotice(request, notices);
      }
      if (method === "POST") {
        const rpc = await readRpc(request, posts);
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: SendMessageResponse.toJSON({
            payload: {
              $case: "message",
              value: agentMessage("sync reply", { contextId: "reply" })
            }
          })
        });
      }
      return Response.json(AgentCard.toJSON(card));
    })
  );
}

/** A remote whose card resolves but whose POST answers with a JSON-RPC error. */
function stubRemoteRpcError(
  code: number,
  posts: RemotePost[],
  notices?: SlackNotice[]
) {
  const card = buildAgentCard({
    name: "Remote",
    description: "remote dispatch test agent",
    url: ENDPOINT
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const method = request.method.toUpperCase();
      if (request.url.includes("chat.postMessage")) {
        return captureSlackNotice(request, notices);
      }
      if (method === "POST") {
        const rpc = await readRpc(request, posts);
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          error: { code, message: "refused" }
        });
      }
      return Response.json(AgentCard.toJSON(card));
    })
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _resetIssuerCacheForTest();
  await setPublicUrl("https://gatekeeper.test");
  await setAllowedRemoteAgentDomains([]);
});

// A built-in is a core tenant on this Worker, called the way a remote agent is
// — signed token, accept-first `SendMessage` — but handed to the mounted A2A
// endpoint in-process. Core's edge still fetches the gatekeeper's JWKS to verify
// the token, which `stubOutbound` routes back into this Worker.
describe("dispatchToAgent (built-in)", () => {
  const ORIGIN = "https://gatekeeper.test";
  let outbound: string[];

  beforeEach(async () => {
    await setPublicUrl(ORIGIN);
    await setWorkspaceAdminChannel(0, "C_ORG");
    outbound = [];
    stubOutbound(ORIGIN, () => ({ ok: true, ts: "1700.2" }));
    const routed = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(new Request(input, init).url);
        return routed(input, init);
      }
    );
  });

  const ADMIN = {
    name: "admin",
    kind: "local" as const,
    a2aEndpoint: "http://admin.local",
    tenantId: "admin",
    workspaceId: 0
  };
  const ONBOARDING = {
    name: "onboarding",
    kind: "local" as const,
    a2aEndpoint: "http://onboarding.local",
    tenantId: "onboarding",
    workspaceId: 0
  };

  function payload(eventId: string, channelId: string, text = "ping") {
    return {
      eventId,
      text,
      channelId,
      channelName: null,
      threadTs: "1.1",
      messageTs: "1.1",
      user: user("U1")
    };
  }

  it("hands the admin's turn to its tenant in-process and accepts a task", async () => {
    const result = await dispatchToAgent(ADMIN, {
      ...payload("Ev-admin", "C_ORG"),
      metadata: { agentKind: "local", tenant: "admin" }
    });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.taskId.length).toBeGreaterThan(0);
    expect(result.token).toBe(await buildDispatchId("Ev-admin", ADMIN));

    // The task lives in the workspace's admin host, `admin:{wsId}`.
    const host = env.AdminHost.get(env.AdminHost.idFromName("admin:0"));
    expect((await host.getTask(result.taskId))?.id).toBe(result.taskId);
    // Nothing left the isolate but core reading our own JWKS: the call itself
    // never touched the network.
    expect(outbound.some((u) => u.endsWith(AGENTS_RPC_PATH))).toBe(false);
  });

  it("keys onboarding by its direct-message channel", async () => {
    const result = await dispatchToAgent(ONBOARDING, {
      ...payload("Ev-onb", "D1", "hi"),
      metadata: { agentKind: "local", tenant: "onboarding" }
    });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    const host = env.OnboardingHost.get(
      env.OnboardingHost.idFromName("onboarding:D1")
    );
    expect((await host.getTask(result.taskId))?.id).toBe(result.taskId);
  });

  it("refuses an admin dispatch from a channel that is no workspace's admin channel", async () => {
    await expect(
      dispatchToAgent(ADMIN, {
        ...payload("Ev-stray", "C_NOT_ADMIN"),
        metadata: { agentKind: "local", tenant: "admin" }
      })
    ).rejects.toThrow(/names no instance/);
  });

  it("the tenants refuse a token minted for a remote agent", async () => {
    // A remote row pointed at this origin with tenant `admin` carries a valid
    // gatekeeper token. Its identity says `remote`, which the mount refuses.
    const token = await signGatekeeperToken({
      audience: builtinEndpoint(ORIGIN),
      issuer: ORIGIN,
      tenant: "admin",
      identity: {
        key: "remote:0:evil",
        name: "evil",
        kind: "remote",
        workspaceId: 0
      }
    });
    const res = await agentsWorker(
      new Request(builtinEndpoint(ORIGIN), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "a2a-version": "1.0"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "SendMessage",
          params: {
            tenant: "admin",
            message: {
              messageId: "m-evil",
              role: "ROLE_USER",
              parts: [{ text: "list agents" }]
            },
            configuration: {
              returnImmediately: true,
              taskPushNotificationConfig: {
                url: `${ORIGIN}/a2a/notifications`,
                token: "t-evil"
              }
            }
          }
        })
      }),
      env
    );
    const body = (await res.json().catch(() => ({}))) as {
      result?: unknown;
      error?: unknown;
    };
    expect(body.result).toBeUndefined();
    expect(
      await env.AdminHost.get(
        env.AdminHost.idFromName("remote:0:evil")
      ).listTasks({ includeArtifacts: false, limit: 10, offset: 0 })
    ).toMatchObject({ totalSize: 0 });
  });
});

describe("dispatchToAgent (remote)", () => {
  it("namespaces remote identity and context per logical agent instance", async () => {
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    const posts: RemotePost[] = [];
    stubRemote(posts);

    await dispatchToAgent(
      {
        name: "alpha",
        kind: "remote",
        a2aEndpoint: ENDPOINT,
        tenantId: "main",
        workspaceId: 7
      },
      {
        eventId: "Ev-alpha",
        text: "first",
        channelId: "C_SHARED",
        channelName: "general",
        threadTs: "171813.100",
        messageTs: "171813.100",
        user: user("U1"),
        metadata: {
          agentKind: "remote",
          tenant: "main",
          workspaceId: 7
        }
      }
    );

    await dispatchToAgent(
      {
        name: "beta",
        kind: "remote",
        a2aEndpoint: ENDPOINT,
        tenantId: "main",
        workspaceId: 7
      },
      {
        eventId: "Ev-beta",
        text: "second",
        channelId: "C_SHARED",
        channelName: null,
        threadTs: "171813.100",
        messageTs: "171813.200",
        user: { ...user("U2"), displayName: "Grace" },
        metadata: {
          agentKind: "remote",
          tenant: "main",
          workspaceId: 7
        }
      }
    );

    expect(posts).toHaveLength(2);
    expect(posts[0].authorization?.startsWith("Bearer ")).toBe(true);
    expect(posts[1].authorization?.startsWith("Bearer ")).toBe(true);
    expect(posts[0].message.contextId).not.toBe(posts[1].message.contextId);
    expect(posts[0].message.contextId).toContain(
      encodeURIComponent("remote:7:alpha")
    );
    expect(posts[1].message.contextId).toContain(
      encodeURIComponent("remote:7:beta")
    );
    // messageId is the deterministic dispatch id — a compact 19-char base36 hash
    // of {eventId}:{instanceKey}, so a retried dispatch is dedupable by the remote
    // rather than appended twice, and it leaks neither the event id nor the key.
    expect(posts[0].message.messageId).toMatch(/^[0-9a-z]{19}$/);
    expect(posts[1].message.messageId).toMatch(/^[0-9a-z]{19}$/);
    expect(posts[0].message.messageId).not.toBe(posts[1].message.messageId);
    // Determinism: recomputing from the same inputs yields the same id.
    expect(
      await buildDispatchId("Ev-alpha", {
        name: "alpha",
        kind: "remote",
        workspaceId: 7
      })
    ).toBe(posts[0].message.messageId);
    // No structured provenance on the wire — who/where/when is inlined into the
    // turn text by the Gatekeeper. Metadata carries only routing extras.
    expect(posts[0].message.metadata).toMatchObject({
      agentKind: "remote",
      workspaceId: 7
    });
    expect(posts[0].message.metadata).not.toHaveProperty("provenance");
    expect(partsText(posts[0].message.parts)).toBe(
      `<turn from="U1" id="U1" channel="general" ` +
        `at="${slackTsToIso("171813.100")}">first</turn>`
    );
    // Beta's caller has a display name and no resolved channel → id fallback.
    expect(partsText(posts[1].message.parts)).toBe(
      `<turn from="Grace" id="U2" channel="C_SHARED" ` +
        `at="${slackTsToIso("171813.200")}">second</turn>`
    );

    const tokenA = posts[0].authorization?.split(" ")[1] ?? "";
    const tokenB = posts[1].authorization?.split(" ")[1] ?? "";
    const [{ payload: payloadA }, { payload: payloadB }] = await Promise.all([
      jwtVerify(tokenA, await importGatekeeperPublicKey(), {
        issuer: "https://gatekeeper.test",
        audience: ENDPOINT,
        algorithms: ["EdDSA"]
      }),
      jwtVerify(tokenB, await importGatekeeperPublicKey(), {
        issuer: "https://gatekeeper.test",
        audience: ENDPOINT,
        algorithms: ["EdDSA"]
      })
    ]);

    expect(payloadA.sub).toBe("remote:7:alpha");
    expect(payloadB.sub).toBe("remote:7:beta");
    expect(payloadA[IDENTITY_CLAIM]).toMatchObject({
      key: "remote:7:alpha",
      name: "alpha",
      kind: "remote",
      workspaceId: 7
    });
    expect(payloadB[IDENTITY_CLAIM]).toMatchObject({
      key: "remote:7:beta",
      name: "beta",
      kind: "remote",
      workspaceId: 7
    });
  });

  it("returns contract_violation when required Task acceptance/id is missing", async () => {
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    const posts: RemotePost[] = [];
    stubRemoteContractViolation(posts);

    const result = await dispatchToAgent(
      {
        name: "remote-bad",
        kind: "remote",
        a2aEndpoint: ENDPOINT,
        tenantId: "main",
        workspaceId: 7
      },
      {
        eventId: "Ev-bad-remote",
        text: "hello",
        channelId: "C1",
        channelName: "general",
        threadTs: "171813.100",
        messageTs: "171813.100",
        user: user("U1"),
        metadata: {
          agentKind: "remote",
          tenant: "main",
          workspaceId: 7
        }
      }
    );

    expect(result.kind).toBe("error_reply");
    if (result.kind === "error_reply") {
      expect(result.text).toContain("required task acknowledgment");
    }
    expect(posts).toHaveLength(1);
  });

  const protocolDispatch = () =>
    dispatchToAgent(
      {
        name: "remote-refuser",
        kind: "remote",
        a2aEndpoint: ENDPOINT,
        tenantId: "main",
        workspaceId: 7
      },
      {
        eventId: "Ev-protocol-remote",
        text: "hello",
        channelId: "C1",
        channelName: "general",
        threadTs: "171813.100",
        messageTs: "171813.100",
        user: user("U1"),
        metadata: {
          agentKind: "remote",
          tenant: "main",
          workspaceId: 7
        }
      }
    );

  it("reports a version mismatch specifically, without throwing", async () => {
    // The migration case: an agent still on A2A v0.3 must be named as such,
    // not retried until it degrades into the generic "unreachable" notice.
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    const posts: RemotePost[] = [];
    stubRemoteRpcError(-32009, posts);

    const result = await protocolDispatch();

    expect(result.kind).toBe("error_reply");
    if (result.kind === "error_reply") {
      expect(result.text).toContain("A2A v1.0");
      expect(result.text).toContain("remote-refuser");
      expect(result.text).toContain("contact the agent developer");
    }
    expect(posts).toHaveLength(1); // sent once — no retry
  });

  it("says a push-less agent cannot be used at all, not 'try again'", async () => {
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    stubRemoteRpcError(-32003, []);

    const result = await protocolDispatch();

    expect(result.kind).toBe("error_reply");
    if (result.kind === "error_reply") {
      expect(result.text).toContain("push notifications");
      expect(result.text).toContain("can't be used with the gatekeeper");
    }
  });

  it("throws on -32603 so the workflow step still retries", async () => {
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    stubRemoteRpcError(-32603, []);

    await expect(protocolDispatch()).rejects.toThrow();
  });
});

describe("buildAgentInstanceKey", () => {
  it("is `{kind}:{workspaceId}:{name}`", () => {
    // Pinned deliberately, because this string is durable state on the *other*
    // side of the wire: it travels as `identity.key` and a remote agent names
    // its Durable Object from it. Any change to the format re-keys every remote
    // agent and their per-caller memory starts empty.
    //
    // It changed exactly once, when `kind` went from `custom` to `remote`,
    // which was affordable only because every agent was being re-registered for
    // the tenant and endpoint changes in the same release. This assertion is
    // here so the next such change is a decision rather than a discovery.
    expect(
      buildAgentInstanceKey({ kind: "remote", workspaceId: 7, name: "alpha" })
    ).toBe("remote:7:alpha");
    expect(
      buildAgentInstanceKey({ kind: "local", workspaceId: 0, name: "admin" })
    ).toBe("local:0:admin");
  });
});

/**
 * The tenant: which agent at an endpoint a dispatch is for.
 *
 * One host serves several agents over one endpoint, so the URL alone does not
 * identify one. Everything here is about the tenant reaching the remote intact
 * and being bound to the token that carries it.
 */
describe("dispatchToAgent (tenant)", () => {
  const dispatchAs = async (tenantId: string, posts: RemotePost[]) => {
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    stubRemote(posts);
    return dispatchToAgent(
      {
        name: "alpha",
        kind: "remote",
        a2aEndpoint: ENDPOINT,
        tenantId,
        workspaceId: 7
      },
      {
        eventId: "Ev-tenant",
        text: "hello",
        channelId: "C1",
        channelName: "general",
        threadTs: "1.1",
        messageTs: "1.1",
        user: user("U1"),
        metadata: {
          agentKind: "remote",
          tenant: "main",
          workspaceId: 7
        }
      }
    );
  };

  it("sends the registered tenant on the request", async () => {
    // Spec §8.3.2: the client must send the tenant the selected interface
    // declared. The remote refuses a request naming none.
    const posts: RemotePost[] = [];
    await dispatchAs("proactive", posts);

    expect(posts.at(-1)?.tenant).toBe("proactive");
  });

  it("binds the same tenant into the gatekeeper token", async () => {
    // The body says which agent; the token says which agent the gatekeeper
    // authorized. If these could disagree, `tenant` would be an unauthenticated
    // field and a token for one agent would work against any sibling — the
    // remote compares them precisely because both share one `aud`.
    const posts: RemotePost[] = [];
    await dispatchAs("proactive", posts);

    const token = posts.at(-1)?.authorization?.replace(/^Bearer /, "") ?? "";
    const claims = decodeJwt(token);
    // Spelled out rather than imported from `TENANT_CLAIM` on purpose, though
    // no longer for the original reason. Both sides now derive this key from
    // `@dynamicagents/g2a-protocol`, so asserting through the constant would no
    // longer let a rename pass while remotes 401 — the rename would reach the
    // remote too.
    //
    // It stays a literal because this is the one *end-to-end* assertion: it
    // reads the token off a real dispatch and checks the bytes on the wire. A
    // unit test proves the minter uses the package; this proves what actually
    // left the building.
    expect(claims["https://dynamicagents.dev/tenant"]).toBe("proactive");
    expect(claims.aud).toBe(ENDPOINT);
  });

  it("posts to the registered endpoint and audiences that same URL", async () => {
    // The two halves of one fact, asserted together on purpose.
    //
    // These used to come from different places: the request went wherever the
    // agent's live card advertised, while `aud` was computed from the string an
    // admin typed at registration. They agreed only when those coincided, so an
    // agent on any path but the guessed one got a correctly-addressed request
    // carrying an audience naming somewhere else — a 401 on every dispatch,
    // from a mismatch neither side could see. Registration resolves the
    // endpoint from the card once; both now read that single stored value.
    //
    // `/api/v2/agent` rather than `/a2a` because a convention that is only ever
    // exercised at its default value is not a convention that has been tested.
    const custom = "https://remote.example.com/api/v2/agent";
    const posts: RemotePost[] = [];
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    stubRemote(posts);

    await dispatchToAgent(
      {
        name: "alpha",
        kind: "remote",
        a2aEndpoint: custom,
        tenantId: "generic",
        workspaceId: 7
      },
      {
        eventId: "Ev-path",
        text: "hello",
        channelId: "C1",
        channelName: "general",
        threadTs: "1.1",
        messageTs: "1.1",
        user: user("U1"),
        metadata: {
          agentKind: "remote",
          tenant: "main",
          workspaceId: 7
        }
      }
    );

    const sent = posts.at(-1);
    expect(sent?.url).toBe(custom);
    const claims = decodeJwt(
      sent?.authorization?.replace(/^Bearer /, "") ?? ""
    );
    expect(claims.aud).toBe(custom);
  });

  it("does not re-download the agent card on every send", async () => {
    // The card is fetched and verified once, at registration, and the endpoint
    // it named is stored. Re-resolving per dispatch would re-read an unverified
    // document, which is what let the POST target drift away from the audience
    // — and it cost a round trip on every turn.
    const gets: string[] = [];
    const posts: RemotePost[] = [];
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    stubRemote(posts, undefined, gets);

    await dispatchToAgent(
      {
        name: "alpha",
        kind: "remote",
        a2aEndpoint: ENDPOINT,
        tenantId: "generic",
        workspaceId: 7
      },
      {
        eventId: "Ev-nofetch",
        text: "hello",
        channelId: "C1",
        channelName: "general",
        threadTs: "1.1",
        messageTs: "1.1",
        user: user("U1"),
        metadata: {
          agentKind: "remote",
          tenant: "main",
          workspaceId: 7
        }
      }
    );

    expect(posts.length).toBe(1);
    expect(gets).toEqual([]);
  });

  it("dispatches a custom agent over HTTP even when its tenant names a built-in", async () => {
    // The escalation guard. `tenantId` is typed by an org admin at
    // registration, so if it alone decided local-vs-remote, registering a
    // remote agent as tenant `admin` would route the call into this gatekeeper's
    // own AdminAgent Durable Object — with the gatekeeper's own tools and
    // permissions. `kind` decides that, and `kind` is never admin-supplied.
    const posts: RemotePost[] = [];
    const result = await dispatchAs("admin", posts);

    // It went out over HTTP: a local dispatch would have contacted nothing.
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.at(-1)?.tenant).toBe("admin");
    expect(posts.at(-1)?.authorization).toMatch(/^Bearer /);
    expect(result.kind).toBe("accepted");
  });
});

describe("cancelAgentTask", () => {
  it("really stops a built-in's turn", async () => {
    // The 🛑 used to drop only a built-in's reply while its turn ran on. Core's
    // host terminates the task's workflow and aborts the turn in flight.
    await setPublicUrl("https://gatekeeper.test");
    await setWorkspaceAdminChannel(0, "C_ORG");
    stubOutbound("https://gatekeeper.test", () => ({ ok: true, ts: "1.2" }));
    const admin = {
      name: "admin",
      kind: "local" as const,
      a2aEndpoint: "http://admin.local",
      tenantId: "admin",
      workspaceId: 0
    };
    const accepted = await dispatchToAgent(admin, {
      eventId: "Ev-stop",
      text: "wait:30",
      channelId: "C_ORG",
      channelName: null,
      threadTs: "1.1",
      messageTs: "1.1",
      user: user("U1"),
      metadata: { agentKind: "local", tenant: "admin" }
    });
    if (accepted.kind !== "accepted") throw new Error("not accepted");

    const out = await cancelAgentTask(admin, accepted.taskId, "C_ORG");
    expect(out.kind).toBe("canceled");
    const host = env.AdminHost.get(env.AdminHost.idFromName("admin:0"));
    expect((await host.getTask(accepted.taskId))?.status.state).toBe(
      TaskState.TASK_STATE_CANCELED
    );
  });

  it("signs a gatekeeper JWT and cancels a remote task", async () => {
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    const posts: RemotePost[] = [];
    stubRemote(posts);

    const out = await cancelAgentTask(
      {
        name: "alpha",
        kind: "remote",
        a2aEndpoint: ENDPOINT,
        tenantId: "main",
        workspaceId: 7
      },
      "task-9",
      "C1"
    );
    expect(out.kind).toBe("canceled");
    expect(posts.at(-1)?.authorization).toMatch(/^Bearer /);
  });
});

// The TTL-timeout continuation: when a HITL prompt expires with no answer, the
// gatekeeper continues the parked task with a HITL_TIMEOUT DataPart so the agent can
// finalize. This exercises sendTaskContinuation against a custom agent over HTTP,
// which the human-answer path (resumeAgentTask) shares.
describe("timeoutAgentTask (remote continuation)", () => {
  const TOKEN = "tok-timeout";
  const TASK_ID = "task-1";
  const CONTEXT_ID = "C1:1700.1";
  const REQUEST_ID = "req-timeout-1";

  // Register a custom (remote) agent, record its dispatched task, and park it on an
  // open HITL prompt — the exact state a timeout sweep continues from. Returns the
  // persisted request row that timeoutAgentTask consumes.
  async function setupParkedRow(): Promise<HitlRequestRow> {
    await registerAgent({
      name: "alpha",
      kind: "remote",
      a2aEndpoint: ENDPOINT,
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: TOKEN,
      taskId: TASK_ID,
      agentName: "alpha",
      channelId: "C1",
      messageTs: "1700.1",
      replyThreadTs: "1700.1",
      eventId: "Ev-timeout"
    });
    // pending → awaiting-input: the task is suspended while the prompt is open.
    await suspendForInput(TOKEN);
    await createHitlRequest({
      requestId: REQUEST_ID,
      token: TOKEN,
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
      agentName: "alpha",
      channelId: "C1",
      threadTs: "1700.1",
      requestKind: "approval",
      promptText: "Proceed?",
      optionsJson: null,
      allowFreeform: false,
      deadlineAt: Math.floor(Date.now() / 1000) - 1
    });
    const row = await getHitlRequest(REQUEST_ID);
    if (!row) throw new Error("failed to seed HITL request row");
    return row;
  }

  beforeEach(async () => {
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
  });

  it("continues the paused task with a timeout DataPart, then un-parks it on accept", async () => {
    const posts: RemotePost[] = [];
    stubRemote(posts);
    const row = await setupParkedRow();

    await timeoutAgentTask(row);

    expect(posts).toHaveLength(1);
    const msg = posts[0].message;
    // Authorized as the signed gatekeeper identity (SYSTEM_CALLER never crosses the
    // remote boundary — only the gatekeeper-agent JWT does).
    expect(posts[0].authorization?.startsWith("Bearer ")).toBe(true);
    // A2A multi-turn: continue the same task on the same thread of conversation.
    expect(msg.taskId).toBe(TASK_ID);
    expect(msg.contextId).toBe(CONTEXT_ID);
    expect(msg.referenceTaskIds).toEqual([TASK_ID]);
    // Deterministic, request-scoped messageId so a retried timeout dedupes at the remote.
    expect(msg.messageId).toBe(`${TOKEN}:t:${REQUEST_ID}`);
    // Carries the HITL timeout signal (human-readable text part + structured data part).
    expect(msg.parts).toEqual([
      textPart("(No response was received within the allotted time.)"),
      dataPart({ type: HITL_TIMEOUT_TYPE, requestId: REQUEST_ID })
    ]);
    // Only routing extras on the wire — no caller/permission context. Both
    // facts travel: where the agent runs, and which agent it is.
    expect(msg.metadata).toEqual({
      agentKind: "remote",
      tenant: "main",
      workspaceId: 0
    });

    // Accepted → the row is un-parked (awaiting-input → pending) so the resumed
    // turn's terminal callback is honored on the same agent_tasks row.
    expect((await getAgentTaskByToken(TOKEN))?.status).toBe("pending");
  });

  it("reuses a stable messageId across an at-least-once retry and only un-parks once", async () => {
    const posts: RemotePost[] = [];
    stubRemote(posts);
    const row = await setupParkedRow();

    await timeoutAgentTask(row);
    await timeoutAgentTask(row); // same timeout redelivered

    expect(posts).toHaveLength(2);
    // Identical id both times → the remote collapses the duplicate rather than
    // appending the timeout turn twice.
    expect(posts[0].message.messageId).toBe(`${TOKEN}:t:${REQUEST_ID}`);
    expect(posts[1].message.messageId).toBe(posts[0].message.messageId);
    // Still pending: the second resumeFromInput is a no-op (already un-parked).
    expect((await getAgentTaskByToken(TOKEN))?.status).toBe("pending");
  });

  it("leaves the task parked and notifies the thread when the remote does not accept the continuation", async () => {
    const posts: RemotePost[] = [];
    const notices: SlackNotice[] = [];
    stubRemoteContractViolation(posts, notices);
    const row = await setupParkedRow();

    await timeoutAgentTask(row);

    expect(posts).toHaveLength(1);
    // No Task ack → resumeFromInput is skipped, so the row stays suspended and a
    // later sweep can retry rather than stranding it as un-parked-but-unresumed.
    expect((await getAgentTaskByToken(TOKEN))?.status).toBe("awaiting-input");
    // The user is told the agent couldn't be reached, so a silently-down agent
    // doesn't leave them staring at a prompt that never resolves.
    expect(notices).toHaveLength(1);
    expect(notices[0].thread_ts).toBe("1700.1");
    expect(notices[0].text).toContain("alpha");
    expect(notices[0].text.toLowerCase()).toContain("unreachable");
  });
});
