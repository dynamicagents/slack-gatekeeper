import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { generateText } from "ai";
import {
  chatModel,
  gatewayLogFields,
  CHAT_CALL_OPTIONS,
  GATEWAY_METADATA_MAX,
  type GatewayCall,
  type GatewayCallFields
} from "@/agents/model";
import { AI_GATEWAY_ID, CHAT_MODEL } from "@/config";

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

type RunOptions = {
  gateway?: GatewayOptions;
  extraHeaders?: Record<string, string>;
};

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

/**
 * The extra headers the `n`th binding call ran under — where
 * `x-session-affinity` lands, beside the gateway options rather than inside them.
 */
function extraHeadersOf(
  run: ReturnType<typeof stubRun>,
  n = 0
): Record<string, string> | undefined {
  return (run.mock.calls[n]?.[2] as RunOptions | undefined)?.extraHeaders;
}

/** A round with every declared field answered, plus its correlation id. */
const fullRound: GatewayCall = {
  agent: "admin",
  phase: "round",
  channel: "C123:1700000000.0001",
  workspaceId: 7,
  eventId: "task-1"
};

/** Those fields, as the gateway will store them — `eventId` is not among them. */
const fullRoundMetadata = {
  agent: "admin",
  phase: "round",
  channel: "C123:1700000000.0001",
  workspaceId: 7
};

/** The declared keys, in the order {@link gatewayLogFields} spends them. */
const PRIORITY = ["agent", "phase", "channel", "workspaceId"];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the chat model", () => {
  // That the ceiling is a level the model declares is typechecked in `config.ts`,
  // against the generated `AiModels` input type — the provider cannot do it, since
  // the level travels as `providerOptions`, which is plain JSON to the compiler.
  // That it is set *at all* is the part no type can see: left unset, the model
  // picks its own depth and GLM has answered registry questions from the
  // conversation instead of calling the tool that would have checked.

  it("gives the model a reasoning budget rather than the model's default", () => {
    expect(CHAT_MODEL.reasoningEffort.length).toBeGreaterThan(0);
  });

  it("carries that budget on every shared call option, not on the model", () => {
    // The one object both call sites spread. A depth that lived only on the model
    // settings would be dropped by the provider's own type; a depth that lived
    // only in `loop.ts` would leave the compaction summarizer on the default.
    expect(CHAT_CALL_OPTIONS.providerOptions["workers-ai"]).toEqual({
      reasoning_effort: CHAT_MODEL.reasoningEffort
    });
  });
});

