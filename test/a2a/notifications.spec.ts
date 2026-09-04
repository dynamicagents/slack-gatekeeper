import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { TaskState, type StreamResponse, type Task } from "@a2a-js/sdk";
import {
  InMemoryPushNotificationStore,
  ServerCallContext
} from "@a2a-js/sdk/server";
import { registerAgent } from "@/db/models/agents";
import {
  setPublicUrl,
  setAllowedRemoteAgentDomains,
  setAdminDisplayName,
  setAdminIconUrl
} from "@/db/models/workspace-configs";
import { upsertWorkspace } from "@/db/models/workspaces";
import {
  createAgentTask,
  getAgentTaskByToken,
  completeAgentTask,
  markAgentTaskCanceled
} from "@/db/models/agent-tasks";
import {
  handleRemoteAgentNotification,
  NOTIFICATION_TOKEN_HEADER,
  NOTIFICATIONS_PATH
} from "@/a2a/notifications/remote";
import {
  deliverLocalAgentTask,
  LocalPushNotificationSender,
  localPushNotificationConfig
} from "@/a2a/notifications/local";
import { snapshotOf } from "@/a2a/snapshot";
import { makeKey, signJwt, type TestKey } from "../helpers/auth";
import {
  makeStatusUpdate,
  makeTask as buildTask,
  notificationBody,
  statusEnvelope,
  taskEnvelope
} from "../helpers/a2a";

/**
 * The call context a v1.0 push-notification store/sender is threaded. The
 * gatekeeper's own bridge builds one per request; a `1.0` wire version is what a
 * conformant peer negotiates via the `A2A-Version` header.
 */
const CTX = new ServerCallContext({ requestedVersion: "1.0" });

const JKU = "https://agent.example.com/.well-known/jwks.json";
const KID = "cb1";
const ISSUER = "https://gw.example.com";
const AUD = `${ISSUER}${NOTIFICATIONS_PATH}`;
const SUB = "custom:0:remoteagent";
const NTOK = "ntok-123";

interface SlackPost {
  channel: string;
  text: string;
  thread_ts?: string;
  username?: string;
  icon_url?: string;
}

