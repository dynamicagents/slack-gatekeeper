import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { TaskState, type StreamResponse, type Task } from "@a2a-js/sdk";
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
import { signCallbackJwt } from "@dynamicagents/core/a2a";
import { builtinJwksUrl } from "@/agents/worker";
import { makeKey, signJwt, type TestKey } from "../helpers/auth";
import {
  makeStatusUpdate,
  makeTask as buildTask,
  notificationBody,
  statusEnvelope,
  taskEnvelope
} from "../helpers/a2a";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

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

describe("handleRemoteAgentNotification — a built-in's callback", () => {
  /**
   * The bearer core's task host signs: the built-ins' own `A2A_SIGNING_KEY`,
   * naming the `jku` their card advertises on this origin.
   */
  async function builtinBearer(
    jku = builtinJwksUrl(ISSUER),
    privateJwk = JSON.parse(env.A2A_SIGNING_KEY)
  ): Promise<string> {
    return signCallbackJwt(privateJwk, { jku, aud: AUD });
  }

  async function adminTask(token: string, channelId = "C-admin") {
    await createAgentTask({
      token,
      taskId: `${token}-task`,
      agentName: "admin",
      channelId,
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: `Ev-${token}`
    });
  }

  it("verifies it against this Worker's own key, with no JWKS fetch", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await adminTask("builtin-ok");

    const res = await handleRemoteAgentNotification(
      callbackRequest(
        await builtinBearer(),
        "builtin-ok",
        makeTask("registry updated")
      )
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe("registry updated");
    expect((await getAgentTaskByToken("builtin-ok"))?.status).toBe("completed");
    // `stubFetch` 404s anything but the remote's JWKS and Slack, so a fetch of
    // our own `jku` would have failed the verification above.
  });

  it("refuses one signed by any other key", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await adminTask("builtin-forged");
    const other = await makeKey("not-ours");

    const res = await handleRemoteAgentNotification(
      callbackRequest(
        // Our `jku` and our `kid`, so only the signature is wrong.
        await signJwt(other, {
          kid: JSON.parse(env.A2A_SIGNING_KEY).kid,
          jku: builtinJwksUrl(ISSUER),
          sub: SUB,
          aud: AUD
        }),
        "builtin-forged",
        makeTask("smuggled reply")
      )
    );

    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken("builtin-forged"))?.status).toBe(
      "pending"
    );
  });

  it("refuses one naming a `jku` other than the built-ins' own", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await adminTask("builtin-jku");

    const res = await handleRemoteAgentNotification(
      callbackRequest(
        await builtinBearer(JKU),
        "builtin-jku",
        makeTask("smuggled reply")
      )
    );

    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
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
    await adminTask("admin-ws-token", "C-ws7-admin");

    await handleRemoteAgentNotification(
      callbackRequest(
        await builtinBearer(),
        "admin-ws-token",
        makeTask("registry updated")
      )
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
    await adminTask("admin-plain-token", "C-ws8-admin");

    await handleRemoteAgentNotification(
      callbackRequest(
        await builtinBearer(),
        "admin-plain-token",
        makeTask("registry updated")
      )
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].username).toBe("Admin Agent");
    expect(posts[0].icon_url).toBeUndefined();
  });

  it("sanitizes a built-in's reply before posting (defangs broadcast sequences)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await adminTask("builtin-sanitize");

    // A built-in still relays untrusted model output.
    await handleRemoteAgentNotification(
      callbackRequest(
        await builtinBearer(),
        "builtin-sanitize",
        makeTask("hey <!channel> listen")
      )
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe("hey channel listen");
  });
});
