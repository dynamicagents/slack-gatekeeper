import {
  TaskState,
  type StreamResponse,
  type TaskPushNotificationConfig
} from "@a2a-js/sdk";
import type {
  PushNotificationSender,
  PushNotificationStore,
  ServerCallContext
} from "@a2a-js/sdk/server";
import { getAgent, type BuiltinTenant } from "@/db/models/agents";
import {
  getAgentTaskByToken,
  isTerminalTaskStatus,
  recordAgentTaskError
} from "@/db/models/agent-tasks";
import { isTerminalTaskState } from "@/a2a/parts";
import { snapshotOf, type TaskSnapshot } from "@/a2a/snapshot";
import { deliverTaskToSlack, TaskDeliveryValidationError } from "./shared";

/** Reserved internal-only target; it is never fetched over HTTP. */
export const LOCAL_NOTIFICATION_URL = "https://local.a2a.invalid/notifications";

/** Total delivery attempts (1 initial + retries) before giving up. */
const DELIVERY_MAX_ATTEMPTS = 3;
/**
 * Backoff before retry attempts 2 and 3 (ms). Deliberately short — the delivery
 * runs on the agent DO's `whenSettled` liveness barrier (registered on
 * `ctx.waitUntil`), which keeps the object alive until the terminal task's
 * delivery settles, so a brief retry can't outlive the DO.
 */
const DELIVERY_BACKOFF_MS = [250, 1000];
/**
 * Safety cap on how long {@link LocalPushNotificationSender.whenSettled} will hold
 * the DO alive for one turn. A turn always publishes a terminal state (so the
 * barrier normally resolves on delivery); this only bounds `ctx.waitUntil` if a
 * terminal is somehow never emitted, well past any real turn budget.
 *
 * Deliberately **not** raised to match `TASK_DEADLINE_SECONDS` (1 hour), however
 * tempting the symmetry looks. This barrier keeps a Durable Object resident, and
 * Durable Objects bill wall-clock duration for their full 128 MB allocation for
 * as long as they are alive — so unlike the gatekeeper's hour-long *wait* (a
 * hibernating Workflow, billed on CPU it never spends), every minute here is paid
 * for. The hour is an affordance for remote agents, whose compute runs on their
 * own Worker; a built-in has no business taking eight minutes, let alone sixty.
 */
const SETTLE_TIMEOUT_MS = 480_000;
/** Cap on remembered already-settled task ids (guards a settle that beats whenSettled). */
const SETTLED_MEMORY_MAX = 64;
/** Gatekeeper-controlled backstop notice recorded when delivery gives up. */
const DELIVERY_FAILED_MESSAGE =
  "the local agent's reply could not be delivered";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Build the correlation config that the local A2A sender recognizes. v1.0
 * flattened the old nested `PushNotificationConfig` into
 * `TaskPushNotificationConfig`; `id` and `taskId` are assigned by the server
 * when it registers the config, so they go out empty.
 */
export function localPushNotificationConfig(
  token: string
): TaskPushNotificationConfig {
  return {
    tenant: "",
    id: "",
    taskId: "",
    url: LOCAL_NOTIFICATION_URL,
    token,
    authentication: undefined
  };
}

/**
 * Deliver a task snapshot emitted by an in-repo built-in agent without crossing
 * the public HTTP/JWT trust boundary.
 *
 * The tenant check is the trust boundary this path *does* have: it prevents one
 * local Durable Object from completing another agent's pending task. Nothing
 * else stands in the way — these callbacks carry no JWT, precisely because they
 * never leave the isolate.
 *
 * It compares `tenantId` rather than `kind` for a reason worth stating: `kind`
 * is `local` for every built-in, so comparing it here would be `local !== local`
 * — vacuously false, and the guard would be gone while still looking present.
 * `tenantId` is the field that distinguishes admin from onboarding.
 * `local.spec.ts` asserts the rejection directly.
 */
