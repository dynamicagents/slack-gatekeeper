import type { LanguageModelUsage, ProviderMetadata } from "ai";
import { servedByFallback } from "@/agents/model-fallback-middleware";

/**
 * One structured line per turn, so what a turn cost is a thing you can read.
 *
 * Until this existed the agent loop logged only anomalies — a stop, a violation,
 * a turn with no reply — which makes every rate it reports a numerator with no
 * denominator. Nothing read `result.usage` at all, so tokens, latency and step
 * count left no trace on our side; the only record was the AI Gateway log, which
 * carries no idea which Slack thread it belonged to.
 *
 * **One line, not one per step.** `wrangler.jsonc` sets no `head_sampling_rate`,
 * so everything logged is kept and paid for, and a ten-step turn writing ten
 * lines buries the one line that says how it ended. Per-step timings survive as
 * sums; the individual steps are on the gateway side if anyone needs them.
 *
 * The counterpart is the gateway metadata in {@link file://../model.ts model.ts}:
 * the same context id is attached to every model call this turn makes — as
 * `channel` there — so a row in `npm run cf -- ai` and a line in
 * `npm run cf -- logs` can be put side by side. `taskId` is here and not among the
 * gateway's five because it caps custom metadata at five entries and this side has
 * no cap at all; it reaches a gateway row through `eventId`, which costs none.
 *
 * `user` is here and *only* here, for the same reason: this line is ours and the
 * gateway log is retained account-wide. See `GatewayCallFields`.
 */

/**
 * How a turn ended, from the caller's point of view rather than the model's.
 *
 * `finishReason` answers why *generation* stopped, which is a different question
 * — a turn can finish for the best of reasons and still deliver nothing. These
 * are the five exits `executeAgentTurn` actually has.
 */
export type TurnEnding =
  /** A reply was published. */
  | "reply"
  /** Parked on a human: a question asked, or a destructive call awaiting Approve. */
  | "parked"
  /** A 🛑 landed; whatever was produced was withheld. */
  | "stopped"
  /** Generation finished but produced no answer; the user got the apology. */
  | "none"
  /** The turn threw. `[agent-loop] turn failed` carries the error itself. */
  | "failed";

/** Who and what a turn belongs to. Everything here is known before the model runs. */
export interface TurnIdentity {
  contextId: string;
  taskId: string;
  /** `"admin"`, `"onboarding"`, or a remote agent's tenant id. */
  tenant?: string;
  workspaceId?: number;
  /** The Slack user whose message opened the turn. */
  user?: string;
  /** The primary model id, which is what was *asked for* — see `fallbacks`. */
  model: string;
}

/** Accumulates a turn's observations; {@link TurnLog.flush} emits the one line. */
export interface TurnLog {
  /** Fold in one finished model call, charged whether or not it was usable. */
  modelCall(event: ModelCallLike): void;
  /** Fold in one finished tool execution. */
  toolRan(ms: number): void;
  /** Note that the turn had to ask a second time for an ending. */
  salvaged(): void;
  /** Name the approved call this turn carried out, decided by an earlier one. */
  replayed(toolName: string): void;
  /** Record how the turn ended. Unset means it threw. */
  ending(ending: TurnEnding): void;
  /** Emit. Safe to call once; later calls are ignored. */
  flush(): void;
}

/**
 * The part of an `onLanguageModelCallEnd` event this reads.
 *
 * **Per model call, not per generation** — and that is the whole point. A model
 * that narrates under an enforced tool choice is charged for, and then its answer
 * is thrown away as a `ToolChoiceViolationError`; the `generateText` promise never
 * resolves, so there is no result to read usage off. That throw happens at
 * `generate-text.ts:1150`, *after* this callback fires at `:1128` and *before*
 * `onStepEnd` at `:1471` — so this is the only seam that sees a call the turn was
 * billed for but never got to use. The same applies to a failed salvage.
 *
 * Structural rather than `LanguageModelCallEndEvent<TOOLS>`, which is generic over
 * a tool set this turn only assembles at runtime. A real event still has to satisfy
 * it, so a field renamed upstream fails at the call site in `loop.ts`.
 */
export interface ModelCallLike {
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
  readonly providerMetadata?: ProviderMetadata;
  readonly performance: { readonly responseTimeMs: number };
  readonly content: readonly { readonly type: string }[];
}

/** Names of the tools one model call asked for, in call order. */
function toolNamesOf(event: ModelCallLike): string[] {
  return event.content
    .filter(
      (part): part is { type: "tool-call"; toolName: string } =>
        part.type === "tool-call"
    )
    .map((part) => part.toolName);
}

/**
 * Add two token counts, keeping `undefined` distinct from `0`.
 *
 * A model that reported nothing and a model that used nothing are different
 * facts, and rounding the first to zero would quietly understate a turn whose
 * provider went quiet. Only once both sides are absent does the total stay absent.
 */
function addTokens(
  a: number | undefined,
  b: number | undefined
): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

export function startTurnLog(identity: TurnIdentity): TurnLog {
  const startedAt = Date.now();
  const tools: Record<string, number> = {};
  let modelCalls = 0;
  let fallbacks = 0;
  let modelMs = 0;
  let toolMs = 0;
  let inputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let outputTokens: number | undefined;
  let finishReason: string | undefined;
  let salvaged = false;
  let replayed: string | undefined;
  let ending: TurnEnding | undefined;
  let flushed = false;

  return {
    modelCall(event) {
      modelCalls += 1;
      // The last call's reason is the turn's: whatever came before it was, by
      // definition, not the end.
      finishReason = event.finishReason;
      if (servedByFallback(event.providerMetadata)) fallbacks += 1;
      modelMs += event.performance.responseTimeMs;
      inputTokens = addTokens(inputTokens, event.usage.inputTokens);
      cachedInputTokens = addTokens(
        cachedInputTokens,
        event.usage.inputTokenDetails.cacheReadTokens
      );
      outputTokens = addTokens(outputTokens, event.usage.outputTokens);
      for (const name of toolNamesOf(event)) {
        tools[name] = (tools[name] ?? 0) + 1;
      }
    },

    toolRan(ms) {
      toolMs += ms;
    },

    salvaged() {
      salvaged = true;
    },

    replayed(toolName) {
      replayed = toolName;
    },

    ending(next) {
      ending = next;
    },

    flush() {
      if (flushed) return;
      flushed = true;
      console.info("[agent-turn]", {
        ...identity,
        // Absent means `flush` ran from the `finally` without any exit having
        // claimed the turn, which is what a throw looks like from here.
        ending: ending ?? "failed",
        // Calls the account was charged for, which is not the same as steps the
        // turn got to use: a model that narrates under an enforced tool choice
        // is billed and then discarded.
        modelCalls,
        fallbacks,
        salvaged,
        // Absent on an ordinary turn. `tools` below counts only what this turn's
        // model asked for, and a replayed call was asked for by an earlier one —
        // its execution time is in `toolMs` either way.
        replayed,
        finishReason,
        ms: Date.now() - startedAt,
        modelMs,
        toolMs,
        inputTokens,
        cachedInputTokens,
        // Not `outputTokenDetails.reasoningTokens`: GLM reasons and bills for it,
        // but `workers-ai-provider` leaves that field undefined on every response
        // (`map-workersai-usage.ts`), so logging it would promise a number that is
        // never there. Reasoning is inside `outputTokens`, unseparated.
        outputTokens,
        tools
      });
    }
  };
}
