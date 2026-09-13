import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { TaskState } from "@a2a-js/sdk";
import { registerAgent, getAgent } from "@/db/models/agents";
import {
  completeAgentTask,
  createAgentTask,
  getAgentTaskByToken
} from "@/db/models/agent-tasks";
import { getHitlRequest } from "@/db/models/hitl-requests";
import { deliverTaskToSlack } from "@/a2a/notifications/shared";
import { TASK_ENDED_NOTE } from "@/a2a/notifications/hitl";
import { HITL_REQUEST_TYPE } from "@/a2a/hitl";
import { dataPart, textPart } from "@/a2a/parts";
import type { TaskSnapshot } from "@/a2a/snapshot";
import { makeSnapshot } from "../helpers/a2a";

interface SlackPost {
  method: string;
  channel: string;
  text: string;
  blocks?: string;
  thread_ts?: string;
  ts?: string;
}

/**
 * Record Slack posts and updates. `failReplies` makes every plain (block-less)
 * post fail, the way a Slack outage fails an agent's final reply.
 */
function stubFetch(posts: SlackPost[], opts: { failReplies?: boolean } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = ["chat.postMessage", "chat.update"].find((m) =>
        url.includes(m)
      );
      if (method) {
        const raw =
          input instanceof Request
            ? await input.clone().text()
            : String(init?.body ?? "");
        const body = new URLSearchParams(raw);
        const post: SlackPost = {
          method,
          channel: body.get("channel") ?? "",
          text: body.get("text") ?? "",
          blocks: body.get("blocks") ?? undefined,
          thread_ts: body.get("thread_ts") ?? undefined,
          ts: body.get("ts") ?? undefined
        };
        if (opts.failReplies && method === "chat.postMessage" && !post.blocks) {
          return Response.json({ ok: false, error: "internal_error" });
        }
        posts.push(post);
        return Response.json({ ok: true, ts: "1700.9" });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

function hitlTask(
  requestId: string,
  opts: { state?: TaskState; withDataPart?: boolean } = {}
): TaskSnapshot {
  const fallback = textPart("Proceed with deletion?");
  const request = dataPart({
    type: HITL_REQUEST_TYPE,
    requestId,
    requestKind: "approval",
    prompt: "Proceed with deletion?"
  });
  return makeSnapshot({
    id: "task-1",
    contextId: "C1:1700.1",
    state: opts.state ?? TaskState.TASK_STATE_INPUT_REQUIRED,
    messageId: `${requestId}:u1`,
    parts: opts.withDataPart === false ? [fallback] : [fallback, request]
  });
}

beforeEach(async () => {
  // A final status completes the row, which signals the ReactionWorkflow — an
  // instance these tests never create, so miniflare emits engine noise. Nothing
  // here asserts the 🛑's lifetime (that's reaction.spec), so stub the binding.
  vi.spyOn(env.REACTION_WORKFLOW, "get").mockResolvedValue({
    sendEvent: async () => {}
  } as unknown as WorkflowInstance);
  await registerAgent({
    name: "remoteagent",
    kind: "remote",
    a2aEndpoint: "https://agent.example.com/a2a",
    tenantId: "main",
    notifyOn: "mention",
    workspaceId: 0
  });
  await createAgentTask({
    token: "tok-del",
    taskId: "task-1",
    agentName: "remoteagent",
    channelId: "C1",
    messageTs: "1700.1",
    replyThreadTs: "1700.1",
    eventId: "Ev1"
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function deliver(snapshot: TaskSnapshot) {
  const row = await getAgentTaskByToken("tok-del");
  const agent = await getAgent("remoteagent");
  await deliverTaskToSlack("tok-del", row!, agent!, snapshot);
}

describe("deliverTaskToSlack — HITL input-required branch", () => {
  it("renders a Block Kit prompt, persists the request, and parks the task", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);

    await deliver(hitlTask("req-del-1"));

    // Posted an interactive (blocks) message into the thread.
    expect(posts).toHaveLength(1);
    expect(posts[0].blocks).toBeTruthy();
    // The action ids embed the requestId (that is the interaction correlation key).
    expect(posts[0].blocks).toContain("req-del-1");
    expect(posts[0].thread_ts).toBe("1700.1");

    // Persisted the request, awaiting an answer, with the Slack ts recorded.
    const req = await getHitlRequest("req-del-1");
    expect(req?.status).toBe("awaiting");
    expect(req?.taskId).toBe("task-1");
    expect(req?.contextId).toBe("C1:1700.1");
    expect(req?.slackMessageTs).toBe("1700.9");

    // Parked the paired task row (non-terminal, not drained).
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe(
      "awaiting-input"
    );
  });

  it("does not double-post on an at-least-once redelivery", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(hitlTask("req-del-2"));
    await deliver(hitlTask("req-del-2")); // same requestId redelivered
    expect(posts).toHaveLength(1);
  });

  it("does not post a prompt when the task completed concurrently", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);

    // A stale snapshot: the delivery boundary reads `row` (still pending) before
    // dispatching, then a terminal callback or 🛑 completes the task before this
    // input-required update parks it. `suspendForInput` no-ops against the now
    // completed row, so posting would strand a prompt whose answer can't resume.
    const staleRow = await getAgentTaskByToken("tok-del");
    await completeAgentTask("tok-del");

    const agent = await getAgent("remoteagent");
    await deliverTaskToSlack(
      "tok-del",
      staleRow!,
      agent!,
      hitlTask("req-race")
    );

    // No interactive prompt for a task that can no longer be resumed.
    expect(posts).toHaveLength(0);
    // The task stays terminal — the park was a no-op.
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe("completed");
    // And the request is closed, not left `awaiting` for the expiry sweep to send
    // a timeout onto a task that is already over.
    expect((await getHitlRequest("req-race"))?.status).toBe("canceled");
  });

  it("leaves an earlier prompt open when a second one fails to park", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(hitlTask("req-first"));

    // The park fails here because the task is already parked, not because it is
    // over — so the question it is parked on still stands.
    await deliver(hitlTask("req-second"));

    expect((await getHitlRequest("req-first"))?.status).toBe("awaiting");
    expect(posts.filter((p) => p.method === "chat.update")).toHaveLength(0);
  });

  it("falls back to a plain reply for input-required without a HITL DataPart", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(hitlTask("req-none", { withDataPart: false }));

    // Posted as a normal reply (no blocks), and the row stays pending — no HITL row.
    expect(posts).toHaveLength(1);
    expect(posts[0].blocks).toBeUndefined();
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe("pending");
  });
});

