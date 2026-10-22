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
  createHitlForm,
  getHitlForm,
  setHitlFormMessageTs,
  claimHitlAnswer,
  reopenHitlForm,
  cancelHitlForm,
  cancelHitlFormsByToken,
  expireStaleHitlForms,
  sweepStaleHitlForms,
  saveHitlDraft,
  hitlDraftOf,
  type CreateHitlFormInput
} from "@/db/models/hitl-forms";
import { choiceForm } from "../../helpers/hitl";
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
  over: Partial<CreateHitlFormInput> = {}
): CreateHitlFormInput {
  return {
    requestId,
    token: "tok-1",
    taskId: "task-1",
    contextId: "C1:1700.1",
    agentName: "remoteagent",
    channelId: "C1",
    threadTs: "1700.1",
    request: choiceForm(requestId, "Pick one", [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" }
    ]),
    deadlineAt: Math.floor(Date.now() / 1000) + 600,
    ...over
  };
}

describe("hitl-forms model", () => {
  it("creates and reads a request", async () => {
    expect(await createHitlForm(input("req-a"))).toBe(true);
    const row = await getHitlForm("req-a");
    expect(row?.status).toBe("awaiting");
    expect(row?.requestJson.questions[0]?.prompt).toBe("Pick one");
    expect(row?.contextId).toBe("C1:1700.1");
  });

  it("is idempotent on the requestId PK (dedup returns false, no clobber)", async () => {
    expect(
      await createHitlForm(
        input("req-b", { request: choiceForm("req-b", "first") })
      )
    ).toBe(true);
    expect(
      await createHitlForm(
        input("req-b", { request: choiceForm("req-b", "second") })
      )
    ).toBe(false);
    expect((await getHitlForm("req-b"))?.requestJson.questions[0]?.prompt).toBe(
      "first"
    );
  });

  it("records the Slack message ts", async () => {
    await createHitlForm(input("req-ts"));
    await setHitlFormMessageTs("req-ts", "1700.55");
    expect((await getHitlForm("req-ts"))?.slackMessageTs).toBe("1700.55");
  });

  describe("claimHitlAnswer (first-click-wins)", () => {
    it("claims an awaiting request and returns the full row", async () => {
      await createHitlForm(input("req-c"));
      const claimed = await claimHitlAnswer("req-c", {
        answeredBy: "U1",
        answers: { q1: { optionIds: ["a"] } }
      });
      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe("answered");
      expect(claimed?.answeredBy).toBe("U1");
      expect(claimed?.answersJson).toEqual({ q1: { optionIds: ["a"] } });
      expect(claimed?.answeredAt).not.toBeNull();
    });

    it("lets exactly one of two racing claims win", async () => {
      await createHitlForm(input("req-race"));
      const [first, second] = await Promise.all([
        claimHitlAnswer("req-race", {
          answeredBy: "U1",
          answers: { q1: { optionIds: ["a"] } }
        }),
        claimHitlAnswer("req-race", {
          answeredBy: "U2",
          answers: { q1: { optionIds: ["b"] } }
        })
      ]);
      const winners = [first, second].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
    });

    it("returns null for an already-answered, expired, or unknown request", async () => {
      await createHitlForm(input("req-d"));
      await claimHitlAnswer("req-d", {
        answeredBy: "U1",
        answers: { q1: { optionIds: ["a"] } }
      });
      expect(
        await claimHitlAnswer("req-d", {
          answeredBy: "U2",
          answers: { q1: { optionIds: ["b"] } }
        })
      ).toBeNull();
      expect(
        await claimHitlAnswer("req-nope", { answeredBy: "U2", answers: {} })
      ).toBeNull();
    });

    it("records a typed answer in place of a pick", async () => {
      await createHitlForm(input("req-free"));
      const claimed = await claimHitlAnswer("req-free", {
        answeredBy: "U1",
        answers: { q1: { text: "something else" } }
      });
      expect(claimed?.answersJson).toEqual({ q1: { text: "something else" } });
    });
  });

  describe("reopenHitlForm", () => {
    /** A task parked on its prompt, as `deliverHitlRequest` leaves it. */
    async function parkedTask(token: string) {
      await createAgentTask({
        token,
        taskId: "task-1",
        agentName: "remoteagent",
        channelId: "C1",
        messageTs: "1700.1",
        replyThreadTs: "1700.1",
        eventId: `Ev-${token}`,
        startedBy: "U1"
      });
      await suspendForInput(token);
    }

    it("reopens an answered request while its task is parked, clearing the answer", async () => {
      await parkedTask("tok-open");
      await createHitlForm(input("req-open", { token: "tok-open" }));
      await claimHitlAnswer("req-open", {
        answeredBy: "U1",
        answers: { q1: { text: "typed" } }
      });

      expect(await reopenHitlForm("req-open")).toBe(true);
      const row = await getHitlForm("req-open");
      expect(row?.status).toBe("awaiting");
      expect(row?.answeredBy).toBeNull();
      expect(row?.answersJson).toBeNull();
      expect(row?.answeredAt).toBeNull();

      // Open again means claimable again.
      expect(
        await claimHitlAnswer("req-open", {
          answeredBy: "U2",
          answers: { q1: { optionIds: ["b"] } }
        })
      ).not.toBeNull();
    });

    it("leaves the answer when the task is no longer parked", async () => {
      await parkedTask("tok-done");
      await createHitlForm(input("req-over", { token: "tok-done" }));
      await claimHitlAnswer("req-over", {
        answeredBy: "U1",
        answers: { q1: { optionIds: ["a"] } }
      });
      // The task finished while the answer was on its way.
      await completeAgentTask("tok-done");

      expect(await reopenHitlForm("req-over")).toBe(false);
      expect((await getHitlForm("req-over"))?.status).toBe("answered");
    });

    it("does not touch a request that was never answered", async () => {
      await parkedTask("tok-idle");
      await createHitlForm(input("req-idle", { token: "tok-idle" }));
      await createHitlForm(input("req-shut", { token: "tok-idle" }));
      await cancelHitlForm("req-shut");

      expect(await reopenHitlForm("req-idle")).toBe(false);
      expect(await reopenHitlForm("req-shut")).toBe(false);
      expect(await reopenHitlForm("req-nope")).toBe(false);
      expect((await getHitlForm("req-shut"))?.status).toBe("canceled");
    });

    it("does not reopen on the strength of another task being parked", async () => {
      await parkedTask("tok-other");
      await createHitlForm(input("req-orphan", { token: "tok-gone" }));
      await claimHitlAnswer("req-orphan", {
        answeredBy: "U1",
        answers: { q1: { optionIds: ["a"] } }
      });

      expect(await reopenHitlForm("req-orphan")).toBe(false);
    });
  });

  describe("cancelHitlRequest", () => {
    it("cancels one awaiting request, once, and leaves its siblings open", async () => {
      await createHitlForm(input("req-one", { token: "tok-z" }));
      await createHitlForm(input("req-two", { token: "tok-z" }));
      expect(await cancelHitlForm("req-one")).toBe(true);
      expect(await cancelHitlForm("req-one")).toBe(false);
      expect((await getHitlForm("req-one"))?.status).toBe("canceled");
      expect((await getHitlForm("req-two"))?.status).toBe("awaiting");
    });

    it("does not reopen or overwrite an answered request", async () => {
      await createHitlForm(input("req-done"));
      await claimHitlAnswer("req-done", {
        answeredBy: "U1",
        answers: { q1: { optionIds: ["a"] } }
      });
      expect(await cancelHitlForm("req-done")).toBe(false);
      expect((await getHitlForm("req-done"))?.status).toBe("answered");
    });
  });

  describe("cancelHitlFormsByToken", () => {
    it("cancels every open request for a token and returns them", async () => {
      await createHitlForm(input("req-e", { token: "tok-x" }));
      await createHitlForm(input("req-f", { token: "tok-x" }));
      const canceled = await cancelHitlFormsByToken("tok-x");
      expect(canceled.map((r) => r.requestId).sort()).toEqual([
        "req-e",
        "req-f"
      ]);
      expect((await getHitlForm("req-e"))?.status).toBe("canceled");
    });

    it("does not touch already-answered requests", async () => {
      await createHitlForm(input("req-g", { token: "tok-y" }));
      await claimHitlAnswer("req-g", {
        answeredBy: "U1",
        answers: { q1: { optionIds: ["a"] } }
      });
      const canceled = await cancelHitlFormsByToken("tok-y");
      expect(canceled).toHaveLength(0);
      expect((await getHitlForm("req-g"))?.status).toBe("answered");
    });
  });

  describe("expireStaleHitlForms", () => {
    it("expires only awaiting requests past their deadline", async () => {
      const now = Math.floor(Date.now() / 1000);
      await createHitlForm(input("req-past", { deadlineAt: now - 10 }));
      await createHitlForm(input("req-future", { deadlineAt: now + 1000 }));
      const expired = await expireStaleHitlForms(now);
      expect(expired.map((r) => r.requestId)).toEqual(["req-past"]);
      expect((await getHitlForm("req-past"))?.status).toBe("expired");
      expect((await getHitlForm("req-future"))?.status).toBe("awaiting");
    });
  });

  it("keeps each person's way through a paged form apart, while it is open", async () => {
    await createHitlForm(input("req-d"));
    const one = { page: 1, answers: { q1: { optionIds: ["a"] as [string] } } };
    const two = { page: 0, answers: { q1: { text: "neither" } } };
    expect(await saveHitlDraft("req-d", "U1", one)).toBe(true);
    expect(await saveHitlDraft("req-d", "U2", two)).toBe(true);
    expect(await saveHitlDraft("req-d", "U1", { ...one, page: 2 })).toBe(true);

    const row = (await getHitlForm("req-d"))!;
    expect(hitlDraftOf(row, "U1")).toEqual({ ...one, page: 2 });
    expect(hitlDraftOf(row, "U2")).toEqual(two);
    expect(hitlDraftOf(row, "U3")).toBeUndefined();
    // Not a key a Slack user id could be.
    expect(await saveHitlDraft("req-d", 'U1"]', one)).toBe(false);

    await claimHitlAnswer("req-d", {
      answeredBy: "U2",
      answers: { q1: { text: "neither" } }
    });
    expect(await saveHitlDraft("req-d", "U1", one)).toBe(false);
  });

  it("sweeps only resolved rows older than the cutoff", async () => {
    await createHitlForm(input("req-sweep"));
    expect(await sweepStaleHitlForms(24 * 60 * 60)).toBe(0);
    // A negative window (cutoff in the future) collects everything.
    expect(await sweepStaleHitlForms(-10)).toBeGreaterThanOrEqual(1);
    expect(await getHitlForm("req-sweep")).toBeNull();
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
      eventId: "Ev1",
      startedBy: "U1"
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