describe("gatewayLogFields", () => {
  it("spends its fields in priority order, within the gateway's cap", () => {
    // The cap is the gateway's, not ours, and it enforces it by silent
    // truncation: the first `GATEWAY_METADATA_MAX` entries are saved and the rest
    // ignored, with no error to debug from. So the order these are spent in is the
    // order they would be given up in, and `workspaceId` is the one with nothing
    // behind it.
    const metadata = gatewayLogFields({
      agent: "admin",
      phase: "round",
      channel: "C123:1700000000.0001",
      workspaceId: 7
    });

    expect(Object.keys(metadata)).toEqual(PRIORITY);
    // Growing the declared set past the cap would drop whichever field is last in
    // priority order from every call in production, with nothing to notice it by.
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(
      GATEWAY_METADATA_MAX
    );
  });

  it("will not take an undeclared dimension at the type level", () => {
    gatewayLogFields({
      agent: "admin",
      phase: "round",
      // @ts-expect-error — the gateway's cap is close enough that a new dimension
      // has to displace one of these in a diff someone reviews, not arrive beside
      // them. Deleting this directive is what fails the build when the type stops
      // saying so.
      taskId: "task-1"
    });
  });

  it("ignores an undeclared key that arrives past the type", () => {
    // A cast, or plain JavaScript calling in. The type is the first line of the
    // guard and this is the second: the builder reads its own declared fields and
    // nothing else, so an extra key is never a candidate at all.
    const smuggled = {
      agent: "admin",
      phase: "round",
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
      channel: "C123:1700000000.0001",
      userId: "U123",
      slackUserId: "U123",
      user: { slackUserId: "U123", email: "grace@example.com" }
    } as GatewayCallFields;

    const metadata = gatewayLogFields(leaky);

    expect(Object.keys(metadata)).toEqual(["agent", "phase", "channel"]);
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

    expect(run.mock.calls[0]?.[0]).toBe(CHAT_MODEL.id);
    expect(gatewayOf(run)).toEqual({
      id: AI_GATEWAY_ID,
      metadata: fullRoundMetadata,
      eventId: "task-1"
    });
  });

  it("carries the task correlation beside the metadata rather than inside it", async () => {
    // `GatewayOptions.eventId` is its own field on the request, so the join from a
    // gateway row back to the task that paid for it costs no metadata entry. Spent
    // as metadata it would displace `workspaceId`, which is the whole reason
    // `taskId` was left off this side in the first place.
    const run = stubRun();

    await generateText({
      model: chatModel(fullRound),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS
    });

    const gateway = gatewayOf(run);
    expect(gateway?.eventId).toBe("task-1");
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

  it("asks the model for the deepest reasoning that model offers", async () => {
    // The depth has to reach the binding as `reasoning_effort` on the model's own
    // inputs, and reach it unaltered. Two layers would quietly change it on the
    // way: Workers AI coerces a level it does not recognize instead of rejecting
    // it — a shared `medium` once went to a model with no `medium` and arrived as
    // `high` — and the provider clamps the unified `reasoning` option's ceiling
    // down to `high`, which is why the level goes through `providerOptions`
    // instead. This is the only place what was actually sent can be seen.
    const run = stubRun();

    await generateText({
      model: chatModel(fullRound),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS
    });

    expect(run.mock.calls[0]?.[0]).toBe(CHAT_MODEL.id);
    expect(effortOf(run, 0)).toBe(CHAT_MODEL.reasoningEffort);
  });

  it("lets a test seam replace the model without reaching the binding at all", async () => {
    const run = stubRun();

    const model = chatModel(fullRound, { model: "some-other-model" });

    expect(model).toBe("some-other-model");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the session affinity a model call is steered by", () => {
  // A separate concern from the identity above, and deliberately a separate
  // describe: `x-session-affinity` steers Workers AI's *model-instance* routing
  // so a call lands on the replica already holding its prompt prefix. The
  // gateway neither reads it nor logs it, and the binding is the only layer
  // where what was actually sent can be seen.

  it("delivers the affinity key to the binding as a header", async () => {
    const run = stubRun();

    await generateText({
      model: chatModel(fullRound, { sessionAffinity: "admin:7" }),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS
    });

    expect(extraHeadersOf(run)).toEqual({ "x-session-affinity": "admin:7" });
    // And it neither displaced a gateway field nor rode inside one. The two
    // travel together on the same `run` options, which is exactly why this is
    // worth asserting: a key that ended up in `metadata` would spend one of the
    // capped entries and still look like it worked.
    expect(gatewayOf(run)).toEqual({
      id: AI_GATEWAY_ID,
      metadata: fullRoundMetadata,
      eventId: "task-1"
    });
  });

  it("sends no affinity header when there is no key", async () => {
    // Absent, not empty. A blank `x-session-affinity` is still a key, and it
    // would pin every unsteered call in the account to one instance — so the
    // property has to be missing from the options entirely.
    const run = stubRun();

    await generateText({
      model: chatModel(fullRound),
      prompt: "hi",
      ...CHAT_CALL_OPTIONS
    });

    expect(run.mock.calls[0]?.[2]).not.toHaveProperty("extraHeaders");
    expect(extraHeadersOf(run)).toBeUndefined();
  });
});