describe("deliverTaskToSlack — a final status closes the task's open prompt", () => {
  it.each([
    ["completed", TaskState.TASK_STATE_COMPLETED],
    ["failed", TaskState.TASK_STATE_FAILED],
    ["canceled", TaskState.TASK_STATE_CANCELED],
    ["rejected", TaskState.TASK_STATE_REJECTED]
  ])("closes it and strips its buttons when %s", async (_label, state) => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(hitlTask("req-final"));

    // The agent stopped waiting on the question and ended the task itself.
    await deliver(
      makeSnapshot({ id: "task-1", state, text: "Gave up.", messageId: "f1" })
    );

    expect((await getHitlRequest("req-final"))?.status).toBe("canceled");
    const updates = posts.filter((p) => p.method === "chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0].ts).toBe("1700.9");
    expect(updates[0].text).toBe(TASK_ENDED_NOTE);
    expect(updates[0].blocks).not.toContain("req-final");
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe("completed");
  });

  it("closes it before the task goes terminal, so a failed reply is retried", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(hitlTask("req-retry"));
    const final = makeSnapshot({
      id: "task-1",
      state: TaskState.TASK_STATE_FAILED,
      text: "No answer came.",
      messageId: "f1"
    });

    // The final reply fails to post, so the delivery throws with the row still
    // open — which is what lets the agent's retry through the boundary at all.
    stubFetch(posts, { failReplies: true });
    await expect(deliver(final)).rejects.toThrow();
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe(
      "awaiting-input"
    );
    expect((await getHitlRequest("req-retry"))?.status).toBe("canceled");

    // The retry posts the reply and completes, without editing the prompt again.
    stubFetch(posts);
    await deliver(final);
    expect(posts.filter((p) => p.method === "chat.update")).toHaveLength(1);
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe("completed");
  });

  it("leaves the prompt open on an update that is not final", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(hitlTask("req-open"));

    await deliver(
      makeSnapshot({
        id: "task-1",
        state: TaskState.TASK_STATE_WORKING,
        text: "Still thinking.",
        messageId: "w1"
      })
    );

    expect((await getHitlRequest("req-open"))?.status).toBe("awaiting");
    expect(posts.filter((p) => p.method === "chat.update")).toHaveLength(0);
  });
});
