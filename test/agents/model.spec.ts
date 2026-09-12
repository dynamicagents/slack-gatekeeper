import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { embedMany, generateText } from "ai";
import {
  chatModel,
  embeddingModel,
  CHAT_CALL_OPTIONS,
  type GatewayCallMetadata
} from "@/agents/model";
import {
  AI_GATEWAY_ID,
  CHAT_FALLBACK,
  CHAT_MODELS,
  CHAT_PRIMARY,
  EMBED_MODEL_ID
} from "@/config";

/**
 * What reaches `env.AI.run`, which is the only thing AI Gateway ever sees.
 *
 * Asserted at the binding rather than on the model object because the provider
 * resolves the gateway as `this.config.gateway ?? gateway` — construction-time
 * wins over per-model settings. A `gateway` set on `createWorkersAI` would make
 * every metadata object below dead code while every one of these models still
 * looked correctly configured, which is precisely how `AiGatewayLog.metadata`
 * stayed empty. Only the third argument of `run` tells the truth.
 */

type RunOptions = { gateway?: GatewayOptions };

function stubRun(impl?: (model: string) => unknown) {
  return vi
    .spyOn(env.AI, "run")
    .mockImplementation((async (model: string) =>
      impl ? impl(model) : { response: "ok" }) as never);
}

/** The `reasoning_effort` on the inputs of the `n`th binding call. */
function effortOf(run: ReturnType<typeof stubRun>, n = 0): unknown {
  return (run.mock.calls[n]?.[1] as { reasoning_effort?: unknown } | undefined)
    ?.reasoning_effort;
}

/** The gateway options the `n`th binding call ran under. */
function gatewayOf(
  run: ReturnType<typeof stubRun>,
  n = 0
): GatewayOptions | undefined {
  return (run.mock.calls[n]?.[2] as RunOptions | undefined)?.gateway;
}

const fullTurn: GatewayCallMetadata = {
  call: "turn",
  tenant: "admin",
  workspaceId: 7,
  contextId: "C123:1700000000.0001",
  user: "U123"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the chat model list", () => {
  // The pairing of a model with its own reasoning ceiling is enforced by the
  // compiler: an entry missing `reasoningEffort` fails `satisfies ChatModel[]`,
  // and a primary given a level `workers-ai-provider` does not declare fails at
  // the model settings. These two are the parts types cannot see.

  it("declares exactly the primary and the one fallback the middleware takes", () => {
    // `fallbackMiddleware` accepts a single fallback model. A third entry here
    // would read as a chain and be silently ignored, which is the worst shape a
    // config mistake can take.
    expect(CHAT_MODELS).toHaveLength(2);
    expect(CHAT_MODELS[0]).toBe(CHAT_PRIMARY);
    expect(CHAT_MODELS[1]).toBe(CHAT_FALLBACK);
  });

  it("falls back to a different model than it started on", () => {
    // The fallback exists for a model being unreachable or refusing to call a
    // tool. Pointing it at the primary would spend a second call reproducing the
    // first failure, and nothing else would notice.
    expect(CHAT_FALLBACK.id).not.toBe(CHAT_PRIMARY.id);
  });

  it("gives every model a reasoning budget of its own", () => {
    for (const model of CHAT_MODELS) {
      expect(model.reasoningEffort.length).toBeGreaterThan(0);
    }
  });
});

