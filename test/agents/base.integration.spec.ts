import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { MockLanguageModelV4 } from "ai/test";
import { Sessions, type SessionMessage } from "agents/sessions";
import type { AdminAgent } from "@/server";
import { COMPACT_AFTER_TOKENS, COMPACT_TAIL_TOKENS } from "@/config";
import { buildAgentSession } from "@/agents/shared/session";
import { adminSoul } from "@/agents/admin/prompt";

/**
 * The production session path, on a real agent Durable Object.
 *
 * Every other executor spec injects `createSession`, so the wiring between an
 * agent DO and its session — the `Sessions` capability the base class installs,
 * the startup migration that capability runs, the SQLite the context blocks
 * store themselves in — is exercised by nothing but this file. A break here is
 * a production break that a green unit suite would not report, which is why the
 * seams stop at the DO boundary and this spec starts there.
 *
 * `AdminAgent` is the instance under test only because it is a concrete
 * `A2AAgent`: nothing below reads anything the admin adds on top.
 */

/** The summarizer `buildAgentSession` takes; compaction never fires here. */
const model = new MockLanguageModelV4({
  doGenerate: async () => {
    throw new Error("the summarizer must not be called");
  }
});

/** Fresh DO per case, so a startup migration is a startup in every one of them. */
let instances = 0;
function withAgent<T>(
  label: string,
  fn: (agent: AdminAgent, state: DurableObjectState) => Promise<T>
): Promise<T> {
  const name = `admin:base-integration-${label}-${instances++}`;
  const stub = env.AdminAgent.get(env.AdminAgent.idFromName(name));
  return runInDurableObject(stub, fn);
}

/** The session the admin executor builds in production, minus the archiver. */
function realSession(agent: AdminAgent, wsId = 0) {
  return buildAgentSession(agent, model, {
    soul: () => adminSoul(wsId),
    memoryDescription: "Durable facts about this workspace.",
    memoryMaxTokens: 1200,
    compactAfterTokens: COMPACT_AFTER_TOKENS,
    compactTailTokens: COMPACT_TAIL_TOKENS
  });
}

function userMsg(id: string, text: string): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

describe("an agent Durable Object's session", () => {
  it("installs the Sessions capability in the constructor", async () => {
    await withAgent("capability", async (agent, state) => {
      expect(agent.sessions).toBeInstanceOf(Sessions);

      // `buildAgentSession` reads `agent.sessions`, and a capability can only be
      // registered before the lifecycle starts — so a base class that stopped
      // doing it in the constructor would fail here and nowhere else. Reading
      // history is what proves it: an uninstalled capability throws "must be
      // installed with Lifecycle.use()" the first time it reaches its services.
      const { session } = realSession(agent);
      expect(await session.getHistory()).toEqual([]);

      // And registration is what *started* it. The capability's `onStart` is the
      // only thing that creates these tables — nothing on the read or write path
      // does — so their existence in this object's SQLite is the startup hook
      // having run here, not merely a handle having been handed out.
      const tables = [
        ...state.storage.sql.exec<{ name: string }>(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'cf_agents_session_%' ORDER BY name`
        )
      ].map((r) => r.name);
      expect(tables).toContain("cf_agents_session_messages");
      expect(tables).toContain("cf_agents_session_compactions");
    });
  });

  it("round-trips a message through the DO's own SQLite", async () => {
    await withAgent("round-trip", async (agent, state) => {
      const { session } = realSession(agent);

      await session.appendMessage(userMsg("m1", "who am I talking to?"));
      await session.appendMessage({
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "the admin agent" }]
      });

      const history = await session.getHistory();
      expect(history.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(history[0].parts).toEqual([
        { type: "text", text: "who am I talking to?" }
      ]);

      // Durable, not in-memory: the rows are in this object's SQLite, and a
      // session built again over the same DO reads them back.
      const rows = [
        ...state.storage.sql.exec(
          "SELECT id FROM cf_agents_session_messages ORDER BY seq"
        )
      ];
      expect(rows.map((r) => r.id)).toEqual(["m1", "m2"]);

      const reopened = await realSession(agent).session.getHistory();
      expect(reopened.map((m) => m.id)).toEqual(["m1", "m2"]);
    });
  });

  it("renders the soul block into the system prompt", async () => {
    await withAgent("soul", async (agent) => {
      const { context } = realSession(agent);
      const prompt = await context.refreshSystemPrompt();

      // The block is there, read-only, and carries the real identity text — an
      // assertion on the header alone would survive an empty provider.
      expect(prompt).toContain("SOUL [readonly]");
      expect(prompt).toContain(adminSoul(0));
      expect(prompt).toContain("MEMORY");
    });
  });

  it("offers set_context, and what it writes is what the next prompt renders", async () => {
    await withAgent("set-context", async (agent, state) => {
      const { context } = realSession(agent);
      const tools = await context.tools();
      expect(Object.keys(tools)).toContain("set_context");

      const execute = tools.set_context.execute as (
        args: { label: string; content: string },
        opts?: unknown
      ) => Promise<string>;
      expect(
        await execute(
          { label: "memory", content: "U1 is the primary owner." },
          {}
        )
      ).toContain("Written to memory");

      // Through the real `AgentContextProvider`, so it lands in the DO's own
      // context table rather than in the block's memory.
      const rows = [
        ...state.storage.sql.exec<{ label: string; content: string }>(
          "SELECT label, content FROM cf_agents_context_blocks"
        )
      ];
      expect(rows).toEqual([
        { label: "memory", content: "U1 is the primary owner." }
      ]);

      expect(await context.refreshSystemPrompt()).toContain(
        "U1 is the primary owner."
      );
    });
  });

  it("lifts a legacy assistant_messages row into history on startup", async () => {
    await withAgent("legacy", async (agent, state) => {
      // A DO written by the pre-0.23 session store, before its first start on
      // the new one: the old tables, and no schema version stamped.
      state.storage.sql.exec(`CREATE TABLE assistant_messages (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      state.storage.sql.exec(
        `INSERT INTO assistant_messages (session_id, id, parent_id, role, content, created_at)
         VALUES ('', 'old-1', NULL, 'user', ?, '2026-09-01 12:00:00')`,
        JSON.stringify(userMsg("old-1", "a question from before the upgrade"))
      );
      state.storage.sql.exec(`CREATE TABLE assistant_sessions (
        id TEXT PRIMARY KEY
      )`);

      // The first session read is the first lifecycle start, which is where the
      // capability runs the lift.
      const { session } = realSession(agent);
      const history = await session.getHistory();

      expect(history.map((m) => m.id)).toEqual(["old-1"]);
      expect(history[0].parts).toEqual([
        { type: "text", text: "a question from before the upgrade" }
      ]);

      // Lifted, then dropped — an upgraded object must not carry its history
      // twice, and the retired session table goes with it.
      const tables = [
        ...state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'assistant_%'"
        )
      ].map((r) => r.name);
      expect(tables).toEqual([]);

      // A message appended after the lift continues the same history.
      await session.appendMessage(userMsg("new-1", "and one after it"));
      expect((await session.getHistory()).map((m) => m.id)).toEqual([
        "old-1",
        "new-1"
      ]);
    });
  });
});
