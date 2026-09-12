import type { LanguageModelMiddleware } from "ai";

/**
 * Fall back to a second model **within the failing call**, rather than by running
 * the turn again.
 *
 * The turn used to own this: `runRounds` looped over a primary and a fallback slot
 * and re-entered `generateText` from the original history, so every tool the primary
 * had already run ran a second time. A middleware sits one layer down, where the
 * unit of failure is a single model call — the steps already taken keep their
 * results, and only the call that failed is retried elsewhere.
 *
 * Two failures reach here, and they arrive differently:
 *
 *  1. **A throw.** The provider normalizes a binding failure into an `APICallError`
 *     before it gets here.
 *  2. **Narration.** A model that answers in prose under an enforced `toolChoice`
 *     *succeeds* as far as the provider is concerned — the SDK only rejects it
 *     afterwards, in `generateText`, by which time this middleware has returned.
 *     So the result has to be inspected here, not caught.
 *
 * It sits **inside** the SDK's retry loop (`generateText` wraps the whole wrapped
 * model in `retry`), so each retry attempt re-enters it: an attempt is
 * "primary, then fallback", and backoff happens between attempts, never between the
 * two models. That ordering is the point — a primary that is out of capacity reaches
 * the fallback immediately instead of after the primary's own backoff.
 */

type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type WrapGenerateOptions = Parameters<WrapGenerate>[0];
type CallOptions = WrapGenerateOptions["params"];
type GenerateResult = Awaited<ReturnType<WrapGenerateOptions["doGenerate"]>>;
type Model = WrapGenerateOptions["model"];

/**
 * The `providerMetadata` namespace this repo writes into.
 *
 * `providerMetadata` is keyed by provider so two providers can both annotate a
 * result without colliding; a wrapper is not a provider, so it takes a key of its
 * own rather than editing `workersai`'s.
 */
export const GATEKEEPER_METADATA = "slack-gatekeeper";

/**
 * Marks a step the fallback model produced.
 *
 * The step result cannot say this by itself: `generateText` fills
 * `response.modelId` from the model it was *handed*
 * (`ai/src/generate-text/generate-text.ts:997`), which is this middleware's
 * wrapper, so a fallback-served step reports the primary's id. The warning below
 * is the only other record, and reading a fallback rate out of log lines means
 * joining them back to the turn that spent them.
 */
const SERVED_BY_FALLBACK = "servedByFallback";

/** Whether the fallback model produced the step carrying this metadata. */
export function servedByFallback(
  metadata: GenerateResult["providerMetadata"]
): boolean {
  return metadata?.[GATEKEEPER_METADATA]?.[SERVED_BY_FALLBACK] === true;
}

/** Tag a fallback result, preserving whatever the provider already put there. */
function marked(result: GenerateResult): GenerateResult {
  return {
    ...result,
    providerMetadata: {
      ...result.providerMetadata,
      [GATEKEEPER_METADATA]: {
        ...result.providerMetadata?.[GATEKEEPER_METADATA],
        [SERVED_BY_FALLBACK]: true
      }
    }
  };
}

type Usage = GenerateResult["usage"];

/** Add two token counts, keeping "not reported" distinct from "zero". */
function addTokens(
  a: number | undefined,
  b: number | undefined
): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/**
 * The tokens **both** models spent on one call.
 *
 * Only the narration path needs this, and it is the whole reason it exists: a
 * primary that answered in prose answered — it read the prompt, produced output,
 * and the account was charged for it — and then its result was thrown away. The
 * SDK sees one model call and would otherwise record only the second model's
 * half, so `[agent-turn]` would under-report exactly the turns that went wrong.
 *
 * `inputTokens` therefore becomes **tokens billed, not prompt size**: the same
 * prompt was sent twice and counted twice, which is what the invoice says. The
 * per-call breakdown is in the AI Gateway log, which has a row for each.
 */
function withBothUsages(
  result: GenerateResult,
  primary: Usage
): GenerateResult {
  const fallback = result.usage;
  return {
    ...result,
    usage: {
      inputTokens: {
        total: addTokens(primary.inputTokens.total, fallback.inputTokens.total),
        noCache: addTokens(
          primary.inputTokens.noCache,
          fallback.inputTokens.noCache
        ),
        cacheRead: addTokens(
          primary.inputTokens.cacheRead,
          fallback.inputTokens.cacheRead
        ),
        cacheWrite: addTokens(
          primary.inputTokens.cacheWrite,
          fallback.inputTokens.cacheWrite
        )
      },
      outputTokens: {
        total: addTokens(
          primary.outputTokens.total,
          fallback.outputTokens.total
        ),
        text: addTokens(primary.outputTokens.text, fallback.outputTokens.text),
        reasoning: addTokens(
          primary.outputTokens.reasoning,
          fallback.outputTokens.reasoning
        )
      },
      // The provider's own shape, left as the fallback reported it: it is
      // per-provider and undocumented, so summing across two calls would be
      // inventing a meaning for it.
      ...(fallback.raw !== undefined ? { raw: fallback.raw } : {})
    }
  };
}