/** Stub fetch to serve the pinned JWKS and capture Slack chat.postMessage calls. */
function stubFetch(key: TestKey, posts: SlackPost[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === JKU) {
        return new Response(JSON.stringify({ keys: [key.publicJwk] }), {
          status: 200
        });
      }
      if (url.includes("chat.postMessage")) {
        const raw =
          input instanceof Request
            ? await input.clone().text()
            : String(init?.body ?? "");
        const body = new URLSearchParams(raw);
        posts.push({
          channel: body.get("channel") ?? "",
          text: body.get("text") ?? "",
          thread_ts: body.get("thread_ts") ?? undefined,
          username: body.get("username") ?? undefined,
          icon_url: body.get("icon_url") ?? undefined
        });
        return Response.json({ ok: true, ts: "1700.9" });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

/** The gatekeeper's flattened view of a Task, as the local sender would derive it. */
function snapshotOfTask(task: Task) {
  return snapshotOf(taskEnvelope(task));
}

function makeTask(text: string): Task {
  return makeStatusTask(text, {
    state: TaskState.TASK_STATE_COMPLETED,
    messageId: "r1"
  });
}

/** Build a Task callback with an explicit state + status-message id. */
function makeStatusTask(
  text: string,
  opts: { state: TaskState; messageId?: string }
): Task {
  return buildTask({ state: opts.state, text, messageId: opts.messageId });
}

/**
 * A callback request carrying `response` as its body. v1.0 push notifications
 * are the protobuf-JSON of a `StreamResponse`, so the body is produced by the
 * generated encoder rather than hand-written — the same bytes a conformant
 * remote agent would POST.
 */
function envelopeRequest(
  bearer: string,
  token: string,
  response: StreamResponse
): Request {
  return rawCallbackRequest(bearer, token, notificationBody(response));
}

function callbackRequest(bearer: string, token: string, task: Task): Request {
  return envelopeRequest(bearer, token, taskEnvelope(task));
}

function rawCallbackRequest(
  bearer: string,
  token: string,
  body: unknown
): Request {
  return new Request(`${ISSUER}${NOTIFICATIONS_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      [NOTIFICATION_TOKEN_HEADER]: token,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

let key: TestKey;

beforeEach(async () => {
  key = await makeKey(KID);
  // Completing a task row calls signalReactionCollect → REACTION_WORKFLOW.get,
  // which in miniflare probes a never-created workflow instance and emits engine
  // teardown noise ("Engine was never started"). These tests don't assert reaction
  // collection (that's reaction.spec), so stub the binding to a no-op.
  vi.spyOn(env.REACTION_WORKFLOW, "get").mockResolvedValue({
    sendEvent: async () => {}
  } as unknown as WorkflowInstance);
  await registerAgent({
    name: "remoteagent",
    kind: "remote",
    displayName: "Remote",
    a2aEndpoint: "https://agent.example.com/a2a",
    tenantId: "main",
    notifyOn: "mention",
    workspaceId: 0,
    cardSigningJku: JKU,
    cardSigningKid: KID
  });
  await setPublicUrl(ISSUER);
  await setAllowedRemoteAgentDomains(["agent.example.com"]);
  await createAgentTask({
    token: NTOK,
    taskId: "task-1",
    agentName: "remoteagent",
    channelId: "C1",
    messageTs: "1700.1",
    replyThreadTs: null,
    eventId: "Ev1"
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("handleRemoteAgentNotification", () => {
  it("verifies the callback, posts the reply, and completes the task", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("Hello from the agent"))
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      channel: "C1",
      text: "Hello from the agent"
    });
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("posts nothing for an empty reply but still completes (no-reply classification)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("   "))
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("drops a reply that lands after the task was canceled", async () => {
    // A stop — a human's 🛑 or the gatekeeper's processing deadline — ends the task
    // here even if the agent runs on. Its eventual reply must not reach the
    // thread, and the 200 is deliberate: it retires the remote's retry ladder
    // rather than inviting it to keep re-posting a verdict that won't change.
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    await markAgentTaskCanceled(NTOK);

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("Too late — I finished anyway"))
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("canceled");
  });

  it("rejects a callback whose token is signed for the wrong audience", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, {
      jku: JKU,
      sub: SUB,
      aud: "https://evil.test/hook"
    });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("hi"))
    );

    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
    const row = await getAgentTaskByToken(NTOK);
    expect(row?.status).toBe("pending");
    // The reason is captured (still pending) so the reaction backstop can surface it.
    expect(row?.lastError).toContain("signature could not be verified");
  });

  it("rejects a callback signed by a key other than the pinned one", async () => {
    const posts: SlackPost[] = [];
    const attacker = await makeKey(KID); // same kid, different key material
    stubFetch(key, posts); // JWKS still serves the real pinned key
    const bearer = await signJwt(attacker, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("hi"))
    );

    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
  });

  it("400s and records the reason when the body is not a task notification", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const req = new Request(`${ISSUER}${NOTIFICATIONS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        [NOTIFICATION_TOKEN_HEADER]: NTOK,
        "content-type": "application/json"
      },
      body: JSON.stringify({ notAnEnvelope: true })
    });

    const res = await handleRemoteAgentNotification(req);

    expect(res.status).toBe(400);
    expect(posts).toHaveLength(0);
    const row = await getAgentTaskByToken(NTOK);
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("not a valid A2A task notification");
  });

  it("400s a task envelope missing status without reaching delivery", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const req = new Request(`${ISSUER}${NOTIFICATIONS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        [NOTIFICATION_TOKEN_HEADER]: NTOK,
        "content-type": "application/json"
      },
      // A task envelope with no status → would crash on `status.state` if cast.
      body: JSON.stringify({ task: { id: "task-1", contextId: "c1" } })
    });

    const res = await handleRemoteAgentNotification(req);

    expect(res.status).toBe(400);
    expect(posts).toHaveLength(0);
    const row = await getAgentTaskByToken(NTOK);
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("not a valid A2A task notification");
  });

  it("posts an intermediate (non-terminal) update, keeps the task pending, and keeps the 🛑", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      callbackRequest(
        bearer,
        NTOK,
        makeStatusTask("working on it", {
          state: TaskState.TASK_STATE_WORKING,
          messageId: "u1"
        })
      )
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "C1", text: "working on it" });
    const row = await getAgentTaskByToken(NTOK);
    // Row stays pending (🛑 not collected) and the update is recorded for dedup.
    expect(row?.status).toBe("pending");
    expect(row?.receivedMessageIds).toBe("u1");
  });

  it("400s a non-terminal update missing a messageId and records the reason", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    // No status.message → no messageId to deduplicate an at-least-once retry on.
    const noIdTask = buildTask({ state: TaskState.TASK_STATE_WORKING });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, noIdTask)
    );

    expect(res.status).toBe(400);
    expect(posts).toHaveLength(0);
    const row = await getAgentTaskByToken(NTOK);
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("messageId");
  });

  it("dedupes a replayed intermediate update by messageId but posts distinct ones", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    await handleRemoteAgentNotification(
      callbackRequest(
        bearer,
        NTOK,
        makeStatusTask("step one", {
          state: TaskState.TASK_STATE_WORKING,
          messageId: "u1"
        })
      )
    );
    // Same messageId again (at-least-once retry) → not re-posted.
    await handleRemoteAgentNotification(
      callbackRequest(
        bearer,
        NTOK,
        makeStatusTask("step one", {
          state: TaskState.TASK_STATE_WORKING,
          messageId: "u1"
        })
      )
    );
    // Distinct messageId → posted.
    await handleRemoteAgentNotification(
      callbackRequest(
        bearer,
        NTOK,
        makeStatusTask("step two", {
          state: TaskState.TASK_STATE_WORKING,
          messageId: "u2"
        })
      )
    );

    expect(posts.map((p) => p.text)).toEqual(["step one", "step two"]);
    const row = await getAgentTaskByToken(NTOK);
    expect(row?.status).toBe("pending");
    expect((row?.receivedMessageIds ?? "").split(",").sort()).toEqual([
      "u1",
      "u2"
    ]);
  });

  it("posts intermediate updates then completes on the terminal Task", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    await handleRemoteAgentNotification(
      callbackRequest(
        bearer,
        NTOK,
        makeStatusTask("searching…", {
          state: TaskState.TASK_STATE_WORKING,
          messageId: "u1"
        })
      )
    );
    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("final answer"))
    );

    expect(res.status).toBe(200);
    expect(posts.map((p) => p.text)).toEqual(["searching…", "final answer"]);
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("delivers a statusUpdate envelope, the delta form a v1.0 agent streams", async () => {
    // v1.0 push notifications carry a StreamResponse, so a conformant agent may
    // send a `statusUpdate` *delta* rather than a whole Task. It carries the same
    // taskId/contextId/status, so the delivery boundary must treat it the same.
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    await handleRemoteAgentNotification(
      envelopeRequest(
        bearer,
        NTOK,
        statusEnvelope(
          makeStatusUpdate({
            state: TaskState.TASK_STATE_WORKING,
            text: "thinking…",
            messageId: "u1"
          })
        )
      )
    );
    const res = await handleRemoteAgentNotification(
      envelopeRequest(
        bearer,
        NTOK,
        statusEnvelope(
          makeStatusUpdate({
            state: TaskState.TASK_STATE_COMPLETED,
            text: "all done",
            messageId: "u2"
          })
        )
      )
    );

    expect(res.status).toBe(200);
    expect(posts.map((p) => p.text)).toEqual(["thinking…", "all done"]);
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("ignores an artifactUpdate envelope, which advances no task lifecycle", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      rawCallbackRequest(bearer, NTOK, {
        artifactUpdate: {
          taskId: "task-1",
          contextId: "c1",
          artifact: { artifactId: "a1", parts: [{ text: "chunk" }] }
        }
      })
    );

    // Rejected rather than silently accepted: nothing about the task's state
    // changed, so there is no snapshot to deliver and the row stays pending.
    expect(res.status).toBe(400);
    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("pending");
  });

  it("refuses to deliver a task belonging to a different built-in", async () => {
    // The only thing standing between the two local Durable Objects. These
    // callbacks carry no JWT — they never leave the isolate — so this check is
    // the whole trust boundary on the local path, and the onboarding DO calling
    // `deliverLocalAgentTask` with the admin's token has to be refused.
    //
    // It compares `tenantId` and not `kind`, for a reason this suite has to
    // encode: both built-ins are `kind: "local"` now, so the old comparison
    // would read `"local" !== "local"` — vacuously false, letting either agent
    // complete the other's tasks while the guard still looked present.
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await registerAgent({
      name: "adminvictim",
      kind: "local",
      displayName: "Admin Victim",
      a2aEndpoint: "https://agent.local/a2a",
      tenantId: "admin",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "victim-token",
      taskId: "victim-task",
      agentName: "adminvictim",
      channelId: "C-victim",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev-victim"
    });

    await expect(
      deliverLocalAgentTask(
        "victim-token",
        snapshotOfTask(makeTask("impersonated reply"))!,
        // The onboarding DO passing its own tenant; the task is the admin's.
        "onboarding"
      )
    ).rejects.toThrow(/does not belong to the expected built-in agent/);

    // Nothing reached Slack, and the task is still open for its real owner.
    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken("victim-token"))?.status).not.toBe(
      "completed"
    );
  });

  it("delivers a trusted local built-in Task without accepting it on the public callback", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await registerAgent({
      name: "adminlocal",
      kind: "local",
      displayName: "Admin Local",
      a2aEndpoint: "https://agent.local/a2a",
      tenantId: "admin",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "local-token",
      taskId: "local-task",
      agentName: "adminlocal",
      channelId: "C-local",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev-local"
    });

    await deliverLocalAgentTask(
      "local-token",
      snapshotOfTask(
        makeStatusTask("checking that", {
          state: TaskState.TASK_STATE_WORKING,
          messageId: "u1"
        })
      )!,
      "admin"
    );
    await deliverLocalAgentTask(
      "local-token",
      snapshotOfTask(makeTask("Here is the answer"))!,
      "admin"
    );

    expect(posts.map((post) => post.text)).toEqual([
      "checking that",
      "Here is the answer"
    ]);
    expect((await getAgentTaskByToken("local-token"))?.status).toBe(
      "completed"
    );
  });

  it("renders the admin under its per-workspace avatar and display name", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    // The real admin: one shared registry row (no icon, seeded display name)
    // whose identity lives per workspace in workspace_configs.
    await upsertWorkspace({
      id: 7,
      name: "ws7",
      adminChannelId: "C-ws7-admin"
    });
    await setAdminDisplayName(7, "Ops Bot");
    await setAdminIconUrl(7, "https://gw.example.com/icons/7/admin/abc123.jpg");
    await createAgentTask({
      token: "admin-ws-token",
      taskId: "admin-ws-task",
      agentName: "admin",
      channelId: "C-ws7-admin",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev-admin-ws"
    });

    await deliverLocalAgentTask(
      "admin-ws-token",
      snapshotOfTask(makeTask("registry updated"))!,
      "admin"
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].username).toBe("Ops Bot");
    expect(posts[0].icon_url).toBe(
      "https://gw.example.com/icons/7/admin/abc123.jpg"
    );
  });

  it("falls back to the admin registry row when the workspace set no avatar", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await upsertWorkspace({
      id: 8,
      name: "ws8",
      adminChannelId: "C-ws8-admin"
    });
    await createAgentTask({
      token: "admin-plain-token",
      taskId: "admin-plain-task",
      agentName: "admin",
      channelId: "C-ws8-admin",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev-admin-plain"
    });

    await deliverLocalAgentTask(
      "admin-plain-token",
      snapshotOfTask(makeTask("registry updated"))!,
      "admin"
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].username).toBe("Admin Agent");
    expect(posts[0].icon_url).toBeUndefined();
  });

  it("sanitizes a local built-in reply before posting (defangs broadcast sequences)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await registerAgent({
      name: "adminsanitize",
      kind: "local",
      displayName: "Admin Sanitize",
      a2aEndpoint: "https://agent.local/a2a",
      tenantId: "admin",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "local-sanitize-token",
      taskId: "local-sanitize-task",
      agentName: "adminsanitize",
      channelId: "C-local",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev-local-sanitize"
    });

    // A built-in agent still relays untrusted model output — the reply is
    // sanitized before it reaches Slack, just like a remote agent's.
    await deliverLocalAgentTask(
      "local-sanitize-token",
      snapshotOfTask(makeTask("hey <!channel> listen"))!,
      "admin"
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe("hey channel listen");
  });

  it("rejects a built-in agent's token on the public remote callback (401, nothing posted)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await registerAgent({
      name: "adminpublic",
      kind: "local",
      displayName: "Admin Public",
      a2aEndpoint: "https://agent.local/a2a",
      tenantId: "admin",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "local-public-token",
      taskId: "local-public-task",
      agentName: "adminpublic",
      channelId: "C-local",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev-local-public"
    });

    // A built-in agent's task must never be completable through the public HTTP
    // callback — it is delivered in-process. The kind check rejects it before any
    // signature verification or Slack post, even with a bearer present.
    const res = await handleRemoteAgentNotification(
      callbackRequest(
        "any-bearer",
        "local-public-token",
        makeTask("smuggled reply")
      )
    );

    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
    const row = await getAgentTaskByToken("local-public-token");
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("delivered internally");
  });

  it("suppresses a submitted local Task even when it includes text", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await registerAgent({
      name: "adminsender",
      kind: "local",
      displayName: "Admin Sender",
      a2aEndpoint: "https://agent.local/a2a",
      tenantId: "admin",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "local-sender-token",
      taskId: "local-sender-task",
      agentName: "adminsender",
      channelId: "C-local",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev-local-sender"
    });

    const store = new InMemoryPushNotificationStore();
    await store.save(
      "local-sender-task",
      CTX,
      localPushNotificationConfig("local-sender-token")
    );
    const sender = new LocalPushNotificationSender(store, "admin");

    const forSender = (text: string, state: TaskState, messageId: string) =>
      taskEnvelope({
        ...makeStatusTask(text, { state, messageId }),
        id: "local-sender-task"
      });

    await sender.send(
      forSender(
        "acceptance text",
        TaskState.TASK_STATE_SUBMITTED,
        "submitted-message"
      ),
      CTX
    );
    await sender.send(
      forSender(
        "working update",
        TaskState.TASK_STATE_WORKING,
        "working-message"
      ),
      CTX
    );

    expect(posts.map((post) => post.text)).toEqual(["working update"]);
  });

  it("delivers a statusUpdate envelope from the SDK's event processor", async () => {
    // The SDK hands the sender whatever StreamResponse shape the executor's
    // event produced: a `task` for the opening acceptance, then `statusUpdate`
    // deltas for everything after. Both must reach the delivery boundary.
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await registerAgent({
      name: "admindelta",
      kind: "local",
      displayName: "Admin Delta",
      a2aEndpoint: "https://agent.local/a2a",
      tenantId: "admin",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "delta-token",
      taskId: "delta-task",
      agentName: "admindelta",
      channelId: "C-local",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev-delta"
    });

    const store = new InMemoryPushNotificationStore();
    await store.save(
      "delta-task",
      CTX,
      localPushNotificationConfig("delta-token")
    );
    const sender = new LocalPushNotificationSender(store, "admin");

    const barrier = sender.whenSettled("delta-task");
    await sender.send(
      statusEnvelope(
        makeStatusUpdate({
          id: "delta-task",
          state: TaskState.TASK_STATE_COMPLETED,
          text: "delta reply",
          messageId: "d1"
        })
      ),
      CTX
    );

    await expect(barrier).resolves.toBeUndefined();
    expect(posts.map((post) => post.text)).toEqual(["delta reply"]);
    expect((await getAgentTaskByToken("delta-token"))?.status).toBe(
      "completed"
    );
  });

  it("surfaces a gatekeeper notice and completes on a terminal failure with no text", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const failed = buildTask({ state: TaskState.TASK_STATE_FAILED });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, failed)
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("ended without a reply (state: failed)");
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("marks a terminal failure that carries the agent's own text", async () => {
    // A2A v1.0 gives a failing task no structured error, so its explanation is
    // prose in `status.message` — shaped identically to a successful reply.
    // Without the marker this renders as a normal answer.
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const failed = buildTask({
      state: TaskState.TASK_STATE_FAILED,
      text: "Sorry, I hit an unexpected error.",
      messageId: "f1"
    });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, failed)
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("⚠️");
    expect(posts[0].text).toContain("(failed)");
    expect(posts[0].text).toContain("Sorry, I hit an unexpected error.");
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("marks a terminal `rejected` distinctly from `failed`", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const rejected = buildTask({
      state: TaskState.TASK_STATE_REJECTED,
      text: "I won't do that.",
      messageId: "r1"
    });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, rejected)
    );

    expect(res.status).toBe(200);
    expect(posts[0].text).toContain("(rejected)");
    expect(posts[0].text).toContain("I won't do that.");
  });

  it("leaves a successful reply completely unmarked", async () => {
    // The regression that matters most: the marker must never leak onto the
    // normal path, even for text that reads like an apology.
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const completed = buildTask({
      state: TaskState.TASK_STATE_COMPLETED,
      text: "Sorry, I hit an unexpected error.",
      messageId: "c1"
    });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, completed)
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe("Sorry, I hit an unexpected error.");
  });

  it("does not mark a `canceled` task that carries text", async () => {
    // `canceled` is an outcome the user chose, not a failure to explain — the
    // cancel workflow already posted "🛑 Stopped."
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const canceled = buildTask({
      state: TaskState.TASK_STATE_CANCELED,
      text: "partial work",
      messageId: "x1"
    });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, canceled)
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe("partial work");
  });

  it("stays silent on a terminal `canceled` with no text", async () => {
    // The counterpart of the failure notice above: a stop is an outcome the user
    // chose, and the cancel workflow already posted "🛑 Stopped." A notice here
    // would contradict it. The row still completes so the 🛑 can be collected.
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const canceled = buildTask({ state: TaskState.TASK_STATE_CANCELED });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, canceled)
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("404s an unknown notification token", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, "nope", makeTask("hi"))
    );
    expect(res.status).toBe(404);
    expect(posts).toHaveLength(0);
  });

  it("is a no-op on a task already completed (replay/duplicate callback)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await completeAgentTask(NTOK); // pretend a prior callback already ran
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("hi"))
    );
    expect(res.status).toBe(200);
    expect(posts).toHaveLength(0);
  });

  it("401s a request missing credentials", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const req = new Request(`${ISSUER}${NOTIFICATIONS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeTask("hi"))
    });
    const res = await handleRemoteAgentNotification(req);
    expect(res.status).toBe(401);
  });
});

