import type { LanguageModelMiddleware } from "ai";
import { isRecord, jsonOf } from "@/util/json";

/**
 * Guard the one invariant every provider assumes and none of them state: a
 * replayed tool call's `input` is an **object**.
 *
 * `arguments` on a tool call is a JSON object by contract, and providers
 * re-serialize a replayed call as `arguments: JSON.stringify(input)`. Hand that a
 * string and the string is what the model receives — Workers AI rejects it outright
 * on `glm-5.2` ("Assistant tool call function.arguments must be a JSON object") and
 * crashes rendering it on `glm-4.7-flash` (`'str object' has no attribute 'items'`,
 * the chat template calling `.items()` on a `str`). Both were observed on models
 * this repo ran at the time; `glm-4.7-flash` is no longer one of them and
 * `glm-5.3-flash` has not been checked. That changes nothing here — this exists
 * for durable history written before `capInput`, which has to keep replaying
 * whatever model reads it.
 *
 * What can put a non-object there is a **durable record capped past the size
 * ceiling** — fixed at the source in `capInput`
 * ({@link file://./shared/messages.ts messages.ts}), but records written before that
 * fix live in Sessions and replay on every later turn. Nothing but time removes
 * them, so this is the only place that can.
 *
 * The SDK's own replay is no longer a second cause. A tool call it could not parse
 * is handed back as the raw arguments string, but it substitutes `{}` before
 * building the message that replays it (`to-response-messages.ts`), so the
 * malformed `final_reply` that the loop now repairs in place never reaches the wire
 * as a string. Belt and braces: this still catches it if that ever changes.
 *
 * A middleware sits at the last boundary before serialization, which is what lets
 * it reach history the turn itself cannot. It warns rather than repairing silently:
 * a poisoned record should stay visible in the logs until it ages out.
 */

type TransformParams = NonNullable<LanguageModelMiddleware["transformParams"]>;
type CallOptions = Parameters<TransformParams>[0]["params"];
type PromptMessage = CallOptions["prompt"][number];

/**
 * Coerce one tool call's arguments back to an object.
 *
 * A string that parses to an object *is* the original arguments, double-encoded —
 * that is the exact shape a capped record replays as, and parsing recovers it
 * whole. Anything else (truncated JSON, a bare scalar) cannot be recovered, so it
 * is wrapped: the text stays readable to the model, and the wire shape is valid.
 */
function asArgumentsObject(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON at all — fall through to the wrapper.
    }
    return { _raw: input };
  }
  // `jsonOf`, not `JSON.stringify`: this is the last guard before the provider, so
  // it has to survive whatever it is handed. A cycle or a BigInt throwing here
  // would turn a repairable message into the crash the middleware exists to
  // prevent, and `undefined` would silently drop the key.
  return { _raw: jsonOf(input) };
}

export const normalizeToolInputMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const repaired: string[] = [];

    const prompt = params.prompt.map((message): PromptMessage => {
      if (message.role !== "assistant") return message;
      let changed = false;
      const content = message.content.map((part) => {
        if (part.type !== "tool-call" || isRecord(part.input)) return part;
        changed = true;
        repaired.push(part.toolName);
        return { ...part, input: asArgumentsObject(part.input) };
      });
      return changed ? { ...message, content } : message;
    });

    if (repaired.length === 0) return params;
    console.warn("[model] repaired non-object tool-call arguments in history", {
      count: repaired.length,
      tools: [...new Set(repaired)]
    });
    return { ...params, prompt };
  }
};
