import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { AgentCard, Task, TaskState } from "@a2a-js/sdk";
import {
  STOP_REACTION,
  REACTION_SYNC_EVENT,
  MAX_LEGS,
  deadlineLabel,
  reactionInstanceId
} from "@/workflows/reaction";
import type { ReactionWorkflowParams } from "@/slack/types";
import { registerAgent, updateAgent } from "@/db/models/agents";
import {
  setPublicUrl,
  setAllowedRemoteAgentDomains
} from "@/db/models/workspace-configs";
import {
  createAgentTask,
  recordAgentTaskError,
  suspendForInput,
  getAgentTaskByToken
} from "@/db/models/agent-tasks";
import { buildAgentCard } from "@/a2a/card";
import { makeTask } from "../helpers/a2a";
import { stubSlack } from "../wrappers/slack-stub";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

const ENDPOINT = "https://agent.example.com/a2a";

/**
 * The loop's wait step for leg 0. Every backstop test has to time out *both* this
 * and the phase-1 grace wait: the grace only gets the workflow as far as
 * surfacing rejected deliveries, and the budget wait is what decides the task
 * timed out.
 */
const GRACE_STEP = "await collect signal";
const LEG0_STEP = "sync:0";

/**
 * The leg-0 read as it stood *before* an admin moved the deadline: the stale value
 * the loop sizes its wait from, and the one the cancel step must not decide on.
 *
 * Mocked rather than raced, because a wait cannot be held open from a test: a real
 * `waitForEvent` timeout never resumes (workerd cancels a worker that sits waiting
 * on it), and a forced one fires the instant the wait is entered. Making the read
 * *before* the wait the mocked one puts the admin's write inside it by
 * construction, with no timing to depend on.
 */
function staleSnapshot(token: string, deadlineSeconds: number) {
  return {
    state: "working",
    tasks: [{ token, pending: true, deadlineSeconds }]
  };
}

afterEach(() => vi.unstubAllGlobals());

interface ReactionCall {
  method: string;
  channel: string;
  timestamp: string;
  name: string;
}

interface PostCall {
  channel: string;
  text: string;
}

/** Record every reactions.add/remove call; all Slack calls resolve ok. */
function captureReactions(): ReactionCall[] {
  const calls: ReactionCall[] = [];
  stubSlack((method, body) => {
    if (method === "reactions.add" || method === "reactions.remove") {
      calls.push({
        method,
        channel: body.get("channel") ?? "",
        timestamp: body.get("timestamp") ?? "",
        name: body.get("name") ?? ""
      });
    }
    return { ok: true };
  });
  return calls;
}

/** Record reactions and chat.postMessage calls together for the backstop tests. */
function captureReactionsAndPosts(): {
  reactions: ReactionCall[];
  posts: PostCall[];
} {
  const reactions: ReactionCall[] = [];
  const posts: PostCall[] = [];
  stubSlack((method, body) => {
    if (method === "reactions.add" || method === "reactions.remove") {
      reactions.push({
        method,
        channel: body.get("channel") ?? "",
        timestamp: body.get("timestamp") ?? "",
        name: body.get("name") ?? ""
      });
    } else if (method === "chat.postMessage") {
      posts.push({
        channel: body.get("channel") ?? "",
        text: body.get("text") ?? ""
      });
    }
    return { ok: true, ts: "1700.9" };
  });
  return { reactions, posts };
}

/**
 * The timeout path issues a real A2A `tasks/cancel`, so its test needs fetch to
 * answer *both* Slack and the agent. `stubSlack` owns the whole global, so this
 * replaces it with one stub that routes by host: slack.com gets the Slack
 * handler, the agent endpoint gets card discovery on GET and a canceled Task on
 * POST. Returns the captured calls plus a live cancel count.
 */
