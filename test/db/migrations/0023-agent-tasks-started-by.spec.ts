import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { registerAgent } from "@/db/models/agents";
import {
  createAgentTask,
  getAgentTaskByToken,
  STARTED_BY_UNKNOWN
} from "@/db/models/agent-tasks";
import { createHitlForm, getHitlForm } from "@/db/models/hitl-forms";
import { applyPendingMigrations, useStorageReset } from "../../helpers/storage";
import { choiceForm } from "../../helpers/hitl";

// The schema as of the migration *before* the one under test: an `agent_tasks`
// with no `started_by` column at all. Every test here seeds rows onto that, then
// runs 0023 over them, which is the only way to see what it does to rows the
// code before it wrote — the suite's usual reset replays 0023 onto an empty
// table.
useStorageReset({ through: "0022_hitl_forms" });

/** A pre-0023 task row: the column list the code before the migration wrote. */
async function insertLegacyTask(
  token: string,
  over: { replyThreadTs?: string | null; completedAt?: number | null } = {}
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_tasks (token, task_id, agent_name, channel_id, message_ts, reply_thread_ts, event_id, status, cancel_requested, last_error, received_message_ids, created_at, completed_at)
     VALUES (?, 'task-1', 'remoteagent', 'C1', '1700.1', ?, 'Ev1', 'completed', 1, 'bad signature', 'm1,m2', 1700000000, ?)`
  )
    .bind(
      token,
      over.replyThreadTs === undefined ? "1700.1" : over.replyThreadTs,
      over.completedAt === undefined ? 1700000099 : over.completedAt
    )
    .run();
}

beforeEach(async () => {
  // agent_tasks.agent_name is an FK, and the rebuild re-declares it — seed the
  // parent so both the copy and the inserts afterwards have one to satisfy.
  await registerAgent({
    name: "remoteagent",
    kind: "remote",
    a2aEndpoint: "https://agent.example.com/a2a",
    tenantId: "main",
    notifyOn: "mention",
    workspaceId: 0
  });
});

/** PRAGMA table_info for one column of one table. */
async function columnInfo(
  table: string,
  column: string
): Promise<Record<string, unknown> | undefined> {
  const { results } = await env.DB.prepare(
    `PRAGMA table_info("${table}")`
  ).all<Record<string, unknown>>();
  return results.find((c) => c.name === column);
}

/**
 * 0023 rebuilds `agent_tasks` to add `started_by` NOT NULL with no default,
 * which is a thing SQLite cannot do in place. What the rebuild has to get right
 * is everything it copies: the rows, their nulls, the table's keys, its indexes
 * and its foreign key — and the one value it invents, for the rows written
 * before the column existed.
 */
describe("0023 — agent_tasks.started_by", () => {
  it("backfills the rows written before the column with the unknown sentinel", async () => {
    await insertLegacyTask("tok-legacy");
    await applyPendingMigrations();

    expect((await getAgentTaskByToken("tok-legacy"))?.startedBy).toBe(
      STARTED_BY_UNKNOWN
    );
  });

  it("copies every other column of those rows through unchanged", async () => {
    await insertLegacyTask("tok-full");
    // A second row carrying nulls where the column list allows them, so the copy
    // is seen to preserve a null rather than coerce it.
    await insertLegacyTask("tok-nulls", {
      replyThreadTs: null,
      completedAt: null
    });
    await applyPendingMigrations();

    expect(await getAgentTaskByToken("tok-full")).toMatchObject({
      token: "tok-full",
      taskId: "task-1",
      agentName: "remoteagent",
      channelId: "C1",
      messageTs: "1700.1",
      replyThreadTs: "1700.1",
      eventId: "Ev1",
      startedBy: STARTED_BY_UNKNOWN,
      status: "completed",
      cancelRequested: 1,
      lastError: "bad signature",
      receivedMessageIds: "m1,m2",
      createdAt: 1700000000,
      completedAt: 1700000099
    });
    expect(await getAgentTaskByToken("tok-nulls")).toMatchObject({
      replyThreadTs: null,
      completedAt: null
    });
  });

  it("leaves the prompt rows paired with those tasks alone", async () => {
    await insertLegacyTask("tok-parked");
    await createHitlForm({
      requestId: "req-parked",
      token: "tok-parked",
      taskId: "task-1",
      contextId: "C1:1700.1",
      agentName: "remoteagent",
      channelId: "C1",
      threadTs: "1700.1",
      request: choiceForm("req-parked"),
      deadlineAt: 1700000600
    });
    await applyPendingMigrations();

    // hitl_forms pairs with a task by `token` and is not rebuilt here, so a
    // prompt open across the migration still finds its row — and its task.
    expect((await getHitlForm("req-parked"))?.token).toBe("tok-parked");
    expect(await getAgentTaskByToken("tok-parked")).not.toBeNull();
  });

  it("leaves the column NOT NULL with no default", async () => {
    await applyPendingMigrations();

    // `dflt_value` null is the whole claim: the value `unknown` exists in the
    // backfill above and nowhere in the table's DDL, so nothing inserted
    // afterwards can fall back on it.
    expect(await columnInfo("agent_tasks", "started_by")).toMatchObject({
      notnull: 1,
      dflt_value: null
    });
  });

  it("refuses a new row that omits started_by, and one that nulls it", async () => {
    await applyPendingMigrations();

    await expect(
      env.DB.prepare(
        `INSERT INTO agent_tasks (token, agent_name, channel_id, message_ts, event_id)
         VALUES ('tok-omitted', 'remoteagent', 'C1', '1700.1', 'Ev1')`
      ).run()
    ).rejects.toThrow(/NOT NULL/i);
    await expect(
      env.DB.prepare(
        `INSERT INTO agent_tasks (token, agent_name, channel_id, message_ts, event_id, started_by)
         VALUES ('tok-null', 'remoteagent', 'C1', '1700.1', 'Ev1', NULL)`
      ).run()
    ).rejects.toThrow(/NOT NULL/i);
    // What the Worker writes instead, on the rebuilt table.
    await createAgentTask({
      token: "tok-new",
      taskId: "task-1",
      agentName: "remoteagent",
      channelId: "C1",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "Ev1",
      startedBy: "U1"
    });
    expect((await getAgentTaskByToken("tok-new"))?.startedBy).toBe("U1");
  });

  it("keeps the rebuilt table's key, indexes and foreign key", async () => {
    await insertLegacyTask("tok-keys");
    await applyPendingMigrations();

    expect(await columnInfo("agent_tasks", "token")).toMatchObject({
      pk: 1,
      notnull: 1
    });
    // The PK still rejects a second row on the copied row's token, which is what
    // makes `createAgentTask`'s onConflictDoNothing idempotent on a push retry.
    await expect(
      env.DB.prepare(
        `INSERT INTO agent_tasks (token, agent_name, channel_id, message_ts, event_id, started_by)
         VALUES ('tok-keys', 'remoteagent', 'C1', '1700.1', 'Ev1', 'U1')`
      ).run()
    ).rejects.toThrow(/UNIQUE/i);

    const { results: indexes } = await env.DB.prepare(
      `PRAGMA index_list("agent_tasks")`
    ).all<{ name: string }>();
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining([
        "idx_agent_tasks_created_at",
        "idx_agent_tasks_channel_message_ts",
        "idx_agent_tasks_event_id"
      ])
    );

    const { results: fks } = await env.DB.prepare(
      `PRAGMA foreign_key_list("agent_tasks")`
    ).all<{ table: string; from: string; to: string }>();
    expect(fks).toMatchObject([
      { table: "agents", from: "agent_name", to: "name" }
    ]);
    // Declared and enforced: an unknown agent is still refused.
    await expect(
      env.DB.prepare(
        `INSERT INTO agent_tasks (token, agent_name, channel_id, message_ts, event_id, started_by)
         VALUES ('tok-orphan', 'nosuchagent', 'C1', '1700.1', 'Ev1', 'U1')`
      ).run()
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});