describe("the gateway identity a model call carries", () => {
  it("labels a turn with the thread, the tenant and the workspace", async () => {
    const run = stubRun();

    await generateText({
      model: chatModel(fullTurn),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS
    });

    expect(run.mock.calls[0]?.[0]).toBe(CHAT_PRIMARY.id);
    expect(gatewayOf(run)).toEqual({
      id: AI_GATEWAY_ID,
      metadata: fullTurn
    });
  });

  it("spends no more than the five entries AI Gateway accepts", async () => {
    // The cap is the gateway's, not ours, and it rejects rather than truncates.
    // A sixth field added to `GatewayCallMetadata` types fine and compiles fine
    // and breaks every model call in production; this is the only thing in the
    // way of that.
    const run = stubRun();

    await generateText({
      model: chatModel(fullTurn),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS
    });

    expect(
      Object.keys(gatewayOf(run)?.metadata ?? {}).length
    ).toBeLessThanOrEqual(5);
  });

  it("omits what a call has no answer for rather than sending it empty", async () => {
    // The onboarding concierge runs per user, so it has no workspace — and a
    // `workspaceId: undefined` entry would spend one of five saying nothing.
    const run = stubRun();

    await generateText({
      model: chatModel({ call: "summarize", tenant: "onboarding" }),
      prompt: "summarize this",
      ...CHAT_CALL_OPTIONS
    });

    expect(gatewayOf(run)?.metadata).toEqual({
      call: "summarize",
      tenant: "onboarding"
    });
  });

  it("carries the same identity when the fallback model serves the call", async () => {
    // A call that failed over is still the same turn's cost. If only the primary
    // were labelled, every fallback would land in the gateway log unattributed —
    // and those are the rows most worth finding.
    const run = stubRun((model) => {
      if (model === CHAT_PRIMARY.id)
        throw new Error("primary is out of capacity");
      return { response: "from the fallback" };
    });

    await generateText({
      model: chatModel(fullTurn),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS,
      maxRetries: 0
    });

    expect(run.mock.calls[1]?.[0]).toBe(CHAT_FALLBACK.id);
    expect(gatewayOf(run, 1)).toEqual({
      id: AI_GATEWAY_ID,
      metadata: fullTurn
    });
  });

  it("still routes recall's embeddings through the gateway", async () => {
    // The regression this exists for. Dropping the top-level `gateway` from
    // `createWorkersAI` is what made per-call metadata reachable, and it also
    // silently unhooks any model that does not carry one of its own. Embeddings
    // would simply stop appearing in the gateway log, with nothing failing.
    const run = stubRun(() => ({ data: [Array<number>(1024).fill(0.1)] }));

    await embedMany({
      model: embeddingModel(),
      values: ["a message worth remembering"],
      telemetry: { isEnabled: false }
    });

    expect(run.mock.calls[0]?.[0]).toBe(EMBED_MODEL_ID);
    expect(gatewayOf(run)).toEqual({
      id: AI_GATEWAY_ID,
      metadata: { call: "embed" }
    });
  });

  it("asks each model for the deepest reasoning that model offers", async () => {
    // The two do not share an enum — Cloudflare documents `low|medium|high` for
    // the primary and `none|high|max` for the fallback — so one shared value
    // cannot be right for both. It used to be: `medium` went to a model with no
    // `medium`, and Workers AI quietly coerced it.
    //
    // The fallback's ceiling cannot travel as a model setting at all, because
    // `workers-ai-provider` types `reasoning_effort` by the flash models' enum.
    // It goes through `providerOptions["workers-ai"]`, which the provider reads
    // ahead of any setting.
    const run = stubRun((model) => {
      if (model === CHAT_PRIMARY.id)
        throw new Error("primary is out of capacity");
      return { response: "from the fallback" };
    });

    await generateText({
      model: chatModel(fullTurn),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS,
      maxRetries: 0
    });

    expect(run.mock.calls[0]?.[0]).toBe(CHAT_PRIMARY.id);
    expect(effortOf(run, 0)).toBe(CHAT_PRIMARY.reasoningEffort);
    expect(run.mock.calls[1]?.[0]).toBe(CHAT_FALLBACK.id);
    expect(effortOf(run, 1)).toBe(CHAT_FALLBACK.reasoningEffort);
    // The two really are different words, which is the whole reason each model
    // carries its own rather than sharing one constant.
    expect(CHAT_PRIMARY.reasoningEffort).not.toBe(
      CHAT_FALLBACK.reasoningEffort
    );
  });

  it("lets a test seam replace the model without reaching the binding at all", async () => {
    const run = stubRun();

    const model = chatModel(fullTurn, { model: "some-other-model" });

    expect(model).toBe("some-other-model");
    expect(run).not.toHaveBeenCalled();
  });
});