function captureWithCancellableAgent(): {
  reactions: ReactionCall[];
  posts: PostCall[];
  readonly cancelCalls: number;
} {
  const reactions: ReactionCall[] = [];
  const posts: PostCall[] = [];
  const state = { cancelCalls: 0 };
  const card = buildAgentCard({
    name: "Remote",
    description: "remote test agent",
    url: ENDPOINT
  });
  const canceled: unknown = Task.toJSON(
    makeTask({
      id: "task-1",
      contextId: "C1:1700.1",
      state: TaskState.TASK_STATE_CANCELED
    })
  );

  vi.stubGlobal(
    "fetch",
    async (input: unknown, init?: RequestInit): Promise<Response> => {
      const isReq = input instanceof Request;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const parsed = new URL(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" }
        });

      if (parsed.hostname === "slack.com") {
        const method = parsed.pathname.split("/").pop() ?? "";
        const body = new URLSearchParams(
          typeof init?.body === "string" ? init.body : ""
        );
        if (method === "reactions.add" || method === "reactions.remove") {
          reactions.push({
            method,
            channel: body.get("channel") ?? "",
            timestamp: body.get("timestamp") ?? "",
            name: body.get("name") ?? ""
          });
        } else if (method === "chat.postMessage") {
          posts.push({
            channel: body.get("channel") ?? "",
            text: body.get("text") ?? ""
          });
        }
        return json({ ok: true, ts: "1700.9" });
      }

      const httpMethod = init?.method ?? (isReq ? input.method : "GET");
      if (httpMethod.toUpperCase() !== "POST") {
        return json(AgentCard.toJSON(card));
      }
      state.cancelCalls++;
      const raw = isReq ? await input.clone().text() : String(init?.body ?? "");
      let id: unknown = 1;
      try {
        id = JSON.parse(raw).id ?? 1;
      } catch {
        /* ignore */
      }
      return json({ jsonrpc: "2.0", id, result: canceled });
    }
  );

  return {
    reactions,
    posts,
    get cancelCalls() {
      return state.cancelCalls;
    }
  };
}

/**
 * Seed a pending remote task (and its agent) for `eventId`. `taskDeadlineSeconds`
 * goes straight to `registerAgent`, so omitting it leaves the agent on the
 * gatekeeper default — which is what the byte-identical-default tests rely on.
 */
async function seedPendingTask(
  eventId: string,
  token: string,
  lastError?: string,
  taskDeadlineSeconds?: number
): Promise<void> {
  await registerAgent({
    name: token, // unique per task to avoid cross-test collisions
    kind: "remote",
    displayName: "Remote",
    a2aEndpoint: ENDPOINT,
    tenantId: "main",
    notifyOn: "mention",
    taskDeadlineSeconds,
    workspaceId: 0
  });
  await createAgentTask({
    token,
    taskId: "task-1",
    agentName: token,
    channelId: "C1",
    messageTs: "1700.1",
    replyThreadTs: null,
    eventId
  });
  if (lastError) await recordAgentTaskError(token, lastError);
}

let seq = 0;
function makeParams(): ReactionWorkflowParams {
  return { eventId: `Ev-react-${++seq}`, channelId: "C1", ts: "1700.1" };
}

beforeEach(async () => {
  await setPublicUrl("https://gw.example.com");
  await setAllowedRemoteAgentDomains(["agent.example.com"]);
});

