import { createWorkersAI } from "workers-ai-provider";
import { wrapLanguageModel, type EmbeddingModel, type LanguageModel } from "ai";
import { env } from "cloudflare:workers";
import { normalizeToolInputMiddleware } from "@/agents/model-middleware";
import { fallbackMiddleware } from "@/agents/model-fallback-middleware";
import {
  AI_GATEWAY_ID,
  CHAT_FALLBACK,
  CHAT_PRIMARY,
  EMBED_MAX_PER_CALL,
  EMBED_MODEL_ID
} from "@/config";

/**
 * Options every chat call carries, in one place because they must not drift: the
 * tool loop and the Sessions compaction summarizer are two call sites of the same
 * model, and a setting applied to only one of them fails silently.
 *
 * Reasoning is **not** here any more. The unified `reasoning` call option applies
 * to whichever model serves the call, and the primary and the fallback no longer
 * accept the same values — so a depth that is right for one is wrong for the
 * other. It belongs to the model now, set where each model is built. (The unified
 * option could not express the fallback's ceiling either: its enum stops at
 * `xhigh`, which the provider clamps to `high`.)
 *
 * Telemetry is off because on workerd its tracing span leaves a
 * duplicate of every rejection unhandled — `isNodeRuntime()` is
 * `process.release?.name === "node"`, true under `nodejs_compat`, so the SDK enters
 * `runWithTracingChannelSpan` and workerd's `tracingChannel` never reports
 * `hasSubscribers === false`. `test/agents/shared/session.spec.ts` guards it.
 *
 * Turning telemetry *on* is what an OpenTelemetry integration would need, so the
 * rich per-step data is taken from lifecycle callbacks instead — they are plain
 * call options and run whatever telemetry is set to. See `shared/turn-log.ts`.
 */
export const CHAT_CALL_OPTIONS = {
  telemetry: { isEnabled: false }
} as const;

/** Which agent a model call was made on behalf of. */
export type GatewayAgent = "admin" | "onboarding";

/** What a model call is for, as the AI Gateway log will record it. */
export type GatewayPhase = "round" | "compaction" | "embed";

/** How many custom metadata entries AI Gateway saves on one call. */
export const GATEWAY_METADATA_MAX = 5;

/**
 * The five keys one model call may spend, in the order they are spent.
 *
 * **Five entries, and that is a hard cap** — AI Gateway saves the first five a
 * request carries and silently ignores the rest, and values may only be scalars.
 * Nothing fails when a sixth is sent: the call succeeds and the row is written,
 * one dimension short, with no error anywhere to say which. This interface *is*
 * the cap: it declares exactly five fields, so a sixth dimension someone wants to
 * slice by has to displace one of these in a diff a reviewer can see, rather than
 * go missing from every model call in production with nothing to notice it by.
 * Because the gateway keeps the *first* five, the order below is also the order
 * they would be given up in. In priority order:
 *
 * - `agent` and `workspaceId` are the two dimensions worth slicing spend by.
 * - `phase` is what no filter can derive. A round, a compaction summary and a
 *   recall embedding are three different costs against the same gateway, and
 *   without this a row is just a prompt with no idea which of them it was.
 * - `round` separates the loop's own asking from the salvage that may follow it —
 *   two calls a turn is charged for that otherwise look identical.
 * - `channel` is the A2A context id, `${channelId}:${threadTs}` for a local turn —
 *   the join back to the `[agent-turn]` line in Workers Logs, and to the Slack
 *   thread a human can actually read.
 *
 * `taskId` is deliberately **not** here. It lives on the `[agent-turn]` line, where
 * there is no cap, and inside {@link GatewayCall.eventId}, which costs no entry.
 *
 * **No person goes in any of these.** The gateway log is retained and queryable by
 * anyone who can read the account, and a Slack user id in a row is a record of who
 * said what, kept somewhere nobody would think to look for it. The only thing
 * keeping one out is that there is nowhere here to put it — so do not add one, and
 * see {@link gatewayLogFields} for why nothing can arrive by accident either.
 */
export interface GatewayCallFields {
  /**
   * Absent on an embedding: {@link embeddingModel} is memoised once per isolate and
   * serves both agents' recall, so either name on it would be wrong half the time.
   */
  agent?: GatewayAgent;
  phase: GatewayPhase;
  round?: number;
  channel?: string;
  workspaceId?: number;
}

/** The metadata record one call carries, once the absent entries are dropped. */
export type GatewayCallMetadata = NonNullable<GatewayOptions["metadata"]>;

/**
 * The five, spent in priority order, with what a call has no answer for dropped.
 *
 * The one place a metadata object is built, and it reads **only the five fields it
 * declares** — never `Object.entries(fields)`, never a spread of whatever the
 * caller had to hand. That is the difference between a cap this enforces and a cap
 * it merely documents: a turn's parsed wire metadata carries `user.slackUserId`,
 * and a builder that copied its input would put it in a retained log the moment
 * some call site found it convenient to pass the whole object.
 *
 * `undefined` and `""` are dropped rather than passed through:
 * `GatewayOptions["metadata"]` admits `null` but not `undefined`, and an absent
 * workspace should not spend one of five saying so.
 */
