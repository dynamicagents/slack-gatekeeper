import { describe, it, expect, beforeEach } from "vitest";
import { registerAgent } from "@/db/models/agents";
import {
  createAgentTask,
  suspendForInput,
  resumeFromInput,
  getAgentTaskByToken,
  getPendingAgentTasksByChannelAndTs,
  completeAgentTask
} from "@/db/models/agent-tasks";
import {
  createHitlRequest,
  getHitlRequest,
  setHitlSlackMessageTs,
  claimHitlAnswer,
  reopenHitlRequest,
  cancelHitlRequest,
  cancelHitlRequestsByToken,
  expireStaleHitlRequests,
  sweepStaleHitlRequests,
  type CreateHitlRequestInput
} from "@/db/models/hitl-requests";
import { useStorageReset } from "../../helpers/storage";

useStorageReset();

beforeEach(async () => {
  await registerAgent({
    name: "remoteagent",
    kind: "remote",
    a2aEndpoint: "https://agent.example.com/a2a",
    tenantId: "main",
    notifyOn: "mention",
    workspaceId: 0
  });
});

function input(
  requestId: string,
  over: Partial<CreateHitlRequestInput> = {}
): CreateHitlRequestInput {
  return {
    requestId,
    token: "tok-1",
    taskId: "task-1",
    contextId: "C1:1700.1",
    agentName: "remoteagent",
    channelId: "C1",
    threadTs: "1700.1",
    requestKind: "choice",
    promptText: "Pick one",
    optionsJson: JSON.stringify([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" }
    ]),
    allowFreeform: false,
    deadlineAt: Math.floor(Date.now() / 1000) + 600,
    ...over
  };
}

