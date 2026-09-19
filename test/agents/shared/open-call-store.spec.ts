import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { HITL_REQUEST_TTL_SECONDS } from "@/config";
import type { OpenCall } from "@/agents/shared/open-call";
import { DurableOpenCalls } from "@/agents/shared/open-call-store";
import { useStorageReset } from "../../helpers/storage";

useStorageReset();

/**
 * Run against a real Durable Object's storage, one fresh instance per case so
 * nothing leaks between them.
 */
let instances = 0;
function withStorage<T>(
  fn: (storage: DurableObjectStorage) => Promise<T>
): Promise<T> {
  const name = `admin:open-calls-${instances++}`;
  const stub = env.AdminAgent.get(env.AdminAgent.idFromName(name));
  return runInDurableObject(stub, (_agent, state) => fn(state.storage));
}

function prompt(requestId: string, createdAt = Date.now()): OpenCall {
  return {
    requestId,
    toolCallId: `tc-${requestId}`,
    toolName: "ask_user",
    input: { question: "Which environment?", options: [{ label: "dev" }] },
    createdAt
  };
}

const ignore = async () => {};

describe("DurableOpenCalls", () => {
  it("hands a call to a later instance over the same storage", async () => {
    await withStorage(async (storage) => {
      const kept = prompt("r1");
      await new DurableOpenCalls(storage).put(kept);

      // The human answers days later, on an isolate that never saw the question.
      const recorded: OpenCall[] = [];
      const settled = await new DurableOpenCalls(storage).settle(
        "r1",
        async (p) => {
          recorded.push(p);
        }
      );
      expect(settled).toEqual(kept);
      expect(recorded).toEqual([kept]);
    });
  });

  it("forgets a call only once it has been recorded", async () => {
    await withStorage(async (storage) => {
      const store = new DurableOpenCalls(storage);
      await store.put(prompt("r1"));

      // Still there while the answer is being written — a reset at this point must
      // not have lost the only copy.
      let heldWhileRecording: unknown;
      await store.settle("r1", async () => {
        heldWhileRecording = await storage.get("hitl:open:r1");
      });

      expect(heldWhileRecording).toBeDefined();
      expect(await storage.get("hitl:open:r1")).toBeUndefined();
    });
  });

  it("keeps a call whose recording failed", async () => {
    await withStorage(async (storage) => {
      const store = new DurableOpenCalls(storage);
      await store.put(prompt("r1"));

      await expect(
        store.settle("r1", async () => {
          throw new Error("history is unavailable");
        })
      ).rejects.toThrow("history is unavailable");

      expect(await store.settle("r1", ignore)).not.toBeNull();
    });
  });

  it("settles a call once: a second answer finds nothing and records nothing", async () => {
    await withStorage(async (storage) => {
      const store = new DurableOpenCalls(storage);
      await store.put(prompt("r1"));
      let records = 0;
      const record = async () => {
        records++;
      };

      expect(await store.settle("r1", record)).not.toBeNull();
      expect(await store.settle("r1", record)).toBeNull();
      expect(records).toBe(1);
    });
  });

  it("finds nothing for an id it never held", async () => {
    await withStorage(async (storage) => {
      expect(
        await new DurableOpenCalls(storage).settle("nope", ignore)
      ).toBeNull();
    });
  });

  it("drops calls past the HITL TTL when it keeps another", async () => {
    await withStorage(async (storage) => {
      // A call stopped with 🛑 is never answered, so nothing else removes it.
      const stale = prompt(
        "stale",
        Date.now() - (HITL_REQUEST_TTL_SECONDS + 60) * 1000
      );
      await storage.put(`hitl:open:${stale.requestId}`, stale);
      const store = new DurableOpenCalls(storage);

      await store.put(prompt("fresh"));

      expect(await store.settle("stale", ignore)).toBeNull();
      expect(await store.settle("fresh", ignore)).not.toBeNull();
    });
  });
});
