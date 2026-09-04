import { Task } from "@a2a-js/sdk";
import type { ListTasksResponse } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";
import { TASK_RETENTION_SECONDS } from "@/config";

/** Key prefix for persisted tasks; `task:{taskId}`. */
const TASK_PREFIX = "a2a:task:";
const taskKey = (taskId: string): string => `${TASK_PREFIX}${taskId}`;

/**
 * Keys per sweep page. Pinned to the documented ceiling on a batch
 * `DurableObjectStorage.delete` ("supports up to 128 keys at a time") so a
 * page's worth of stale keys is always one legal delete.
 */
const SWEEP_PAGE_SIZE = 128;

/**
 * One persisted task. `savedAt` is the gatekeeper's own write timestamp rather than
 * the Task's `status.timestamp`, which the protocol makes optional — a task that
 * arrived without one would otherwise never become sweepable.
 */
interface StoredTask {
  savedAt: number;
  /** Protobuf-JSON encoding of the Task (see the codec note on the class). */
  task: unknown;
}

/**
 * A2A {@link TaskStore} backed by the agent Durable Object's own storage, so a
 * task outlives the isolate that created it.
 *
 * The SDK's `InMemoryTaskStore` keeps tasks in a heap map, which is fine for a
 * long-lived server and wrong for a Durable Object: an agent that parks a task
 * on `input-required` (a human-in-the-loop prompt) releases its liveness barrier
 * straight away and is evictable within seconds, while the human has days to
 * answer. The resumed turn would then arrive at a fresh isolate and fail with
 * `TaskNotFound`, stranding an approval the user had already granted.
 *
 * Two deliberate departures from the SDK's implementation:
 *
 * **A flat keyspace.** `InMemoryTaskStore` nests tenant → owner → taskId via
 * `ScopedStore`. That scoping is inert here: `buildCallContext` in `serve.ts`
 * builds every context with no tenant and no user — one DO instance *is* the
 * tenant — so the resolver always yields the same single bucket. Flat storage is
 * equivalent, not a relaxation.
 *
 * **The protobuf-JSON codec, not the raw object.** `TaskState` is a numeric enum
 * and `Part.content` is a `$case` oneof that can hold a `Buffer`; persisting the
 * in-memory shape directly and reading it back would quietly corrupt both.
 * `Task.toJSON`/`fromJSON` is the same round-trip `serve.ts` uses for the
 * AgentCard and `snapshot.ts` uses for inbound push envelopes.
 */
export class DurableTaskStore implements TaskStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async save(task: Task): Promise<void> {
    await this.storage.put<StoredTask>(taskKey(task.id), {
      savedAt: Date.now(),
      task: Task.toJSON(task)
    });
  }

  async load(taskId: string): Promise<Task | undefined> {
    const entry = await this.storage.get<StoredTask>(taskKey(taskId));
    return entry ? Task.fromJSON(entry.task) : undefined;
  }

  /**
   * Unsupported: these DOs are reached only over `stub.fetch` from the gatekeeper,
   * which sends `message/send` and nothing else, so `tasks/list` has no caller —
   * the same reasoning by which `serveA2A` rejects streaming outright.
   *
   * Deliberately a plain `Error` and not the SDK's `UnsupportedOperationError`:
   * `@a2a-js/sdk/errors` and `@a2a-js/sdk/server` are separately bundled entry
   * points that each carry their own `A2AError`, and the server's error mapper
   * tests `instanceof` against *its* copy — so the semantic class imported here
   * would be flattened to a generic internal error anyway, while reading as
   * though it produced `UNSUPPORTED_OPERATION`. Same hazard as `errors.ts`.
   */
  async list(): Promise<ListTasksResponse> {
    throw new Error("tasks/list is not supported by local agents");
  }

  /**
   * Drop tasks written more than `olderThanSeconds` ago; returns how many went.
   *
   * Retention matches the `agent_tasks` sweep for remote agents
   * ({@link TASK_RETENTION_SECONDS}) — the local/remote split is an
   * implementation detail, not a reason for a task to live longer on one side.
   *
   * Walks the keyspace a page at a time rather than listing it whole. An
   * unbounded `list` would pull every task *body* into the object's memory at
   * once — the values here are whole serialized Tasks, not bare keys — and the
   * resulting delete could exceed the 128-key cap on a batch `delete`, which is
   * reachable: a single agent logged 100 tasks in three weeks. Paging by that
   * same 128 makes the per-page delete correct by construction.
   *
   * `startAfter` advances past every key seen, deleted or not, so removing
   * entries mid-walk cannot make the cursor skip any.
   */
  async sweep(olderThanSeconds = TASK_RETENTION_SECONDS): Promise<number> {
    const cutoff = Date.now() - olderThanSeconds * 1000;
    let deleted = 0;
    let startAfter: string | undefined;

    for (;;) {
      const page = await this.storage.list<StoredTask>({
        prefix: TASK_PREFIX,
        startAfter,
        limit: SWEEP_PAGE_SIZE,
        // The sweep only ever removes entries already past retention, and a task
        // written while it runs is stamped `now` — so it can never be in the
        // stale set. Nothing here needs the input gate held across its awaits,
        // and holding it would stall the turn this is riding along with.
        allowConcurrency: true
      });
      if (page.size === 0) break;

      const stale: string[] = [];
      for (const [key, entry] of page) {
        startAfter = key;
        if (entry.savedAt < cutoff) stale.push(key);
      }
      if (stale.length > 0) {
        await this.storage.delete(stale, { allowConcurrency: true });
        deleted += stale.length;
      }

      if (page.size < SWEEP_PAGE_SIZE) break;
    }
    return deleted;
  }
}