describe("hitl-requests model", () => {
  it("creates and reads a request", async () => {
    expect(await createHitlRequest(input("req-a"))).toBe(true);
    const row = await getHitlRequest("req-a");
    expect(row?.status).toBe("awaiting");
    expect(row?.requestKind).toBe("choice");
    expect(row?.contextId).toBe("C1:1700.1");
  });

  it("is idempotent on the requestId PK (dedup returns false, no clobber)", async () => {
    expect(
      await createHitlRequest(input("req-b", { promptText: "first" }))
    ).toBe(true);
    expect(
      await createHitlRequest(input("req-b", { promptText: "second" }))
    ).toBe(false);
    expect((await getHitlRequest("req-b"))?.promptText).toBe("first");
  });

  it("records the Slack message ts", async () => {
    await createHitlRequest(input("req-ts"));
    await setHitlSlackMessageTs("req-ts", "1700.55");
    expect((await getHitlRequest("req-ts"))?.slackMessageTs).toBe("1700.55");
  });

  describe("claimHitlAnswer (first-click-wins)", () => {
    it("claims an awaiting request and returns the full row", async () => {
      await createHitlRequest(input("req-c"));
      const claimed = await claimHitlAnswer("req-c", {
        answeredBy: "U1",
        optionId: "a"
      });
      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe("answered");
      expect(claimed?.answeredBy).toBe("U1");
      expect(claimed?.answeredOptionId).toBe("a");
      expect(claimed?.answeredAt).not.toBeNull();
    });

    it("lets exactly one of two racing claims win", async () => {
      await createHitlRequest(input("req-race"));
      const [first, second] = await Promise.all([
        claimHitlAnswer("req-race", { answeredBy: "U1", optionId: "a" }),
        claimHitlAnswer("req-race", { answeredBy: "U2", optionId: "b" })
      ]);
      const winners = [first, second].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
    });

    it("returns null for an already-answered, expired, or unknown request", async () => {
      await createHitlRequest(input("req-d"));
      await claimHitlAnswer("req-d", { answeredBy: "U1", optionId: "a" });
      expect(
        await claimHitlAnswer("req-d", { answeredBy: "U2", optionId: "b" })
      ).toBeNull();
      expect(
        await claimHitlAnswer("req-nope", { answeredBy: "U2" })
      ).toBeNull();
    });

    it("records a freeform text answer without an optionId", async () => {
      await createHitlRequest(input("req-free", { allowFreeform: true }));
      const claimed = await claimHitlAnswer("req-free", {
        answeredBy: "U1",
        text: "something else"
      });
      expect(claimed?.answerText).toBe("something else");
      expect(claimed?.answeredOptionId).toBeNull();
    });
  });

  describe("reopenHitlRequest", () => {
    /** A task parked on its prompt, as `deliverHitlRequest` leaves it. */
    async function parkedTask(token: string) {
      await createAgentTask({
        token,
        taskId: "task-1",
        agentName: "remoteagent",
        channelId: "C1",
        messageTs: "1700.1",
        replyThreadTs: "1700.1",
        eventId: `Ev-${token}`
      });
      await suspendForInput(token);
    }

    it("reopens an answered request while its task is parked, clearing the answer", async () => {
      await parkedTask("tok-open");
      await createHitlRequest(input("req-open", { token: "tok-open" }));
      await claimHitlAnswer("req-open", { answeredBy: "U1", text: "typed" });

      expect(await reopenHitlRequest("req-open")).toBe(true);
      const row = await getHitlRequest("req-open");
      expect(row?.status).toBe("awaiting");
      expect(row?.answeredBy).toBeNull();
      expect(row?.answeredOptionId).toBeNull();
      expect(row?.answerText).toBeNull();
      expect(row?.answeredAt).toBeNull();

      // Open again means claimable again.
      expect(
        await claimHitlAnswer("req-open", { answeredBy: "U2", optionId: "b" })
      ).not.toBeNull();
    });

    it("leaves the answer when the task is no longer parked", async () => {
      await parkedTask("tok-done");
      await createHitlRequest(input("req-over", { token: "tok-done" }));
      await claimHitlAnswer("req-over", { answeredBy: "U1", optionId: "a" });
      // The task finished while the answer was on its way.
      await completeAgentTask("tok-done");

      expect(await reopenHitlRequest("req-over")).toBe(false);
      expect((await getHitlRequest("req-over"))?.status).toBe("answered");
    });

    it("does not touch a request that was never answered", async () => {
      await parkedTask("tok-idle");
      await createHitlRequest(input("req-idle", { token: "tok-idle" }));
      await createHitlRequest(input("req-shut", { token: "tok-idle" }));
      await cancelHitlRequest("req-shut");

      expect(await reopenHitlRequest("req-idle")).toBe(false);
      expect(await reopenHitlRequest("req-shut")).toBe(false);
      expect(await reopenHitlRequest("req-nope")).toBe(false);
      expect((await getHitlRequest("req-shut"))?.status).toBe("canceled");
    });

    it("does not reopen on the strength of another task being parked", async () => {
      await parkedTask("tok-other");
      await createHitlRequest(input("req-orphan", { token: "tok-gone" }));
      await claimHitlAnswer("req-orphan", { answeredBy: "U1", optionId: "a" });

      expect(await reopenHitlRequest("req-orphan")).toBe(false);
    });
  });

  describe("cancelHitlRequest", () => {
    it("cancels one awaiting request, once, and leaves its siblings open", async () => {
      await createHitlRequest(input("req-one", { token: "tok-z" }));
      await createHitlRequest(input("req-two", { token: "tok-z" }));
      expect(await cancelHitlRequest("req-one")).toBe(true);
      expect(await cancelHitlRequest("req-one")).toBe(false);
      expect((await getHitlRequest("req-one"))?.status).toBe("canceled");
      expect((await getHitlRequest("req-two"))?.status).toBe("awaiting");
    });

    it("does not reopen or overwrite an answered request", async () => {
      await createHitlRequest(input("req-done"));
      await claimHitlAnswer("req-done", { answeredBy: "U1", optionId: "a" });
      expect(await cancelHitlRequest("req-done")).toBe(false);
      expect((await getHitlRequest("req-done"))?.status).toBe("answered");
    });
  });

  describe("cancelHitlRequestsByToken", () => {
    it("cancels every open request for a token and returns them", async () => {
      await createHitlRequest(input("req-e", { token: "tok-x" }));
      await createHitlRequest(input("req-f", { token: "tok-x" }));
      const canceled = await cancelHitlRequestsByToken("tok-x");
      expect(canceled.map((r) => r.requestId).sort()).toEqual([
        "req-e",
        "req-f"
      ]);
      expect((await getHitlRequest("req-e"))?.status).toBe("canceled");
    });

    it("does not touch already-answered requests", async () => {
      await createHitlRequest(input("req-g", { token: "tok-y" }));
      await claimHitlAnswer("req-g", { answeredBy: "U1", optionId: "a" });
      const canceled = await cancelHitlRequestsByToken("tok-y");
      expect(canceled).toHaveLength(0);
      expect((await getHitlRequest("req-g"))?.status).toBe("answered");
    });
  });

  describe("expireStaleHitlRequests", () => {
    it("expires only awaiting requests past their deadline", async () => {
      const now = Math.floor(Date.now() / 1000);
      await createHitlRequest(input("req-past", { deadlineAt: now - 10 }));
      await createHitlRequest(input("req-future", { deadlineAt: now + 1000 }));
      const expired = await expireStaleHitlRequests(now);
      expect(expired.map((r) => r.requestId)).toEqual(["req-past"]);
      expect((await getHitlRequest("req-past"))?.status).toBe("expired");
      expect((await getHitlRequest("req-future"))?.status).toBe("awaiting");
    });
  });

  it("sweeps only resolved rows older than the cutoff", async () => {
    await createHitlRequest(input("req-sweep"));
    expect(await sweepStaleHitlRequests(24 * 60 * 60)).toBe(0);
    // A negative window (cutoff in the future) collects everything.
    expect(await sweepStaleHitlRequests(-10)).toBeGreaterThanOrEqual(1);
    expect(await getHitlRequest("req-sweep")).toBeNull();
  });
});