export async function deliverLocalAgentTask(
  token: string,
  snapshot: TaskSnapshot,
  expectedTenant: BuiltinTenant
): Promise<void> {
  const row = await getAgentTaskByToken(token);
  if (!row) {
    // Expected when the token was already completed-and-swept; log so a genuinely
    // dropped reply isn't fully silent.
    console.debug("[local-notifications] no task row for token", {
      taskId: snapshot.taskId
    });
    return;
  }
  // Delivered, stopped, or timed out — the task is over, so this snapshot is
  // dropped rather than posted. Unreachable in practice (the settle barrier below
  // outlives any built-in turn by a wide margin), but it keeps both notification
  // boundaries honest about the same invariant.
  if (isTerminalTaskStatus(row.status)) return;

  const agent = await getAgent(row.agentName);
  if (!agent || agent.tenantId !== expectedTenant) {
    throw new Error(
      "local task does not belong to the expected built-in agent"
    );
  }
  await deliverTaskToSlack(token, row, agent, snapshot);
}

/**
 * Bridges A2A push notifications directly into the gatekeeper's durable delivery
 * ledger. The SDK invokes `send` serially from its event processor, but the
 * explicit chain also preserves status-update order if an implementation ever
 * calls it concurrently.
 *
 * Since local agents now accept-first (`blocking: false`), the SDK returns the
 * `submitted` accept while generation and delivery run as background promises. The
 * agent DO keeps itself alive by registering {@link whenSettled} — keyed by the
 * accept's task id so concurrent turns on one DO stay independent — on
 * `ctx.waitUntil`; it resolves only once that turn's *terminal* task has been
 * delivered. (`drain` remains the fallback for a fetch that produced no task.)
 */
export class LocalPushNotificationSender implements PushNotificationSender {
  private deliveryChain: Promise<void> = Promise.resolve();
  /** Pending liveness barriers, keyed by task id, awaiting a terminal delivery. */
  private readonly settleWaiters = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Task ids whose terminal delivery settled before `whenSettled` was called. */
  private readonly recentlySettled = new Set<string>();

  constructor(
    private readonly pushNotificationStore: PushNotificationStore,
    private readonly tenant: BuiltinTenant
  ) {}

  send(
    streamResponse: StreamResponse,
    context: ServerCallContext
  ): Promise<void> {
    // v1.0 dispatches the same `StreamResponse` envelope the streaming
    // transports carry, so flatten it to the gatekeeper's task view first. An
    // envelope that advances no task lifecycle (an artifact delta, or a
    // stand-alone message) has nothing to deliver.
    const snapshot = snapshotOf(streamResponse);
    if (!snapshot) return Promise.resolve();

    const delivery = this.deliveryChain.then(() =>
      this.deliver(snapshot, context)
    );
    // Keep later notifications deliverable after a failed Slack/API call.
    this.deliveryChain = delivery.catch(() => undefined);
    // The terminal snapshot is the last delivery for this task; release the
    // liveness barrier only once it has settled (delivered, or failed and
    // recorded — `deliver` never rejects), so `ctx.waitUntil` spans the whole turn.
    // A local agent emits `input-required` only via the HITL park path, which ends
    // the turn (the human answers on a later, separate invocation), so treat it as
    // a settle point too — otherwise the DO idles until the safety timeout.
    if (
      isTerminalTaskState(snapshot.state) ||
      snapshot.state === TaskState.TASK_STATE_INPUT_REQUIRED
    ) {
      void this.deliveryChain.finally(() =>
        this.resolveSettled(snapshot.taskId)
      );
    }
    return delivery;
  }

