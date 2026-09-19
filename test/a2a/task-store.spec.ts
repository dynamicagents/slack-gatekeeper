import { describe, it, expect, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { TaskState } from "@a2a-js/sdk";
import { DurableTaskStore } from "@/a2a/task-store";
import { HITL_REQUEST_TTL_SECONDS, TASK_RETENTION_SECONDS } from "@/config";
import { dataPart, textPart } from "@/a2a/parts";
import { makeTask } from "../helpers/a2a";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

/**
 * Run against a real Durable Object's storage, one fresh instance per case so
 * nothing leaks between them.
 */
let instances = 0;
function withStorage<T>(
  fn: (storage: DurableObjectStorage) => Promise<T>
): Promise<T> {
  const name = `admin:task-store-${instances++}`;
  const stub = env.AdminAgent.get(env.AdminAgent.idFromName(name));
  return runInDurableObject(stub, (agent, state) => fn(state.storage));
}

const completed = (id: string) =>
  makeTask({ id, state: TaskState.TASK_STATE_COMPLETED });

/**
 * Wrap storage to record how the sweep drives it. The runtime caps a batch
 * `delete` at 128 keys and warns against an unbounded `list`, but neither is
 * enforced by the local test runtime — so the limits have to be asserted on the
 * calls themselves rather than waited on as a thrown error.
 */
function recordingStorage(storage: DurableObjectStorage) {
  const deleteBatches: number[] = [];
  const listLimits: (number | undefined)[] = [];
  const proxy = new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === "delete") {
        return (keys: string | string[], options?: DurableObjectPutOptions) => {
          if (Array.isArray(keys)) deleteBatches.push(keys.length);
          return target.delete(keys as string[], options);
        };
      }
      if (prop === "list") {
        return (options?: DurableObjectListOptions) => {
          listLimits.push(options?.limit);
          return target.list(options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { storage: proxy, deleteBatches, listLimits };
}

afterEach(() => vi.useRealTimers());

describe("DurableTaskStore", () => {
  it("hands a saved task to a later instance over the same storage", async () => {
    // The point of the store: a second instance over one storage is exactly what
    // a resumed turn meets after its Durable Object has been evicted. An
    // in-memory store loses the task here, which is what stranded an approved
    // agent deletion in production with `TaskNotFound`.
    await withStorage(async (storage) => {
      const task = makeTask({
        id: "task-parked",
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        text: "Approve?"
      });
      await new DurableTaskStore(storage).save(task);

      expect(await new DurableTaskStore(storage).load("task-parked")).toEqual(
        task
      );
    });
  });

  it("round-trips the protobuf shapes a raw clone would corrupt", async () => {
    // `TaskState` is a numeric enum and `Part.content` is a `$case` oneof; both
    // survive only because save/load go through the generated codec. A store
    // that persisted the in-memory object as-is would read back a string state
    // and a flattened part, and nothing downstream would notice until it did.
    await withStorage(async (storage) => {
      const task = makeTask({
        id: "task-shapes",
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        parts: [textPart("pick one"), dataPart({ kind: "approval" })]
      });
      await new DurableTaskStore(storage).save(task);
      const loaded = await new DurableTaskStore(storage).load("task-shapes");

      expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
      expect(typeof loaded?.status?.state).toBe("number");
      expect(loaded?.status?.message?.parts).toEqual(
        task.status?.message?.parts
      );
    });
  });

  it("returns undefined for a task it has never seen", async () => {
    await withStorage(async (storage) => {
      const store = new DurableTaskStore(storage);
      expect(await store.load("task-missing")).toBeUndefined();
    });
  });

  it("sweeps tasks past retention and keeps the rest", async () => {
    await withStorage(async (storage) => {
      const store = new DurableTaskStore(storage);
      vi.useFakeTimers();

      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      await store.save(completed("task-old-1"));
      await store.save(completed("task-old-2"));
      // Retention runs from the write, so one saved inside the window stays.
      vi.setSystemTime(new Date("2026-01-29T00:00:00Z"));
      await store.save(completed("task-recent"));
      vi.setSystemTime(new Date("2026-02-05T00:00:00Z"));

      expect(await store.sweep()).toBe(2);
      expect(await store.load("task-old-1")).toBeUndefined();
      expect(await store.load("task-old-2")).toBeUndefined();
      expect(await store.load("task-recent")).toBeDefined();
    });
  });

  it("sweeps a keyspace larger than one page", async () => {
    // A batch delete takes at most 128 keys, so a month's backlog does not fit
    // in one call — `rnd-lead` alone logged 100 tasks in three weeks. Stale and
    // fresh ids interleave in sort order, so every page holds a mix and the
    // filter has to run per page rather than once over the whole listing.
    await withStorage(async (storage) => {
      const store = new DurableTaskStore(storage);
      const id = (n: number) => `task-${String(n).padStart(3, "0")}`;
      vi.useFakeTimers();

      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      for (let n = 0; n < 400; n += 2) await store.save(completed(id(n)));
      vi.setSystemTime(new Date("2026-01-29T00:00:00Z"));
      for (let n = 1; n < 200; n += 2) await store.save(completed(id(n)));
      vi.setSystemTime(new Date("2026-02-05T00:00:00Z"));

      expect(await store.sweep()).toBe(200);
      expect(await store.load(id(0))).toBeUndefined();
      expect(await store.load(id(398))).toBeUndefined();
      expect(await store.load(id(1))).toBeDefined();
      expect(await store.load(id(199))).toBeDefined();
      // Nothing left to do on a second pass over the same keyspace.
      expect(await store.sweep()).toBe(0);
    });
  });

  it("stays inside the runtime's batch-delete and listing limits", async () => {
    // The production ceilings the paging exists for: `delete` takes at most 128
    // keys per call, and an unbounded `list` pulls every task body into memory
    // at once. Neither is enforced locally, so a sweep that violated them would
    // pass every other test here and only fail once deployed.
    await withStorage(async (raw) => {
      const { storage, deleteBatches, listLimits } = recordingStorage(raw);
      const store = new DurableTaskStore(storage);
      vi.useFakeTimers();

      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      for (let n = 0; n < 400; n++) {
        await store.save(completed(`task-${String(n).padStart(3, "0")}`));
      }
      deleteBatches.length = 0;
      listLimits.length = 0;
      vi.setSystemTime(new Date("2026-02-05T00:00:00Z"));

      expect(await store.sweep()).toBe(400);
      expect(deleteBatches.length).toBeGreaterThan(1);
      expect(Math.max(...deleteBatches)).toBeLessThanOrEqual(128);
      expect(listLimits.every((limit) => limit !== undefined)).toBe(true);
    });
  });

  it("sweeps nothing when every task is inside the window", async () => {
    await withStorage(async (storage) => {
      const store = new DurableTaskStore(storage);
      await store.save(completed("task-fresh"));

      expect(await store.sweep()).toBe(0);
      expect(await store.load("task-fresh")).toBeDefined();
    });
  });

  it("honours an explicit retention window", async () => {
    await withStorage(async (storage) => {
      const store = new DurableTaskStore(storage);
      vi.useFakeTimers();

      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      await store.save(completed("task-any"));
      vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));

      // Two hours old: past a one-hour window, inside the default month.
      expect(await store.sweep(TASK_RETENTION_SECONDS)).toBe(0);
      expect(await store.sweep(60 * 60)).toBe(1);
    });
  });

  it("outlives the longest a HITL prompt can stay open", () => {
    // The guarantee retention exists for: a prompt parked for its full 7-day
    // TTL must still find its task when the human finally answers.
    expect(TASK_RETENTION_SECONDS).toBeGreaterThan(HITL_REQUEST_TTL_SECONDS);
  });

  it("rejects tasks/list rather than pretending to page", async () => {
    await withStorage(async (storage) => {
      const store = new DurableTaskStore(storage);
      await expect(store.list()).rejects.toThrow(/not supported/);
    });
  });
});
