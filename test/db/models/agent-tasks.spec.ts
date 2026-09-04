import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { registerAgent } from "@/db/models/agents";
import {
  createAgentTask,
  getAgentTaskByToken,
  getPendingAgentTasksByChannelAndTs,
  completeAgentTask,
  recordReceivedMessageId,
  updateAgentTaskTaskId,
  markCancelRequested,
  markAgentTaskCanceled,
  suspendForInput,
  isTerminalTaskStatus,
  getPendingAgentTasksByEventId,
  deleteAgentTask,
  sweepStaleAgentTasks,
  type CreateAgentTaskInput
} from "@/db/models/agent-tasks";

// agent_tasks.agent_name is an FK; seed a real agent so inserts satisfy it.
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

function input(token: string, over: Partial<CreateAgentTaskInput> = {}) {
  return {
    token,
    taskId: "task-1",
    agentName: "remoteagent",
    channelId: "C1",
    messageTs: "1700.1",
    replyThreadTs: null,
    eventId: "Ev1",
    ...over
  } satisfies CreateAgentTaskInput;
}

describe("agent-tasks model", () => {
  it("creates and reads a pending task", async () => {
    await createAgentTask(input("tok-a"));
    const row = await getAgentTaskByToken("tok-a");
    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending");
    expect(row?.channelId).toBe("C1");
    expect(row?.replyThreadTs).toBeNull();
  });

  // message_ts is the 🛑 stop reaction's only lookup key (a reaction event
  // carries just item.channel + item.ts), so a NULL would make the row
  // permanently uncancelable. Pinned at the DB level via raw SQL — the drizzle
  // types make it unrepresentable through createAgentTask.
  it("rejects a task row without a message_ts", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO agent_tasks (token, agent_name, channel_id, event_id) VALUES ('tok-null-ts', 'remoteagent', 'C1', 'Ev1')"
      ).run()
    ).rejects.toThrow(/NOT NULL/i);
  });

  it("is idempotent on the token PK (no throw, no clobber)", async () => {
    await createAgentTask(input("tok-b", { channelId: "C1" }));
    // A retry with a different payload must not overwrite the original row.
    await createAgentTask(input("tok-b", { channelId: "C_OTHER" }));
    const row = await getAgentTaskByToken("tok-b");
    expect(row?.channelId).toBe("C1");
  });

  it("completes exactly once (idempotency signal)", async () => {
    await createAgentTask(input("tok-c"));
    expect(await completeAgentTask("tok-c")).toBe(true);
    // Second flip is a no-op — the row is already completed.
    expect(await completeAgentTask("tok-c")).toBe(false);
    const row = await getAgentTaskByToken("tok-c");
    expect(row?.status).toBe("completed");
    expect(row?.completedAt).not.toBeNull();
  });

  it("backfills the remote task id on a pending row, not a completed one", async () => {
    await createAgentTask(input("tok-upd", { taskId: null }));
    await updateAgentTaskTaskId("tok-upd", "task-remote-9");
    expect((await getAgentTaskByToken("tok-upd"))?.taskId).toBe(
      "task-remote-9"
    );

    // Once completed, the callback owns the row — a late backfill must not touch it.
    expect(await completeAgentTask("tok-upd")).toBe(true);
    await updateAgentTaskTaskId("tok-upd", "task-remote-late");
    expect((await getAgentTaskByToken("tok-upd"))?.taskId).toBe(
      "task-remote-9"
    );
  });

  it("deletes a row by token, and is a no-op on an unknown token", async () => {
    await createAgentTask(input("tok-del"));
    expect(await getAgentTaskByToken("tok-del")).not.toBeNull();
    await deleteAgentTask("tok-del");
    expect(await getAgentTaskByToken("tok-del")).toBeNull();
    // Deleting a token that was never written (or already gone) must not throw.
    await expect(deleteAgentTask("tok-nope")).resolves.toBeUndefined();
  });

  it("sweeps only rows older than the cutoff", async () => {
    await createAgentTask(input("tok-d"));
    // Fresh rows survive a 24h sweep...
    expect(await sweepStaleAgentTasks(24 * 60 * 60)).toBe(0);
    expect(await getAgentTaskByToken("tok-d")).not.toBeNull();
    // ...but a negative window (cutoff in the future) collects everything.
    expect(await sweepStaleAgentTasks(-10)).toBeGreaterThanOrEqual(1);
    expect(await getAgentTaskByToken("tok-d")).toBeNull();
  });

  describe("recordReceivedMessageId", () => {
    it("returns true and records the id on first call", async () => {
      await createAgentTask(input("tok-rid-a"));
      expect(await recordReceivedMessageId("tok-rid-a", "msg-1")).toBe(true);
      const row = await getAgentTaskByToken("tok-rid-a");
      expect(row?.receivedMessageIds).toContain("msg-1");
    });

    it("returns false and does not duplicate on a repeated id (idempotent)", async () => {
      await createAgentTask(input("tok-rid-b"));
      expect(await recordReceivedMessageId("tok-rid-b", "msg-1")).toBe(true);
      expect(await recordReceivedMessageId("tok-rid-b", "msg-1")).toBe(false);
      const row = await getAgentTaskByToken("tok-rid-b");
      // Exactly one occurrence in the stored string.
      expect(row?.receivedMessageIds?.split("msg-1").length).toBe(2);
    });

    it("accumulates multiple distinct ids", async () => {
      await createAgentTask(input("tok-rid-c"));
      expect(await recordReceivedMessageId("tok-rid-c", "msg-1")).toBe(true);
      expect(await recordReceivedMessageId("tok-rid-c", "msg-2")).toBe(true);
      expect(await recordReceivedMessageId("tok-rid-c", "msg-3")).toBe(true);
      const row = await getAgentTaskByToken("tok-rid-c");
      expect(row?.receivedMessageIds).toContain("msg-1");
      expect(row?.receivedMessageIds).toContain("msg-2");
      expect(row?.receivedMessageIds).toContain("msg-3");
    });

    it("does not match a substring as a duplicate (msg-1 vs msg-10)", async () => {
      await createAgentTask(input("tok-rid-d"));
      expect(await recordReceivedMessageId("tok-rid-d", "msg-1")).toBe(true);
      // msg-10 must be treated as a new id, not a duplicate of msg-1.
      expect(await recordReceivedMessageId("tok-rid-d", "msg-10")).toBe(true);
    });

    it("treats LIKE metacharacters in the id literally, not as wildcards", async () => {
      await createAgentTask(input("tok-rid-wild"));
      // Store a concrete id, then push a distinct id whose `_`/`%` would be
      // wildcards under a LIKE membership test and falsely match it — dropping
      // a genuine update. With an exact (instr) check both must be recorded.
      expect(await recordReceivedMessageId("tok-rid-wild", "msg-1")).toBe(true);
      expect(await recordReceivedMessageId("tok-rid-wild", "msg-_")).toBe(true);
      expect(await recordReceivedMessageId("tok-rid-wild", "%")).toBe(true);
      // And each remains idempotent on its own literal value.
      expect(await recordReceivedMessageId("tok-rid-wild", "msg-_")).toBe(
        false
      );
      expect(await recordReceivedMessageId("tok-rid-wild", "%")).toBe(false);
    });

    it("strips commas and whitespace from the id before storing/matching", async () => {
      await createAgentTask(input("tok-rid-comma"));
      // The comma is the set delimiter (a raw one would corrupt membership) and
      // whitespace is meaningless in an opaque id, so both are removed: `a, b`
      // is recorded as `ab` and a later `ab` is deduped against it.
      expect(await recordReceivedMessageId("tok-rid-comma", "a, b")).toBe(true);
      const row = await getAgentTaskByToken("tok-rid-comma");
      expect(row?.receivedMessageIds).toBe("ab");
      expect(await recordReceivedMessageId("tok-rid-comma", "ab")).toBe(false);
    });

    it("returns false for a completed task", async () => {
      await createAgentTask(input("tok-rid-e"));
      await completeAgentTask("tok-rid-e");
      expect(await recordReceivedMessageId("tok-rid-e", "msg-1")).toBe(false);
    });

    it("returns false for an unknown token", async () => {
      expect(await recordReceivedMessageId("tok-nope", "msg-1")).toBe(false);
    });
  });

  describe("getPendingAgentTasksByChannelAndTs", () => {
    it("returns every pending task of a trigger message's fan-out", async () => {
      await createAgentTask(
        input("fan-a", { channelId: "C9", messageTs: "1800.1" })
      );
      await createAgentTask(
        input("fan-b", { channelId: "C9", messageTs: "1800.1" })
      );
      const rows = await getPendingAgentTasksByChannelAndTs("C9", "1800.1");
      expect(rows.map((r) => r.token).sort()).toEqual(["fan-a", "fan-b"]);
    });

    it("excludes completed tasks and other channels/timestamps", async () => {
      await createAgentTask(
        input("keep", { channelId: "C9", messageTs: "1800.2" })
      );
      await createAgentTask(
        input("done", { channelId: "C9", messageTs: "1800.2" })
      );
      await completeAgentTask("done");
      await createAgentTask(
        input("other-ts", { channelId: "C9", messageTs: "1800.9" })
      );
      await createAgentTask(
        input("other-ch", { channelId: "C_OTHER", messageTs: "1800.2" })
      );
      const rows = await getPendingAgentTasksByChannelAndTs("C9", "1800.2");
      expect(rows.map((r) => r.token)).toEqual(["keep"]);
    });
  });

  describe("cancel handshake (markCancelRequested / updateAgentTaskTaskId)", () => {
    it("markCancelRequested returns the taskId when the accept already committed", async () => {
      await createAgentTask(input("mc-a", { taskId: "task-x" }));
      const res = await markCancelRequested("mc-a");
      expect(res).toEqual({ matched: true, taskId: "task-x" });
      expect((await getAgentTaskByToken("mc-a"))?.cancelRequested).toBe(1);
    });

    it("markCancelRequested records intent (null taskId) before the accept", async () => {
      await createAgentTask(input("mc-b", { taskId: null }));
      const res = await markCancelRequested("mc-b");
      expect(res).toEqual({ matched: true, taskId: null });
      expect((await getAgentTaskByToken("mc-b"))?.cancelRequested).toBe(1);
    });

    it("markCancelRequested is a no-op (matched:false) on a completed/unknown row", async () => {
      await createAgentTask(input("mc-c"));
      await completeAgentTask("mc-c");
      expect(await markCancelRequested("mc-c")).toEqual({
        matched: false,
        taskId: null
      });
      expect(await markCancelRequested("mc-nope")).toEqual({
        matched: false,
        taskId: null
      });
    });

    it("updateAgentTaskTaskId reports a stop that landed during the send", async () => {
      // No stop yet → backfills and reports false.
      await createAgentTask(input("upd-clean", { taskId: null }));
      expect(await updateAgentTaskTaskId("upd-clean", "task-1")).toBe(false);

      // Stop recorded first (accept-then-tap handshake) → reports true.
      await createAgentTask(input("upd-stop", { taskId: null }));
      await markCancelRequested("upd-stop");
      expect(await updateAgentTaskTaskId("upd-stop", "task-2")).toBe(true);
    });
  });
  describe("terminal states", () => {
    it("markAgentTaskCanceled terminalizes a pending row, once", async () => {
      await createAgentTask(input("cx-a"));
      expect(await markAgentTaskCanceled("cx-a")).toBe(true);
      const row = await getAgentTaskByToken("cx-a");
      expect(row?.status).toBe("canceled");
      expect(row?.completedAt).toBeTruthy();
      // Idempotent: a replayed cancel flips nothing and reports it.
      expect(await markAgentTaskCanceled("cx-a")).toBe(false);
    });

    it("cancels a task parked on a human prompt", async () => {
      // A 🛑 must still reach a task waiting on an answer, so `awaiting-input` is
      // not terminal and stays cancelable.
      await createAgentTask(input("cx-park"));
      await suspendForInput("cx-park");
      expect(await markAgentTaskCanceled("cx-park")).toBe(true);
      expect((await getAgentTaskByToken("cx-park"))?.status).toBe("canceled");
    });

    it("never reopens a terminal row", async () => {
      // The invariant behind dropping late callbacks: once the gatekeeper has given
      // up on a task, a reply arriving afterwards cannot resurrect it.
      await createAgentTask(input("cx-b"));
      await markAgentTaskCanceled("cx-b");
      expect(await completeAgentTask("cx-b")).toBe(false);
      expect((await getAgentTaskByToken("cx-b"))?.status).toBe("canceled");

      await createAgentTask(input("cx-c"));
      await completeAgentTask("cx-c");
      expect(await markAgentTaskCanceled("cx-c")).toBe(false);
      expect((await getAgentTaskByToken("cx-c"))?.status).toBe("completed");
    });

    it("excludes every terminal status from the pending lookups", async () => {
      await createAgentTask(input("cx-done", { eventId: "EvTerm" }));
      await createAgentTask(input("cx-stop", { eventId: "EvTerm" }));
      await createAgentTask(input("cx-live", { eventId: "EvTerm" }));
      await completeAgentTask("cx-done");
      await markAgentTaskCanceled("cx-stop");

      const byEvent = await getPendingAgentTasksByEventId("EvTerm");
      expect(byEvent.map((r) => r.token)).toEqual(["cx-live"]);

      const byMessage = await getPendingAgentTasksByChannelAndTs(
        "C1",
        "1700.1"
      );
      expect(byMessage.map((r) => r.token)).toContain("cx-live");
      expect(byMessage.map((r) => r.token)).not.toContain("cx-done");
      expect(byMessage.map((r) => r.token)).not.toContain("cx-stop");
    });

    it("classifies which statuses are over", () => {
      expect(isTerminalTaskStatus("completed")).toBe(true);
      expect(isTerminalTaskStatus("canceled")).toBe(true);
      expect(isTerminalTaskStatus("pending")).toBe(false);
      // Parked is *not* terminal: the fan-out stays undrained and the 🛑 alive.
      expect(isTerminalTaskStatus("awaiting-input")).toBe(false);
    });
  });
});