  /**
   * Resolve once the *terminal* task for `taskId` has been delivered (or its
   * delivery failed and was recorded). The agent DO registers this on
   * `ctx.waitUntil` so the runtime keeps the object alive across the background
   * turn — generation plus the final Slack post. A safety timeout bounds the wait
   * so `ctx.waitUntil` can never hang if a terminal is somehow never published.
   */
  whenSettled(taskId: string): Promise<void> {
    // Delivery may (rarely) beat this call; if so it already settled.
    if (this.recentlySettled.delete(taskId)) return Promise.resolve();
    const existing = this.settleWaiters.get(taskId);
    if (existing) return existing.promise;

    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const timer = setTimeout(() => {
      console.warn("[local-notifications] whenSettled timed out", {
        tenant: this.tenant,
        taskId
      });
      this.resolveSettled(taskId);
    }, SETTLE_TIMEOUT_MS);
    this.settleWaiters.set(taskId, { promise, resolve, timer });
    return promise;
  }

  private resolveSettled(taskId: string): void {
    const waiter = this.settleWaiters.get(taskId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.settleWaiters.delete(taskId);
      waiter.resolve();
      return;
    }
    // Settled before whenSettled was called — remember it (bounded) so a later
    // whenSettled returns immediately instead of waiting on a terminal that's gone.
    this.recentlySettled.add(taskId);
    if (this.recentlySettled.size > SETTLED_MEMORY_MAX) {
      const oldest = this.recentlySettled.values().next().value;
      if (oldest !== undefined) this.recentlySettled.delete(oldest);
    }
  }

  /**
   * Resolve once every queued delivery (including retries) has settled. Fallback
   * liveness signal for a fetch that produced no task (card discovery,
   * `tasks/cancel`); the accept-first path uses {@link whenSettled} instead. Never
   * rejects — `deliver` catches and records every error path.
   */
  drain(): Promise<void> {
    return this.deliveryChain;
  }

  private async deliver(
    snapshot: TaskSnapshot,
    context: ServerCallContext
  ): Promise<void> {
    // The initial submitted Task establishes acceptance only. It must not be
    // treated as a user-visible progress update, even if it carries a message.
    if (snapshot.state === TaskState.TASK_STATE_SUBMITTED) return;

    // The call context is threaded through verbatim: v1.0 stores scope configs
    // by tenant + owner, so a lookup only finds what the registering request
    // saved if it presents the same context.
    const configs = await this.pushNotificationStore.load(
      snapshot.taskId,
      context
    );
    for (const config of configs) {
      if (config.url !== LOCAL_NOTIFICATION_URL || !config.token) continue;
      await this.deliverWithRetry(snapshot, config.token);
    }
  }

  /**
   * Deliver one snapshot, retrying a transient Slack/API failure with backoff.
   * The old synchronous path posted local replies inside a durable workflow step
   * that retried; this restores that resilience. `deliverTaskToSlack` is
   * replay-safe (the message-id dedupe skips an already-posted update; the
   * terminal completion flip is idempotent), so a retry re-posts the terminal
   * reply a failed attempt left pending without double-posting a delivered one.
   * A malformed snapshot is deterministic and not retried. On exhaustion the
   * failure is recorded for the reaction backstop.
   */
  private async deliverWithRetry(
    snapshot: TaskSnapshot,
    token: string
  ): Promise<void> {
    for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
      try {
        await deliverLocalAgentTask(token, snapshot, this.tenant);
        return;
      } catch (err) {
        if (err instanceof TaskDeliveryValidationError) {
          console.error("[local-notifications] malformed task snapshot", {
            tenant: this.tenant,
            taskId: snapshot.taskId,
            err: err.message
          });
          await recordAgentTaskError(token, DELIVERY_FAILED_MESSAGE);
          return;
        }
        const lastAttempt = attempt === DELIVERY_MAX_ATTEMPTS;
        console.error("[local-notifications] task delivery failed", {
          tenant: this.tenant,
          taskId: snapshot.taskId,
          attempt,
          lastAttempt,
          err: err instanceof Error ? err.message : String(err)
        });
        if (lastAttempt) {
          await recordAgentTaskError(token, DELIVERY_FAILED_MESSAGE);
          return;
        }
        await sleep(DELIVERY_BACKOFF_MS[attempt - 1]);
      }
    }
  }
}
