import { createWorkersAI } from "workers-ai-provider";
import { wrapLanguageModel, type EmbeddingModel, type LanguageModel } from "ai";
import { env } from "cloudflare:workers";
import { normalizeToolInputMiddleware } from "@/agents/model-middleware";
import { fallbackMiddleware } from "@/agents/model-fallback-middleware";
import {
  AI_GATEWAY_ID,
  CHAT_MODEL_ID,
  CHAT_FALLBACK_MODEL_ID,
  CHAT_FALLBACK_REASONING_EFFORT,
  CHAT_REASONING_EFFORT,
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

/** What a model call is for, as the AI Gateway log will record it. */
export type GatewayCall = "turn" | "summarize" | "embed";

/**
 * The identity attached to one model call's AI Gateway log row.
 *
 * **Five entries, and that is a hard cap** — AI Gateway rejects a sixth, and
 * values may only be scalars. So each field here is spent deliberately:
 *
 * - `call` is what no filter can derive. A turn, a compaction summary and a recall
 *   embedding are three different costs against the same gateway, and without this
 *   a row is just a prompt with no idea which of them it was.
 * - `tenant` and `workspaceId` are the two dimensions worth slicing spend by.
 * - `contextId` is `${channelId}:${threadTs}` — the join back to the `[agent-turn]`
 *   line in Workers Logs, and to the Slack thread a human can actually read.
 * - `user` is the Slack user; AI Gateway's user insights read an identifier out of
 *   custom metadata, and without one all usage groups under a single anonymous id.
 *
 * `taskId` is deliberately **not** here. It lives on the `[agent-turn]` line, where
 * there is no cap, and `contextId` is enough to get from one to the other.
 */
export interface GatewayCallMetadata {
  call: GatewayCall;
  tenant?: string;
  workspaceId?: number;
  contextId?: string;
  user?: string;
}

/**
 * The gateway options one call runs under.
 *
 * `undefined` is dropped rather than passed through: `GatewayOptions["metadata"]`
 * admits `null` but not `undefined`, and an absent workspace should not spend one
 * of the five entries saying so.
 */
function gatewayFor(metadata: GatewayCallMetadata): GatewayOptions {
  const present = Object.entries(metadata).filter(
    ([, value]) => value !== undefined
  );
  return {
    id: AI_GATEWAY_ID,
    metadata: Object.fromEntries(present) as GatewayOptions["metadata"]
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
  metadata: GatewayCallMetadata,
  overrides: ModelOverrides = {}
): LanguageModel {
  if (overrides.model) return overrides.model;
  const workersai = agentProvider();
  const gateway = gatewayFor(metadata);
  return wrapLanguageModel({
    model: workersai(CHAT_MODEL_ID, {
      gateway,
      reasoning_effort: CHAT_REASONING_EFFORT
    }),
    // Order matters: the first entry is the outermost. History is repaired
    // before the fallback is handed the same params, so the fallback model
    // needs no wrapper of its own — a shape the primary refused is one it
    // would refuse a moment later. Both carry the same metadata: a call that
    // failed over is still the same turn's cost.
    middleware: [
      normalizeToolInputMiddleware,
      fallbackMiddleware(
        workersai(CHAT_FALLBACK_MODEL_ID, { gateway }),
        CHAT_FALLBACK_REASONING_EFFORT
      )
    ]
  });
}

let embedding: EmbeddingModel | undefined;

/**
 * The model episodic recall embeds with.
 *
 * Still memoised: an embedding call carries no turn, so its metadata is the same
 * every time. `supportsParallelCalls: false` is what keeps `embedMany`
 * sequential — it overrides the caller's `maxParallelCalls` outright, so one
 * archive cannot fan out across concurrent binding calls.
 */
export function embeddingModel(): EmbeddingModel {
  return (embedding ??= agentProvider().textEmbeddingModel(EMBED_MODEL_ID, {
    maxEmbeddingsPerCall: EMBED_MAX_PER_CALL,
    supportsParallelCalls: false,
    gateway: gatewayFor({ call: "embed" })
  }));
}
