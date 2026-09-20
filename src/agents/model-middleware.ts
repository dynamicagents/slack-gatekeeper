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
 * the chat template calling `.items()` on a `str`). `glm-4.7-flash` is no longer a
 * model this repo runs; `glm-5.2` is — it is `CHAT_FALLBACK` — so the failure this
 * prevents is still reachable by a configured model.
 *
 * **What this no longer does is repair known damage.** It was written for durable
 * records written before `capInput`
 * ({@link file://./shared/messages.ts messages.ts}) stopped capping a tool call's
 * input as one value and leaving a string behind. Such a record would live in
 * Sessions and replay on every later turn, with nothing but time to remove it — but
 * none can exist here: `capInput` landed 2026-08-20 and the `slack-gatekeeper`
 * Worker was created 2026-09-05 (`created_on` on the script, which its oldest
 * surviving version and deployment agree with). Production never ran the code that
 * wrote them. Checked against the live account 2026-09-20: the admin agent's history
 * started 2026-09-05 and carried no `_raw` marker, and the onboarding agent had no
 * Durable Object instance at all.
 *
 * It is kept as a backstop for the two ways a string could still arrive:
 *
 * - `capInput` is the only thing keeping one out of a stored record, and nothing
 *   forces a future writer through it. That regression is silent until a turn dies,
 *   and then every later turn on that session dies with it.
 * - The SDK substitutes `{}` for a tool call it cannot parse before building the
 *   message that replays it (`to-response-messages.ts`), so its own replay is not a
 *   second cause today. That is behaviour, not a contract.
 *
 * A middleware sits at the last boundary before serialization, which is what lets it
 * reach history the turn itself cannot. It warns rather than repairing silently —
 * and with the backlog gone, a warning now means a live bug, not an old record
 * ageing out.
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