describe("agent_tasks suspend/resume for input", () => {
  function taskInput(token: string) {
    return {
      token,
      taskId: "task-1",
      agentName: "remoteagent",
      channelId: "C1",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev1"
    };
  }

  it("parks a pending task and resumes it", async () => {
    await createAgentTask(taskInput("tok-s"));
    expect(await suspendForInput("tok-s")).toBe(true);
    expect((await getAgentTaskByToken("tok-s"))?.status).toBe("awaiting-input");
    // Idempotent: a second suspend is a no-op.
    expect(await suspendForInput("tok-s")).toBe(false);

    // Returns the event id so the caller can wake the ReactionWorkflow: a resume
    // starts a fresh processing leg, and the workflow times legs itself.
    expect(await resumeFromInput("tok-s")).toBe("Ev1");
    expect((await getAgentTaskByToken("tok-s"))?.status).toBe("pending");
    // Idempotent: nothing left parked, so nothing to signal.
    expect(await resumeFromInput("tok-s")).toBeNull();
  });

  it("keeps a parked task cancelable via the fan-out lookup", async () => {
    await createAgentTask(taskInput("tok-park"));
    await suspendForInput("tok-park");
    const rows = await getPendingAgentTasksByChannelAndTs("C1", "1700.1");
    expect(rows.map((r) => r.token)).toContain("tok-park");
  });

  it("completes a parked task (a 🛑 on a task awaiting input)", async () => {
    await createAgentTask(taskInput("tok-cancel"));
    await suspendForInput("tok-cancel");
    expect(await completeAgentTask("tok-cancel")).toBe(true);
    expect((await getAgentTaskByToken("tok-cancel"))?.status).toBe("completed");
  });
});