describe("ReactionWorkflow", () => {
  it("removes the stop reaction when the collect signal arrives", async () => {
    const calls = captureReactions();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      // Resolve the phase-1 wait as if the MessageWorkflow signaled a drained
      // fan-out. With no rows left, `evaluate:0` reports drained and the loop exits.
      await introspector.modifyAll(async (m) => {
        await m.mockEvent({ type: REACTION_SYNC_EVENT, payload: {} });
      });

      const p = makeParams();
      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // The reaction is *added* inline by the webhook handler, not here — this
      // workflow only removes it.
      expect(calls.map((c) => c.method)).toEqual(["reactions.remove"]);
      expect(calls[0]).toMatchObject({
        channel: "C1",
        timestamp: "1700.1",
        name: STOP_REACTION
      });
    } finally {
      await introspector.dispose();
    }
  });

  it("removes the reaction on the timeout backstop when no signal ever arrives", async () => {
    const calls = captureReactions();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      // Simulate a MessageWorkflow crash: no signal ever comes, so both the grace
      // wait and the budget wait time out and the reaction must still be removed.
      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: GRACE_STEP });
        await m.forceEventTimeout({ name: LEG0_STEP });
      });

      const p = makeParams();
      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      expect(calls.map((c) => c.method)).toEqual(["reactions.remove"]);
    } finally {
      await introspector.dispose();
    }
  });

  it("surfaces a rejected delivery at the retry grace, before the budget runs out", async () => {
    const { reactions, posts } = captureReactionsAndPosts();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const token = `ntok-${p.eventId}`.toLowerCase();
      await seedPendingTask(
        p.eventId,
        token,
        "the callback signature could not be verified (expired)"
      );

      // Only the grace wait times out — the budget wait is left hanging, so the
      // task is *not* canceled. This is the "you have a broken agent" notice
      // landing at ~6 minutes, an hour before the deadline.
      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: GRACE_STEP });
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStepResult({ name: "surface-rejected-deliveries" });

      // The captured reason is surfaced to the user...
      expect(posts).toHaveLength(1);
      expect(posts[0].channel).toBe("C1");
      expect(posts[0].text).toContain("failed to deliver");
      expect(posts[0].text).toContain(token);
      expect(posts[0].text).toContain("signature could not be verified");
      // ...while the task keeps its budget: a rejected delivery is not a stop, and
      // the remote may still retry successfully.
      expect((await getAgentTaskByToken(token))?.status).toBe("pending");
      expect(reactions).toHaveLength(0);
    } finally {
      await introspector.dispose();
    }
  });

  it("at the grace mark, stays silent for a pending task with no captured error", async () => {
    const { posts } = captureReactionsAndPosts();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const token = `ntok-${p.eventId}`.toLowerCase();
      // Pending, but no lastError: the remote may still be legitimately working,
      // so we must not claim failure.
      await seedPendingTask(p.eventId, token);

      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: GRACE_STEP });
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStepResult({ name: "surface-rejected-deliveries" });

      expect(posts).toHaveLength(0);
      expect((await getAgentTaskByToken(token))?.status).toBe("pending");
    } finally {
      await introspector.dispose();
    }
  });

  it("cancels a task that burns its whole processing budget, and tells the user", async () => {
    const captured = captureWithCancellableAgent();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const token = `ntok-${p.eventId}`.toLowerCase();
      await seedPendingTask(p.eventId, token);

      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: GRACE_STEP });
        await m.forceEventTimeout({ name: LEG0_STEP });
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // A real tasks/cancel went out, so the agent stops burning its own compute.
      expect(captured.cancelCalls).toBeGreaterThan(0);
      // The row is terminal under the one status both triggers share.
      expect((await getAgentTaskByToken(token))?.status).toBe("canceled");
      // The user is told, rather than the 🛑 just vanishing.
      const notice = captured.posts.find((x) =>
        x.text.includes("1 hour limit")
      );
      expect(notice).toBeDefined();
      expect(notice?.text).toContain(token);
      expect(notice?.text).toContain("discarded");
      // ...and the reaction comes off.
      expect(captured.reactions.map((c) => c.method)).toEqual([
        "reactions.remove"
      ]);
    } finally {
      await introspector.dispose();
    }
  });

  it("names the agent's own limit, not the gatekeeper default", async () => {
    const captured = captureWithCancellableAgent();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const token = `ntok-${p.eventId}`.toLowerCase();
      // Half an hour rather than the default hour.
      await seedPendingTask(p.eventId, token, undefined, 30 * 60);

      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: GRACE_STEP });
        await m.forceEventTimeout({ name: LEG0_STEP });
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      expect((await getAgentTaskByToken(token))?.status).toBe("canceled");
      const notice = captured.posts.find((x) => x.text.includes("limit"));
      expect(notice?.text).toContain("30 minutes limit");
      // The notice quotes the budget actually enforced, so the default must not
      // leak into it.
      expect(notice?.text).not.toContain("1 hour");
    } finally {
      await introspector.dispose();
    }
  });

  it("stops each agent of a fan-out at its own deadline, in order", async () => {
    const captured = captureWithCancellableAgent();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const short = `ntok-short-${p.eventId}`.toLowerCase();
      const long = `ntok-long-${p.eventId}`.toLowerCase();
      await seedPendingTask(p.eventId, short, undefined, 30 * 60);
      await seedPendingTask(p.eventId, long, undefined, 2 * 60 * 60);

      // A forced timeout fires per step name, so the second leg needs its own:
      // the short agent expires in leg 0 and the long one in leg 1.
      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: GRACE_STEP });
        await m.forceEventTimeout({ name: LEG0_STEP });
        await m.forceEventTimeout({ name: "sync:1" });
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      const notices = captured.posts.filter((x) => x.text.includes("limit"));
      expect(notices).toHaveLength(2);
      expect(notices[0].text).toContain(short);
      expect(notices[0].text).toContain("30 minutes limit");
      expect(notices[1].text).toContain(long);
      expect(notices[1].text).toContain("2 hours limit");
      expect((await getAgentTaskByToken(short))?.status).toBe("canceled");
      expect((await getAgentTaskByToken(long))?.status).toBe("canceled");
    } finally {
      await introspector.dispose();
    }
  });

  it("leaves a sibling with budget left running when the short one expires", async () => {
    const captured = captureWithCancellableAgent();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const short = `ptok-short-${p.eventId}`.toLowerCase();
      const long = `ptok-long-${p.eventId}`.toLowerCase();
      await seedPendingTask(p.eventId, short, undefined, 30 * 60);
      await seedPendingTask(p.eventId, long, undefined, 2 * 60 * 60);

      // Only leg 0 times out, so the long agent's own wait is left hanging.
      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: GRACE_STEP });
        await m.forceEventTimeout({ name: LEG0_STEP });
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStepResult({ name: "cancel:0" });
      // The next leg still has work to do — which is the whole point: a shared
      // budget would have stopped both here.
      expect(
        await instance.waitForStepResult({ name: "evaluate:1" })
      ).toMatchObject({ state: "working" });

      expect((await getAgentTaskByToken(short))?.status).toBe("canceled");
      expect((await getAgentTaskByToken(long))?.status).toBe("pending");
      const notices = captured.posts.filter((x) => x.text.includes("limit"));
      expect(notices).toHaveLength(1);
      expect(notices[0].text).toContain(short);
      // And the 🛑 stays while a sibling is still working.
      expect(captured.reactions).toHaveLength(0);
    } finally {
      await introspector.dispose();
    }
  });

  it("spares a task whose deadline was raised while it was already waiting", async () => {
    const captured = captureWithCancellableAgent();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const token = `rtok-${p.eventId}`.toLowerCase();
      // Half an hour when the wait started...
      await seedPendingTask(p.eventId, token, undefined, 30 * 60);

      await introspector.modifyAll(async (m) => {
        await m.mockStepResult(
          { name: "evaluate:0" },
          staleSnapshot(token, 30 * 60)
        );
        await m.forceEventTimeout({ name: GRACE_STEP });
        await m.forceEventTimeout({ name: LEG0_STEP });
      });

      // ...and two hours by the time it ends, because an admin raised it while
      // the task was waiting on the old limit.
      await updateAgent(token, { taskDeadlineSeconds: 2 * 60 * 60 });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();

      // The cancel step re-reads the ledger, so it decides against the limit in
      // force now: nothing expired, and the task comes back as a survivor charged
      // for the half hour it did spend.
      expect(
        await instance.waitForStepResult({ name: "cancel:0" })
      ).toMatchObject({
        expired: [],
        survivors: [{ token, spent: 30 * 60 }]
      });
      expect((await getAgentTaskByToken(token))?.status).toBe("pending");
      expect(captured.cancelCalls).toBe(0);
      expect(captured.posts).toHaveLength(0);
      // And the loop runs on into the next leg on the raised budget, with the 🛑
      // still in place.
      expect(
        await instance.waitForStepResult({ name: "evaluate:1" })
      ).toMatchObject({ state: "working" });
      expect(captured.reactions).toHaveLength(0);
    } finally {
      await introspector.dispose();
    }
  });

  it("cancels at a deadline lowered during the wait, naming the new limit", async () => {
    const captured = captureWithCancellableAgent();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const token = `ltok-${p.eventId}`.toLowerCase();
      // Two hours when the wait started — which is what made it that long...
      await seedPendingTask(p.eventId, token, undefined, 2 * 60 * 60);

      await introspector.modifyAll(async (m) => {
        await m.mockStepResult(
          { name: "evaluate:0" },
          staleSnapshot(token, 2 * 60 * 60)
        );
        await m.forceEventTimeout({ name: GRACE_STEP });
        await m.forceEventTimeout({ name: LEG0_STEP });
      });

      // ...and half an hour by the time it ends.
      await updateAgent(token, { taskDeadlineSeconds: 30 * 60 });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // Charged for the wait it really sat through, but held to the limit in
      // force now — and told about that one, not the one it was waiting on.
      expect((await getAgentTaskByToken(token))?.status).toBe("canceled");
      const notice = captured.posts.find((x) => x.text.includes("limit"));
      expect(notice?.text).toContain("30 minutes limit");
      expect(notice?.text).not.toContain("2 hours");
    } finally {
      await introspector.dispose();
    }
  });

  it("drains what is still pending at the leg cap before letting the 🛑 go", async () => {
    const captured = captureWithCancellableAgent();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const working = `captok-${p.eventId}`.toLowerCase();
      const parked = `capark-${p.eventId}`.toLowerCase();
      await seedPendingTask(p.eventId, working);
      await seedPendingTask(p.eventId, parked);
      expect(await suspendForInput(parked)).toBe(true);

      // One signal for the grace wait and one per leg. Every wake is a real leg
      // boundary, so no budget is ever spent and nothing is ever expired: the loop
      // runs out of legs with a task still working, which is the cap-hit the
      // reviewer's 101-deadline fan-out reaches the expensive way.
      await introspector.modifyAll(async (m) => {
        for (let i = 0; i <= MAX_LEGS; i++) {
          await m.mockEvent({ type: REACTION_SYNC_EVENT, payload: {} });
        }
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // The task is stopped for real rather than left running under a 🛑 that
      // just vanished.
      expect((await getAgentTaskByToken(working))?.status).toBe("canceled");
      expect(captured.cancelCalls).toBeGreaterThan(0);
      const notice = captured.posts.find((x) => x.text.includes("safety cap"));
      expect(notice?.text).toContain(working);
      expect(notice?.text).toContain("discarded");
      // ...and the notice doesn't claim a deadline ran out: this agent still had
      // its whole hour.
      expect(captured.posts.some((x) => x.text.includes("limit"))).toBe(false);
      // A task parked on a human prompt is left alone, as everywhere else: its
      // answer still posts.
      expect((await getAgentTaskByToken(parked))?.status).toBe(
        "awaiting-input"
      );
      expect(captured.reactions.map((c) => c.method)).toEqual([
        "reactions.remove"
      ]);
    } finally {
      await introspector.dispose();
    }
  });

  it("stops every agent of a fan-out wider than the leg cap", async () => {
    const captured = captureWithCancellableAgent();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      // The reviewer's case, at its exact boundary: one more distinct deadline
      // than there are legs to spend them in. A second apart each, so every leg
      // expires exactly one agent and the fan-out needs every leg it has.
      const tokens: string[] = [];
      for (let k = 1; k <= MAX_LEGS + 1; k++) {
        const token = `fan${k}-${p.eventId}`.toLowerCase();
        tokens.push(token);
        await seedPendingTask(p.eventId, token, undefined, 360 + k);
      }
      const last = tokens[tokens.length - 1];

      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: GRACE_STEP });
        for (let leg = 0; leg < MAX_LEGS; leg++) {
          await m.forceEventTimeout({ name: `sync:${leg}` });
        }
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // The hundred the loop had legs for were each stopped at their own
      // deadline, and told so.
      const timedOut = captured.posts.filter((x) => x.text.includes("limit"));
      expect(timedOut).toHaveLength(MAX_LEGS);
      // The one past the cap is stopped too — the whole point — but by the cap,
      // which is what its notice says.
      const notice = captured.posts.find((x) => x.text.includes("safety cap"));
      expect(notice?.text).toContain(last);
      for (const token of tokens) {
        expect((await getAgentTaskByToken(token))?.status).toBe("canceled");
      }
      // Only now does the 🛑 come off: nothing is still running under it.
      expect(captured.reactions.map((c) => c.method)).toEqual([
        "reactions.remove"
      ]);
    } finally {
      await introspector.dispose();
    }
  }, 120_000);

  it("does not spend the budget while a task is parked on a human prompt", async () => {
    const captured = captureWithCancellableAgent();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const token = `ntok-${p.eventId}`.toLowerCase();
      await seedPendingTask(p.eventId, token);
      // Park it: the clock stops, and the wait becomes the HITL TTL instead.
      expect(await suspendForInput(token)).toBe(true);

      // Time out the grace wait only. `evaluate:0` should report `parked`, so the
      // loop waits out the prompt rather than the budget — nothing is canceled.
      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: GRACE_STEP });
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      expect(
        await instance.waitForStepResult({ name: "evaluate:0" })
      ).toMatchObject({ state: "parked" });
      expect(captured.cancelCalls).toBe(0);
      expect((await getAgentTaskByToken(token))?.status).toBe("awaiting-input");
      // Crucially the 🛑 is still there — it is the only one-tap way to stop a
      // task parked on a prompt.
      expect(captured.reactions).toHaveLength(0);
    } finally {
      await introspector.dispose();
    }
  });
});

describe("deadlineLabel", () => {
  it("reads a budget the way the notice should say it", () => {
    // The default's text is byte-identical to what the old constant produced —
    // the existing "1 hour limit" assertion above is the other half of that pin.
    expect(deadlineLabel(3600)).toBe("1 hour");
    expect(deadlineLabel(7200)).toBe("2 hours");
    expect(deadlineLabel(1800)).toBe("30 minutes");
    expect(deadlineLabel(60)).toBe("1 minute");
    expect(deadlineLabel(86400)).toBe("24 hours");
  });

  it("keeps the seconds of any limit that is not a whole minute", () => {
    // An admin may set any positive whole number of seconds, and the notice has
    // to name the one that was set: rounding these into minutes reported limits
    // that never existed ("0 minutes", "2 minutes").
    expect(deadlineLabel(1)).toBe("1 second");
    expect(deadlineLabel(90)).toBe("90 seconds");
    expect(deadlineLabel(3601)).toBe("3601 seconds");
  });
});
