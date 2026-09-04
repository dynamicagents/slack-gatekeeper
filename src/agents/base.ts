import { Agent } from "agents";
import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryPushNotificationStore,
  type AgentExecutor
} from "@a2a-js/sdk/server";
import type { BuiltinTenant } from "@/db/models/agents";
import { LocalPushNotificationSender } from "@/a2a/notifications/local";
import { serveA2A } from "@/a2a/serve";
import { DurableTaskStore } from "@/a2a/task-store";

/** Key holding the wall-clock time of this instance's last task sweep. */
const SWEEP_MARKER_KEY = "a2a:swept-at";

/** How often an instance re-runs the sweep. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Base for in-repo agents. Each agent DO *is* its own A2A server: the gatekeeper
 * reaches it via `stub.fetch`, and `fetch` here answers the A2A protocol
 * (card discovery + JSON-RPC) through the SDK's `DefaultRequestHandler`.
 *
 * Subclasses supply a `card()` and an `executor()`. Phase 3 executors just echo;
 * Phase 4 swaps in the AI-SDK loop. We extend the Agents SDK `Agent` (itself a
 * Durable Object) so executors can use `this.sql` for the Sessions API
 * (per-agent conversation history + writable memory). The A2A bridge is kept by
 * overriding `fetch` — these DOs are reached directly via `stub.fetch`, not
 * `routeAgentRequest`, so bypassing the SDK's default router is intentional.
 *
 * Task state is durable for the same reason the Session is: a turn parked on a
 * human-in-the-loop prompt has to survive eviction, since the human may answer
 * days later (see {@link DurableTaskStore}). The push-notification store stays
 * in memory deliberately — every dispatch re-sends its config in the request, so
 * it rebuilds itself on the first call after a restart.
 */
export abstract class A2AAgent extends Agent<Env> {
  private handler?: DefaultRequestHandler;
  private sender?: LocalPushNotificationSender;
  private tasks?: DurableTaskStore;
  /** Whether this isolate has already considered sweeping — see `sweepStaleTasks`. */
  private sweepChecked = false;

  protected abstract card(): AgentCard;
  protected abstract executor(): AgentExecutor;
  protected abstract builtinTenant(): BuiltinTenant;

  private taskStore(): DurableTaskStore {
    return (this.tasks ??= new DurableTaskStore(this.ctx.storage));
  }

  private getHandler(): DefaultRequestHandler {
    if (!this.handler) {
      const card = this.card();
      const pushNotificationStore = new InMemoryPushNotificationStore();
      this.sender = new LocalPushNotificationSender(
        pushNotificationStore,
        this.builtinTenant()
      );
      this.handler = new DefaultRequestHandler(
        card,
        this.taskStore(),
        this.executor(),
        undefined,
        pushNotificationStore,
        this.sender
      );
    }
    return this.handler;
  }

  /**
   * Drop expired tasks, as a side check on an invocation that was happening
   * anyway. Two guards keep it close to free: `sweepChecked` means a warm
   * instance does no storage work beyond the first request it serves, and the
   * persisted marker means a cold start costs one small read unless a full day
   * has passed. It runs on `waitUntil`, so it is off the reply path entirely.
   *
   * An alarm would be the obvious alternative and is not available: the Agents
   * SDK `Agent` owns the physical `alarm()` for `this.schedule()`. Its
   * `onAlarm` hook would work, but a timer wakes every idle instance on a
   * schedule to usually find nothing — dearer than checking on a wake that was
   * already going to happen.
   *
   * Never throws: a failed sweep is a logged non-event, not a failed turn.
   */
  private async sweepStaleTasks(): Promise<void> {
    try {
      const last = await this.ctx.storage.get<number>(SWEEP_MARKER_KEY);
      if (last !== undefined && Date.now() - last < SWEEP_INTERVAL_MS) return;
      await this.taskStore().sweep();
      await this.ctx.storage.put(SWEEP_MARKER_KEY, Date.now());
    } catch (err) {
      console.error("[a2a-agent] task sweep failed", {
        tenant: this.builtinTenant(),
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const { response, taskId } = await serveA2A(request, this.getHandler());
    // Local agents accept-first (`blocking: false`): the SDK returns the
    // `submitted` accept immediately and runs the executor + push delivery as
    // background promises. Keep this DO alive until the accepted turn's terminal
    // reply is delivered — the accept carries its task id, so key the liveness
    // barrier on it. A request with no accepted task (card discovery, tasks/cancel)
    // has no pending turn, so fall back to draining any in-flight deliveries.
    if (this.sender) {
      this.ctx.waitUntil(
        taskId ? this.sender.whenSettled(taskId) : this.sender.drain()
      );
    }
    if (!this.sweepChecked) {
      this.sweepChecked = true;
      this.ctx.waitUntil(this.sweepStaleTasks());
    }
    return response;
  }
}
