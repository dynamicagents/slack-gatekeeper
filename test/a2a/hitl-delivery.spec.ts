import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { TaskState } from "@a2a-js/sdk";
import { registerAgent, getAgent } from "@/db/models/agents";
import {
  completeAgentTask,
  createAgentTask,
  getAgentTaskByToken,
  resumeFromInput,
  STARTED_BY_PROCESS,
  STARTED_BY_UNKNOWN
} from "@/db/models/agent-tasks";
import { claimHitlAnswer, getHitlForm } from "@/db/models/hitl-forms";
import { deliverTaskToSlack } from "@/a2a/notifications/shared";
import {
  closeOpenHitlPrompts,
  TASK_ENDED_NOTE
} from "@/a2a/notifications/hitl";
import { REACTION_SYNC_EVENT } from "@/workflows/reaction-helpers";
import { HITL_APPROVE_OPTION_ID } from "@/a2a/hitl";
import { dataPart, textPart } from "@/a2a/parts";
import type { TaskSnapshot } from "@/a2a/snapshot";
import { makeSnapshot } from "../helpers/a2a";
import { useStorageReset } from "../helpers/storage";
import { approvalForm, choiceForm } from "../helpers/hitl";

useStorageReset();

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
function stubFetch(
  posts: SlackPost[],
  opts: { failReplies?: boolean; onPrompt?: () => Promise<void> } = {}
) {
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
        if (method === "chat.postMessage" && post.blocks)
          await opts.onPrompt?.();
        posts.push(post);
        return Response.json({ ok: true, ts: "1700.9" });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

function hitlTask(
  requestId: string,
  opts: { state?: TaskState; withDataPart?: boolean; messageId?: string } = {}
): TaskSnapshot {
  const fallback = textPart("Proceed with deletion?");
  const request = dataPart(choiceForm(requestId, "Proceed with deletion?"));
  return makeSnapshot({
    id: "task-1",
    contextId: "C1:1700.1",
    state: opts.state ?? TaskState.TASK_STATE_INPUT_REQUIRED,
    messageId: opts.messageId ?? `${requestId}:u1`,
    parts: opts.withDataPart === false ? [fallback] : [fallback, request]
  });
}

/** The same, asking a person to approve something rather than to pick. */
function approvalTask(requestId: string): TaskSnapshot {
  return makeSnapshot({
    id: "task-1",
    contextId: "C1:1700.1",
    state: TaskState.TASK_STATE_INPUT_REQUIRED,
    messageId: `${requestId}:u1`,
    parts: [textPart("Approve the plan?"), dataPart(approvalForm(requestId))]
  });
}

/** Who started the task every test here delivers for, and who else is around. */
const STARTER = "U1";
const OTHER = "U2";

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
    eventId: "Ev1",
    startedBy: STARTER
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
    const req = await getHitlForm("req-del-1");
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
    expect((await getHitlForm("req-race"))?.status).toBe("canceled");
  });

  it("posts a second prompt while the first is open, each its own form", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    // Asked while the agent works: shown at once, and the clock keeps running.
    await deliver(
      hitlTask("req-first", { state: TaskState.TASK_STATE_WORKING })
    );
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe("pending");

    // Asked once it is idle: shown, and the row parks.
    await deliver(hitlTask("req-second"));

    expect((await getHitlForm("req-first"))?.status).toBe("awaiting");
    expect((await getHitlForm("req-second"))?.status).toBe("awaiting");
    const prompts = posts.filter((p) => p.blocks);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].blocks).toContain("req-first");
    expect(prompts[1].blocks).toContain("req-second");
    expect(posts.filter((p) => p.method === "chat.update")).toHaveLength(0);
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe(
      "awaiting-input"
    );
  });

  it("parks on input-required without a HITL DataPart, posting its prose as a reply", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(hitlTask("req-none", { withDataPart: false }));

    // Posted as a normal reply (no blocks), with no form behind it: whoever
    // answers replies in the thread, which joins the task.
    expect(posts).toHaveLength(1);
    expect(posts[0].blocks).toBeUndefined();
    expect(await getHitlForm("req-none")).toBeNull();
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe(
      "awaiting-input"
    );
  });

  it("parks on an input-required with nothing to say, posting nothing", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(
      makeSnapshot({
        id: "task-1",
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        text: "",
        messageId: "idle-1"
      })
    );

    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe(
      "awaiting-input"
    );
  });

  it("parks once a form it already showed comes back on input-required", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(
      hitlTask("req-again", {
        state: TaskState.TASK_STATE_WORKING,
        messageId: "w-ask"
      })
    );
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe("pending");

    await deliver(hitlTask("req-again", { messageId: "w-idle" }));

    expect(posts.filter((p) => p.blocks)).toHaveLength(1);
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe(
      "awaiting-input"
    );
  });

  it("does not park again on an input-required redelivered after the task resumed", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    const idle = makeSnapshot({
      id: "task-1",
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
      text: "",
      messageId: "idle-again"
    });
    await deliver(idle);
    // An answer or a joined message resumed it.
    expect(await resumeFromInput("tok-del")).toBe("Ev1");

    await deliver(idle);

    expect((await getAgentTaskByToken("tok-del"))?.status).toBe("pending");
  });

  it("closes a prompt whose task ended while it posted", async () => {
    const posts: SlackPost[] = [];
    // The task's final status lands mid-post, before the prompt has a message
    // the closing could update.
    stubFetch(posts, {
      onPrompt: async () => {
        await closeOpenHitlPrompts("tok-del", TASK_ENDED_NOTE);
        await completeAgentTask("tok-del");
      }
    });

    await deliver(hitlTask("req-raced"));

    expect((await getHitlForm("req-raced"))?.status).toBe("canceled");
    const updates = posts.filter((p) => p.method === "chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0].ts).toBe("1700.9");
    expect(updates[0].text).toBe(TASK_ENDED_NOTE);
  });

  it("ends the budget's leg where it parks", async () => {
    const signals: unknown[] = [];
    vi.spyOn(env.REACTION_WORKFLOW, "get").mockResolvedValue({
      sendEvent: async (event: unknown) => {
        signals.push(event);
      }
    } as unknown as WorkflowInstance);
    stubFetch([]);

    await deliver(hitlTask("req-leg"));

    expect(signals).toEqual([{ type: REACTION_SYNC_EVENT, payload: {} }]);
  });

  it("keeps a parked row parked through a late progress line", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(hitlTask("req-parked"));

    // Written while the agent still worked, delivered after it went idle.
    await deliver(
      makeSnapshot({
        id: "task-1",
        state: TaskState.TASK_STATE_WORKING,
        text: "Reading the logs.",
        messageId: "w-late"
      })
    );

    expect(posts.filter((p) => !p.blocks)).toHaveLength(0);
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe(
      "awaiting-input"
    );
    expect((await getHitlForm("req-parked"))?.status).toBe("awaiting");
  });
});

