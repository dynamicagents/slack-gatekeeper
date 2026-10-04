import { createWorkersAI } from "workers-ai-provider";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { env } from "cloudflare:workers";
import { normalizeToolInputMiddleware } from "@/agents/model-middleware";
import { AI_GATEWAY_ID, CHAT_MODEL } from "@/config";

/**
 * Options every chat call carries, in one place because they must not drift: the
 * tool loop and the Sessions compaction summarizer are two call sites of the same
 * model, and a setting applied to only one of them fails silently.
 *
 * Reasoning is **not** here. The unified `reasoning` call option cannot express
 * what this model wants — its enum stops at `xhigh`, which the provider clamps to
 * `high` — and the depth is a property of the model rather than of the call, so it
 * is set where the model is built, against the enum that model declares.
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
export type GatewayPhase = "round" | "compaction";

/**
 * How many custom metadata entries AI Gateway saves on one call.
 *
 * The first five a request carries are stored and the rest silently ignored, and
 * values may only be scalars. Nothing fails when a sixth is sent: the call
 * succeeds and the row is written one dimension short, with no error anywhere to
 * say which. So {@link GatewayCallFields} stays at or under this, and a new
 * dimension past it has to displace one in a diff a reviewer can see —
 * `model.spec.ts` fails the build if the declared set outgrows it.
 */
export const GATEWAY_METADATA_MAX = 5;

/**
 * The keys one model call may spend, in the order they are spent — which, because
 * the gateway keeps the *first* {@link GATEWAY_METADATA_MAX}, is also the order
 * they would be given up in:
 *
 * - `agent` and `workspaceId` are the two dimensions worth slicing spend by.
 * - `phase` is what no filter can derive. A round and a compaction summary are
 *   two different costs against the same gateway, and without this a row is just
 *   a prompt with no idea which of them it was.
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
  agent?: GatewayAgent;
  phase: GatewayPhase;
  channel?: string;
  workspaceId?: number;
}

/** The metadata record one call carries, once the absent entries are dropped. */
export type GatewayCallMetadata = NonNullable<GatewayOptions["metadata"]>;

/**
 * The declared fields, in priority order, with what a call has no answer for
 * dropped.
 *
 * The one place a metadata object is built, and it reads **only the fields it
 * declares** — never `Object.entries(fields)`, never a spread of whatever the
 * caller had to hand. That is the privacy guard, not a style preference: a turn's
 * parsed wire metadata carries `user.slackUserId`, and a builder that copied its
 * input would put it in a retained log the moment some call site found it
 * convenient to pass the whole object.
 *
 * `undefined` and `""` are dropped rather than passed through:
 * `GatewayOptions["metadata"]` admits `null` but not `undefined`, and an absent
 * workspace should not spend an entry saying so.
 */
export function gatewayLogFields(
  fields: GatewayCallFields
): GatewayCallMetadata {
  const candidates: [string, string | number | undefined][] = [
    ["agent", fields.agent],
    ["phase", fields.phase],
    ["channel", fields.channel],
    ["workspaceId", fields.workspaceId]
  ];
  return Object.fromEntries(
    candidates.filter(
      (entry): entry is [string, string | number] =>
        entry[1] !== undefined && entry[1] !== ""
    )
  );
}

/**
 * One chat call's gateway identity: the fields that get logged, plus the
 * correlation id that rides *beside* them rather than inside them.
 */
export interface GatewayCall extends GatewayCallFields {
  /**
   * The task id, on a round and nowhere else.
   *
   * `GatewayOptions.eventId` is its own field on the gateway request, so the join
   * from a gateway row back to the task that paid for it costs no entry.
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
    // Omitted rather than sent empty, for the same reason the metadata entries are.
    ...(call.eventId ? { eventId: call.eventId } : {})
  };
}

/**
 * What a caller may set on the model itself: one test seam and one production
 * setting.
 */
export interface ModelOverrides {
  /** Test seam: a model to use instead of building one. */
  model?: LanguageModel;
  /**
   * The key that pins this call to the model instance already holding its prompt
   * prefix — Workers AI's `x-session-affinity`.
   *
   * The prefix cache is per-instance and implicit: 64-token blocks, no
   * breakpoints, no TTL, and no way to ask for a hit. Unsteered, roughly half the
   * calls inside the eviction window land on an instance that has the prefix and
   * none do past a five-minute gap, and a miss is billed as fresh input at five
   * times the cached rate. Routing is the only lever, and this is it.
   *
   * **The grain is a continuous history**, which here is the Durable Object's own
   * instance name — `admin:{wsId}` or `onboarding:{slackUserId}`, read off
   * `ctx.id.name` rather than respelled. One `Session` serves every task that DO
   * ever runs, so a new task opens on the previous one's history and wants the
   * same instance. A per-task or per-turn key would route each call *away* from
   * the prefix it just built, which is worse than not steering at all.
   *
   * It leaves as the binding's `x-session-affinity` header, **not** as a
   * {@link GatewayCall} field: it steers Workers AI's model-instance routing, and
   * the gateway neither reads it nor logs it.
   *
   * Absent, the call is made unsteered — a missing key costs the prefix cache,
   * never the call.
   */
  sessionAffinity?: string;
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
 * and the provider freezes it at model construction. A `customProvider` registry
 * cannot serve this: it maps a *name* to one model instance, which is exactly
 * what per-turn metadata cannot be. The cost is two object allocations per turn —
 * `wrapLanguageModel` and the `WorkersAIChatLanguageModel` are plain objects that
 * open no connection — against a gateway log that can say which thread it
 * belonged to.
 */
export function chatModel(
  call: GatewayCall,
  overrides: ModelOverrides = {}
): LanguageModel {
  if (overrides.model) return overrides.model;
  // Omitted rather than sent empty — the provider turns a key into an
  // `x-session-affinity` header, and an empty one would pin every unkeyed call in
  // the account to a single instance.
  const affinity = overrides.sessionAffinity;
  return wrapLanguageModel({
    model: agentProvider()(CHAT_MODEL.id, {
      gateway: gatewayFor(call),
      reasoning_effort: CHAT_MODEL.reasoningEffort,
      ...(affinity ? { sessionAffinity: affinity } : {})
    }),
    middleware: normalizeToolInputMiddleware
  });
}