/**
 * A cancelled turn is not a model failure, and must not spend the fallback on it.
 *
 * Deliberately the same predicate as the SDK's own `isAbortError`, which `ai` does
 * not re-export: a cancellation reaches here as a `DOMException` rather than an
 * `Error` — that is what `AbortSignal` throws — and the provider passes those
 * through untouched. Testing `instanceof Error` alone would let a cancelled turn
 * fall into the catch below and spend a second model on it.
 */
function isAbort(err: unknown): boolean {
  return (
    (err instanceof Error || err instanceof DOMException) &&
    (err.name === "AbortError" ||
      err.name === "ResponseAborted" ||
      err.name === "TimeoutError")
  );
}

/**
 * Whether a result fails the tool choice the call enforced.
 *
 * Deliberately the same test the SDK applies a moment later (the one that raises
 * `ToolChoiceViolationError`): a `tool-call` part satisfies `required`, and one
 * naming the tool satisfies `{ type: "tool" }`. Like the SDK, it does not care
 * whether the call's *input* is valid — a malformed `final_reply` is the repair
 * loop's problem, and switching models would not fix it.
 */
function violatesToolChoice(
  toolChoice: CallOptions["toolChoice"],
  content: GenerateResult["content"]
): boolean {
  if (toolChoice == null) return false;
  const enforced = toolChoice;
  if (enforced.type !== "required" && enforced.type !== "tool") return false;
  return !content.some(
    (part) =>
      part.type === "tool-call" &&
      (enforced.type === "required" || part.toolName === enforced.toolName)
  );
}

/**
 * Try `fallback` when the wrapped model throws, or narrates under an enforced tool
 * choice.
 *
 * The fallback's own result is returned as it comes, even if it narrates too: one
 * fallback per call, no second guess. `generateText` then raises the violation
 * itself, and the turn classifies that as an ending it has no reply for — which is
 * what the forced final round exists to rescue.
 *
 * Only `wrapGenerate` is implemented. Nothing here streams; a future `streamText`
 * would get no fallback until `wrapStream` is written to match.
 */
/**
 * The same params, with the fallback model's own reasoning budget on them.
 *
 * The two models do not share a `reasoning_effort` enum, so switching model has
 * to switch budget with it — and `providerOptions` is the only route that can
 * carry the fallback's, since `workers-ai-provider` types its `reasoning_effort`
 * setting by the flash models' enum. The provider reads this key first, ahead of
 * both the unified option and any setting, so it lands whatever the primary was
 * configured with. Anything already under `workers-ai` is preserved.
 */
function withFallbackEffort(
  params: CallOptions,
  effort: string | undefined
): CallOptions {
  if (effort === undefined) return params;
  return {
    ...params,
    providerOptions: {
      ...params.providerOptions,
      "workers-ai": {
        ...params.providerOptions?.["workers-ai"],
        reasoning_effort: effort
      }
    }
  };
}

export function fallbackMiddleware(
  fallback: Model,
  /** The fallback's reasoning budget. Omitted, it keeps whatever the call had. */
  effort?: string
): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, params, model }) => {
      let result: GenerateResult;
      try {
        result = await doGenerate();
      } catch (err) {
        if (isAbort(err)) throw err;
        console.warn("[model] call failed, trying the fallback model", {
          model: model.modelId,
          fallbackModel: fallback.modelId,
          error: String(err)
        });
        // A failure here is the end of the line: it propagates to the SDK, which
        // decides whether it is worth retrying the pair.
        return marked(
          await fallback.doGenerate(withFallbackEffort(params, effort))
        );
      }

      if (!violatesToolChoice(params.toolChoice, result.content)) return result;

      console.warn(
        "[model] narrated under an enforced tool choice, trying the fallback model",
        {
          model: model.modelId,
          fallbackModel: fallback.modelId,
          finishReason: result.finishReason.unified
        }
      );
      // The primary's tokens ride along: unlike the throw above, this call
      // succeeded and was billed before its answer was rejected.
      return marked(
        withBothUsages(
          await fallback.doGenerate(withFallbackEffort(params, effort)),
          result.usage
        )
      );
    }
  };
}