/**
 * The approval reaches the person who asked for the work: the prompt mentions
 * whoever started the task, from the trusted Slack event's user id carried on
 * the task row since dispatch — never from the agent's own form. This is the
 * delivery path both kinds of agent share: a built-in's in-process push and a
 * remote's authenticated callback both arrive at `deliverTaskToSlack`.
 */
describe("deliverTaskToSlack — an approval tags whoever started the task", () => {
  it("mentions them in the prompt's blocks and in its notification text", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);

    await deliver(approvalTask("req-ap-1"));

    expect(posts).toHaveLength(1);
    // In the blocks, which is what Slack notifies on...
    expect(posts[0].blocks).toContain(`<@${STARTER}>`);
    // ...and in the fallback text, which is what a mobile notification reads.
    expect(posts[0].text).toContain(`<@${STARTER}>`);
    expect((await getHitlForm("req-ap-1"))?.status).toBe("awaiting");
  });

  it("mentions nobody when the form asks for no approval", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);

    await deliver(hitlTask("req-ap-none"));

    expect(posts).toHaveLength(1);
    expect(posts[0].blocks).not.toContain("<@");
    expect(posts[0].text).not.toContain("<@");
  });

  /**
   * Deliver an approval for a task nobody started, and assert the prompt is
   * posted and asked of nobody in particular — no mention, and no sign of the
   * sentinel the row carries in place of a person.
   */
  async function deliverUnstartedApproval(
    token: string,
    requestId: string,
    sentinel: string
  ): Promise<void> {
    const row = await getAgentTaskByToken(token);
    // Never a null, whichever way nobody started it.
    expect(row?.startedBy).toBe(sentinel);

    const posts: SlackPost[] = [];
    stubFetch(posts);
    const agent = await getAgent("remoteagent");
    await deliverTaskToSlack(token, row!, agent!, approvalTask(requestId));

    expect(posts).toHaveLength(1);
    expect(posts[0].blocks).toContain(requestId);
    expect(posts[0].blocks).not.toContain("<@");
    expect(posts[0].blocks).not.toContain(sentinel);
    expect(posts[0].text).not.toContain("<@");
    expect(posts[0].text).not.toContain(sentinel);
    expect((await getHitlForm(requestId))?.status).toBe("awaiting");
    expect((await getAgentTaskByToken(token))?.status).toBe("awaiting-input");
  }

  it("posts the approval unmentioned for a row from before the column", async () => {
    // A row as 0023's rebuild left the ones written before the column: the
    // sentinel it backfilled with, written here as raw SQL because the types make
    // it unrepresentable through `createAgentTask`. An agent has until its task
    // deadline to come back, so such a row can still raise a prompt after the
    // migration — worth posting without a ping rather than not posting. That the
    // rebuild is what puts the value there is `0023-agent-tasks-started-by.spec`.
    await env.DB.prepare(
      `INSERT INTO agent_tasks (token, task_id, agent_name, channel_id, message_ts, reply_thread_ts, event_id, started_by)
       VALUES ('tok-legacy', 'task-1', 'remoteagent', 'C1', '1700.3', '1700.3', 'Ev-legacy', ?)`
    )
      .bind(STARTED_BY_UNKNOWN)
      .run();

    await deliverUnstartedApproval(
      "tok-legacy",
      "req-ap-legacy",
      STARTED_BY_UNKNOWN
    );
  });

  it("posts the approval unmentioned for a feed turn no person started", async () => {
    // What `startedBy` records for an edit or a delete: the user id on such a
    // turn is the authored message's author, not whoever acted, so the task is
    // the gatekeeper's own doing and there is nobody on it to ask.
    await createAgentTask({
      token: "tok-feed",
      taskId: "task-1",
      agentName: "remoteagent",
      channelId: "C1",
      messageTs: "1700.4",
      replyThreadTs: "1700.4",
      eventId: "Ev-feed",
      startedBy: STARTED_BY_PROCESS
    });

    await deliverUnstartedApproval(
      "tok-feed",
      "req-ap-feed",
      STARTED_BY_PROCESS
    );
  });

  it("still mentions the starter after somebody else answered an earlier approval", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(approvalTask("req-ap-first"));

    // The two writes the answer path makes on this task row: somebody other than
    // the starter claims the answer, and the continuation un-parks the row
    // (dispatch's `markResumed`) so the resumed turn's callbacks are honored.
    await claimHitlAnswer("req-ap-first", {
      answeredBy: OTHER,
      answers: { q1: { optionIds: [HITL_APPROVE_OPTION_ID] } }
    });
    expect(await resumeFromInput("tok-del")).toBe("Ev1");

    await deliver(approvalTask("req-ap-second"));

    const prompts = posts.filter((p) => p.blocks);
    expect(prompts).toHaveLength(2);
    expect(prompts[1].blocks).toContain(`<@${STARTER}>`);
    expect(prompts[1].blocks).not.toContain(`<@${OTHER}>`);
    expect(prompts[1].text).toContain(`<@${STARTER}>`);
    // The stored value is the original one, not the answerer's.
    expect((await getAgentTaskByToken("tok-del"))?.startedBy).toBe(STARTER);
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

    expect((await getHitlForm("req-final"))?.status).toBe("canceled");
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
    expect((await getHitlForm("req-retry"))?.status).toBe("canceled");

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

    expect((await getHitlForm("req-open"))?.status).toBe("awaiting");
    expect(posts.filter((p) => p.method === "chat.update")).toHaveLength(0);
  });
});