describe("LocalPushNotificationSender.whenSettled (accept-first liveness barrier)", () => {
  /** True while `p` hasn't resolved within a short real-time window. */
  async function isPending(p: Promise<unknown>): Promise<boolean> {
    const PENDING = Symbol("pending");
    const outcome = await Promise.race([
      p.then(() => "resolved" as const),
      new Promise<typeof PENDING>((res) => setTimeout(() => res(PENDING), 25))
    ]);
    return outcome === PENDING;
  }

  /** Register an admin agent + ledger rows and wire a sender that knows each task. */
  async function makeSender(
    agentName: string,
    tasks: { token: string; taskId: string }[]
  ): Promise<LocalPushNotificationSender> {
    await registerAgent({
      name: agentName,
      kind: "local",
      displayName: "Admin Bar",
      a2aEndpoint: "https://agent.local/a2a",
      tenantId: "admin",
      notifyOn: "mention",
      workspaceId: 0
    });
    const store = new InMemoryPushNotificationStore();
    for (const t of tasks) {
      await createAgentTask({
        token: t.token,
        taskId: t.taskId,
        agentName,
        channelId: "C-bar",
        messageTs: "1700.1",
        replyThreadTs: null,
        eventId: `Ev-${t.token}`
      });
      await store.save(t.taskId, CTX, localPushNotificationConfig(t.token));
    }
    return new LocalPushNotificationSender(store, "admin");
  }

  /** A snapshot for `taskId` in `state`, carrying `text` under a state-scoped id. */
  function taskFor(taskId: string, state: TaskState, text = "reply"): Task {
    return {
      ...makeStatusTask(text, { state, messageId: `${taskId}:${state}` }),
      id: taskId
    };
  }

  it("stays pending across submitted/working, resolves after the terminal delivery", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const sender = await makeSender("admin-flow", [
      { token: "flow-tok", taskId: "flow-task" }
    ]);

    const barrier = sender.whenSettled("flow-task");
    await sender.send(
      taskEnvelope(
        taskFor("flow-task", TaskState.TASK_STATE_SUBMITTED, "accepting")
      ),
      CTX
    );
    await sender.send(
      taskEnvelope(
        taskFor("flow-task", TaskState.TASK_STATE_WORKING, "working on it")
      ),
      CTX
    );
    expect(await isPending(barrier)).toBe(true);

    await sender.send(
      taskEnvelope(
        taskFor("flow-task", TaskState.TASK_STATE_COMPLETED, "final answer")
      ),
      CTX
    );
    await expect(barrier).resolves.toBeUndefined();
    expect(posts.map((p) => p.text)).toEqual(["working on it", "final answer"]);
    expect((await getAgentTaskByToken("flow-tok"))?.status).toBe("completed");
  });

  it("resolves after an input-required delivery (a HITL park ends the turn)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const sender = await makeSender("admin-park", [
      { token: "park-tok", taskId: "park-task" }
    ]);

    const barrier = sender.whenSettled("park-task");
    await sender.send(
      taskEnvelope(
        taskFor("park-task", TaskState.TASK_STATE_WORKING, "one moment")
      ),
      CTX
    );
    expect(await isPending(barrier)).toBe(true);

    // A parked (input-required) snapshot is the last activity in this isolate — the
    // human answers on a later, separate invocation — so the barrier must release
    // rather than idle to the 8-minute safety timeout.
    await sender.send(
      taskEnvelope(
        taskFor("park-task", TaskState.TASK_STATE_INPUT_REQUIRED, "need input")
      ),
      CTX
    );
    await expect(barrier).resolves.toBeUndefined();
  });

  it("resolves on a terminal canceled even though nothing is posted", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const sender = await makeSender("admin-cxl", [
      { token: "cxl-tok", taskId: "cxl-task" }
    ]);

    const barrier = sender.whenSettled("cxl-task");
    await sender.send(
      taskEnvelope({
        ...taskFor("cxl-task", TaskState.TASK_STATE_CANCELED),
        // A terminal `canceled` with no status message at all: nothing to post,
        // but the liveness barrier must still release.
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: undefined
        }
      }),
      CTX
    );
    await expect(barrier).resolves.toBeUndefined();
    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken("cxl-tok"))?.status).toBe("completed");
  });

  it("resolves even when the terminal delivery fails after retries", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    // Sender expects "admin" but the registry row is onboarding-kind → deliver
    // throws (a non-validation error), exhausts retries, and records the failure.
    // The barrier must still resolve so ctx.waitUntil can never hang.
    await registerAgent({
      name: "mismatch",
      kind: "local",
      displayName: "Mismatch",
      a2aEndpoint: "https://agent.local/a2a",
      tenantId: "onboarding",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "mis-tok",
      taskId: "mis-task",
      agentName: "mismatch",
      channelId: "C-bar",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev-mis"
    });
    const store = new InMemoryPushNotificationStore();
    await store.save("mis-task", CTX, localPushNotificationConfig("mis-tok"));
    const sender = new LocalPushNotificationSender(store, "admin");

    const barrier = sender.whenSettled("mis-task");
    await sender.send(
      taskEnvelope(
        taskFor("mis-task", TaskState.TASK_STATE_COMPLETED, "unreachable")
      ),
      CTX
    );
    await expect(barrier).resolves.toBeUndefined();
    expect((await getAgentTaskByToken("mis-tok"))?.lastError).toBeTruthy();
  }, 10_000);

  it("tracks two task ids independently", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const sender = await makeSender("admin-multi", [
      { token: "a-tok", taskId: "a-task" },
      { token: "b-tok", taskId: "b-task" }
    ]);

    const a = sender.whenSettled("a-task");
    const b = sender.whenSettled("b-task");
    await sender.send(
      taskEnvelope(taskFor("a-task", TaskState.TASK_STATE_COMPLETED, "done A")),
      CTX
    );
    await expect(a).resolves.toBeUndefined();
    expect(await isPending(b)).toBe(true);
  });

  it("resolves immediately when called after the terminal already settled", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const sender = await makeSender("admin-late", [
      { token: "late-tok", taskId: "late-task" }
    ]);

    await sender.send(
      taskEnvelope(
        taskFor("late-task", TaskState.TASK_STATE_COMPLETED, "answer")
      ),
      CTX
    );
    // Let the terminal delivery's .finally() record the settle.
    await new Promise((r) => setTimeout(r, 15));
    await expect(sender.whenSettled("late-task")).resolves.toBeUndefined();
  });

  it("resolves via the safety timeout if no terminal is ever published", async () => {
    vi.useFakeTimers();
    try {
      const sender = new LocalPushNotificationSender(
        new InMemoryPushNotificationStore(),
        "admin"
      );
      const barrier = sender.whenSettled("orphan-task");
      // Fire the safety timer regardless of its configured duration; awaiting the
      // barrier proves it resolved (the test would otherwise hang, not race a flag).
      await vi.runAllTimersAsync();
      await expect(barrier).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
