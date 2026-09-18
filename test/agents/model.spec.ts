import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { embedMany, generateText } from "ai";
import {
  chatModel,
  embeddingModel,
  gatewayLogFields,
  CHAT_CALL_OPTIONS,
  GATEWAY_METADATA_MAX,
  type GatewayCall,
  type GatewayCallFields
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

/** A round with every one of the five answered, plus its correlation id. */
const fullRound: GatewayCall = {
  agent: "admin",
  phase: "round",
  round: 1,
  channel: "C123:1700000000.0001",
  workspaceId: 7,
  eventId: "task-1:r1"
};

/** The five, as the gateway will store them — `eventId` is not among them. */
const fullRoundMetadata = {
  agent: "admin",
  phase: "round",
  round: 1,
  channel: "C123:1700000000.0001",
  workspaceId: 7
};

/** The five keys, in the order {@link gatewayLogFields} spends them. */
const PRIORITY = ["agent", "phase", "round", "channel", "workspaceId"];

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

describe("gatewayLogFields", () => {
  it("spends the five in priority order and stops there", () => {
    // The cap is the gateway's, not ours, and it enforces it by silent
    // truncation: the first five entries are saved and the rest ignored, with no
    // error to debug from. So the order these are spent in is the order they would
    // be given up in, and `workspaceId` is the one with nothing behind it.
    const metadata = gatewayLogFields({
      agent: "admin",
      phase: "round",
      round: 2,
      channel: "C123:1700000000.0001",
      workspaceId: 7
    });

    expect(Object.keys(metadata)).toEqual(PRIORITY);
    expect(Object.keys(metadata)).toHaveLength(GATEWAY_METADATA_MAX);
  });

  it("will not take a sixth dimension at the type level", () => {
    gatewayLogFields({
      agent: "admin",
      phase: "round",
      // @ts-expect-error — the five are a hard cap, so a sixth has to displace one
      // of them in a diff someone reviews, not arrive beside them. Deleting this
      // directive is what fails the build when the type stops saying so.
      taskId: "task-1"
    });
  });

  it("ignores a sixth that arrives past the type", () => {
    // A cast, or plain JavaScript calling in. The type is the first line of the
    // cap and this is the second: the builder reads its own five and nothing else,
    // so an extra key is not spent, not truncated — never a candidate at all.
    const smuggled = {
      agent: "admin",
      phase: "round",
      round: 1,
      channel: "C123:1700000000.0001",
      workspaceId: 7,
      taskId: "task-1"
    } as GatewayCallFields;

    const metadata = gatewayLogFields(smuggled);

    expect(Object.keys(metadata)).toEqual(PRIORITY);
    expect(metadata).not.toHaveProperty("taskId");
  });

  it("cannot be handed a person, however the caller spells one", () => {
    // The privacy regression. Every field below is one property away from a real
    // call site: `turnGatewayCall` reads the same parsed wire metadata that holds
    // `user.slackUserId`, and one convenient spread is all it would ever take. The
    // gateway log is retained and readable by anyone who can read the account, so a
    // Slack user id in a row is a record of who said what, kept where nobody would
    // think to look. The builder reading only its own declared keys is the only
    // thing in the way, which is why it must never grow an `Object.entries`.
    const leaky = {
      agent: "onboarding",
      phase: "round",
      round: 1,
      channel: "C123:1700000000.0001",
      userId: "U123",
      slackUserId: "U123",
      user: { slackUserId: "U123", email: "grace@example.com" }
    } as GatewayCallFields;

    const metadata = gatewayLogFields(leaky);

    expect(Object.keys(metadata)).toEqual([
      "agent",
      "phase",
      "round",
      "channel"
    ]);
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain("U123");
    expect(serialized).not.toContain("grace@example.com");
    expect(serialized).not.toContain("user");
  });

  it("omits what a call has no answer for rather than sending it empty", () => {
    // The onboarding concierge runs per user, so it has no workspace — and a
    // `workspaceId: undefined` entry would spend one of five saying nothing.
    expect(
      gatewayLogFields({ agent: "onboarding", phase: "compaction" })
    ).toEqual({ agent: "onboarding", phase: "compaction" });
    expect(
      gatewayLogFields({ agent: "admin", phase: "round", channel: "" })
    ).toEqual({ agent: "admin", phase: "round" });
  });
});

describe("the gateway identity a model call carries", () => {
  it("labels a round with the agent, the thread and the workspace", async () => {
    const run = stubRun();

    await generateText({
      model: chatModel(fullRound),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS
    });

    expect(run.mock.calls[0]?.[0]).toBe(CHAT_PRIMARY.id);
    expect(gatewayOf(run)).toEqual({
      id: AI_GATEWAY_ID,
      metadata: fullRoundMetadata,
      eventId: "task-1:r1"
    });
  });

  it("carries the task correlation beside the five rather than inside them", async () => {
    // `GatewayOptions.eventId` is its own field on the request, so the join from a
    // gateway row back to the task that paid for it costs none of the five. Spent
    // as metadata it would displace `workspaceId`, which is the whole reason
    // `taskId` was left off this side in the first place.
    const run = stubRun();

    await generateText({
      model: chatModel(fullRound),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS
    });

    const gateway = gatewayOf(run);
    expect(gateway?.eventId).toBe("task-1:r1");
    expect(Object.keys(gateway?.metadata ?? {})).toEqual(PRIORITY);
    expect(gateway?.metadata).not.toHaveProperty("eventId");
  });

  it("gives a compaction no event id, because no one task paid for it", async () => {
    // A compaction runs inside the one `Session` every task on that Durable Object
    // shares. An event id there would name whichever task happened to tip the token
    // budget over, and filtering by it would return a summary of other tasks'
    // history — worse than nothing, because it looks like an answer.
    const run = stubRun();

    await generateText({
      model: chatModel({ agent: "admin", phase: "compaction", workspaceId: 7 }),
      prompt: "summarize this",
      ...CHAT_CALL_OPTIONS
    });

    expect(gatewayOf(run)?.metadata).toEqual({
      agent: "admin",
      phase: "compaction",
      workspaceId: 7
    });
    expect(gatewayOf(run)?.eventId).toBeUndefined();
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
      model: chatModel(fullRound),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS,
      maxRetries: 0
    });

    expect(run.mock.calls[1]?.[0]).toBe(CHAT_FALLBACK.id);
    expect(gatewayOf(run, 1)).toEqual({
      id: AI_GATEWAY_ID,
      metadata: fullRoundMetadata,
      eventId: "task-1:r1"
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
    // No `agent`: one memoised model serves both agents' recall, so either name on
    // it would be wrong half the time. No `eventId` either — an embedding belongs
    // to a compaction's archive, not to the task that triggered it.
    expect(gatewayOf(run)).toEqual({
      id: AI_GATEWAY_ID,
      metadata: { phase: "embed" }
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
      model: chatModel(fullRound),
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

    const model = chatModel(fullRound, { model: "some-other-model" });

    expect(model).toBe("some-other-model");
    expect(run).not.toHaveBeenCalled();
  });
});