export function gatewayLogFields(
  fields: GatewayCallFields
): GatewayCallMetadata {
  const candidates: [string, string | number | undefined][] = [
    ["agent", fields.agent],
    ["phase", fields.phase],
    ["round", fields.round],
    ["channel", fields.channel],
    ["workspaceId", fields.workspaceId]
  ];
  const present = candidates.filter(
    (entry): entry is [string, string | number] =>
      entry[1] !== undefined && entry[1] !== ""
  );
  // Belt and braces: the type already stops a sixth key, and this stops one that
  // arrived past the type — a cast, or JavaScript from a test. Priority order is
  // what decides, so `workspaceId` is the first to go.
  return Object.fromEntries(present.slice(0, GATEWAY_METADATA_MAX));
}

/**
 * One chat call's gateway identity: the five that get logged, plus the correlation
 * id that rides *beside* them rather than inside them.
 */
export interface GatewayCall extends GatewayCallFields {
  /**
   * `${taskId}:r${round}`, on a round and nowhere else.
   *
   * `GatewayOptions.eventId` is its own field on the gateway request, so the join
   * from a gateway row back to the task that paid for it costs none of the five.
   * A compaction has no honest value for it: it runs inside the one `Session` every
   * task on that Durable Object shares, so a task id there would name whichever
   * task happened to tip the token budget over — filtering by it would find a
   * summary of other tasks' history. Better absent than misleading.
   */
  eventId?: string;
}

/** The gateway options one call runs under. */
function gatewayFor(call: GatewayCall): GatewayOptions {
  return {
    id: AI_GATEWAY_ID,
    metadata: gatewayLogFields(call),
    // Omitted rather than sent empty, for the same reason the five are.
    ...(call.eventId ? { eventId: call.eventId } : {})
  };
}

/** Test seam. The fallback is the model's own business now, not the caller's. */
export interface ModelOverrides {
  model?: LanguageModel;
}

/**
 * The provider handle, with **no gateway of its own**.
 *
 * That absence is load-bearing. `workers-ai-provider` resolves the gateway as
 * `this.config.gateway ?? gateway` — provider-construction wins over per-model
 * settings — so a top-level `gateway` here would make every per-call metadata
 * object dead code, which is what kept `AiGatewayLog.metadata` empty until now.
 * Every model built below therefore has to carry its own; one that forgets routes
 * outside the gateway silently, which is why there is only one way to build them.
 */
function buildProvider() {
  return createWorkersAI({ binding: env.AI });
}

let provider: ReturnType<typeof buildProvider> | undefined;

/**
 * Built once per isolate, on first use. `env.AI` is deliberately never read at
 * module scope — the binding is not there until the isolate is initialized.
 */
function agentProvider() {
  return (provider ??= buildProvider());
}

/**
 * The model used by the agent tool loop and the Sessions compaction summarizer.
 *
 * Built per call rather than memoised, because the gateway metadata is per call
 * and the provider freezes it at model construction. This is the trade that
 * replaced the `customProvider` registry that used to live here: a registry maps
 * a *name* to one model instance, which is exactly what per-turn metadata cannot
 * be. The cost is two object allocations per turn — `wrapLanguageModel` and the
 * two `WorkersAIChatLanguageModel`s are plain objects that open no connection —
 * against a gateway log that can finally say which thread it belonged to.
 */
export function chatModel(
  call: GatewayCall,
  overrides: ModelOverrides = {}
): LanguageModel {
  if (overrides.model) return overrides.model;
  const workersai = agentProvider();
  const gateway = gatewayFor(call);
  return wrapLanguageModel({
    model: workersai(CHAT_PRIMARY.id, {
      gateway,
      reasoning_effort: CHAT_PRIMARY.reasoningEffort
    }),
    // Order matters: the first entry is the outermost. History is repaired
    // before the fallback is handed the same params, so the fallback model
    // needs no wrapper of its own — a shape the primary refused is one it
    // would refuse a moment later. Both carry the same metadata: a call that
    // failed over is still the same turn's cost.
    middleware: [
      normalizeToolInputMiddleware,
      fallbackMiddleware(
        workersai(CHAT_FALLBACK.id, { gateway }),
        CHAT_FALLBACK.reasoningEffort
      )
    ]
  });
}

let embedding: EmbeddingModel | undefined;

/**
 * The model episodic recall embeds with.
 *
 * Still memoised: an embedding call carries no turn, so its metadata is the same
 * every time — and one model serves both agents' recall, which is why it names a
 * `phase` and no `agent`. `supportsParallelCalls: false` is what keeps `embedMany`
 * sequential — it overrides the caller's `maxParallelCalls` outright, so one
 * archive cannot fan out across concurrent binding calls.
 */
export function embeddingModel(): EmbeddingModel {
  return (embedding ??= agentProvider().textEmbeddingModel(EMBED_MODEL_ID, {
    maxEmbeddingsPerCall: EMBED_MAX_PER_CALL,
    supportsParallelCalls: false,
    gateway: gatewayFor({ phase: "embed" })
  }));
}
