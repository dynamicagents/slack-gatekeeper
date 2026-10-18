import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import {
  AgentCard,
  Message,
  SendMessageResponse,
  TaskState
} from "@a2a-js/sdk";
import { registerAgent } from "@/db/models/agents";
import {
  setPublicUrl,
  setAllowedRemoteAgentDomains
} from "@/db/models/workspace-configs";
import {
  createAgentTask,
  suspendForInput,
  getAgentTaskByToken,
  completeAgentTask
} from "@/db/models/agent-tasks";
import {
  createHitlForm,
  setHitlFormMessageTs,
  getHitlForm,
  cancelHitlFormsByToken
} from "@/db/models/hitl-forms";
import { TASK_ENDED_NOTE } from "@/a2a/notifications/hitl";
import { _resetIssuerCacheForTest } from "@/a2a/dispatch";
import { buildAgentCard } from "@/a2a/card";
import {
  BACK_ACTION,
  FORM_CALLBACK_ID,
  formPages,
  OPEN_ACTION,
  otherBlockId,
  PICK_ACTION,
  requestBlocks
} from "@/slack/hitl/render";
import { choiceForm } from "./helpers/hitl";
import {
  HITL_REQUEST_TYPE,
  MAX_MESSAGE_TEXT_BYTES,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import { HITL_RESPONSE_TYPE } from "@/a2a/hitl";
import { dataOf, partsText } from "@/a2a/parts";
import { agentMessage, makeTask } from "./helpers/a2a";
import { handleSlackInteractivity } from "@/slack-interactivity-handler";
import { slackHeaders } from "./helpers/slack";
import { blocksText, messageViolations } from "./helpers/slack-limits";
import { useStorageReset } from "./helpers/storage";

useStorageReset();

const ENDPOINT = "https://remote.example.com/a2a";
const ISSUER = "https://gw.example.com";

interface Captured {
  slackUpdates: URLSearchParams[];
  /** Views opened with `views.open`, decoded. */
  views?: Record<string, unknown>[];
  /** `views.update` calls: the view replaced, its new content, and the hash. */
  viewUpdates?: {
    viewId: string;
    view: Record<string, unknown>;
    hash: string;
  }[];
  slackEphemerals: URLSearchParams[];
  /** Plain `chat.postMessage` thread replies (e.g. the resume-failed notice). */
  slackReplies: URLSearchParams[];
  resumeMessages: Message[];
}

/**
 * Route Slack API calls and the remote A2A send to a single capturing stub. Pass
 * `rejectResume` to make the remote break the async contract (a sync message
 * reply instead of a Task ack), so the continuation is not accepted. Pass
 * `failResume: n` to make the first `n` sends fail in transport — no verdict,
 * the kind of failure worth retrying.
 */
function stub(
  captured: Captured,
  opts: {
    rejectResume?: boolean;
    failResume?: number;
    /** Runs before each `chat.update` is answered, to hold or interleave it. */
    onUpdate?: (params: URLSearchParams) => Promise<void>;
    /**
     * Refuse a `chat.update` the way Slack refuses one, even if its blocks fit:
     * return the `response_metadata.messages` to refuse it with.
     */
    refuseUpdate?: (params: URLSearchParams) => string[] | undefined;
  } = {}
) {
  let failuresLeft = opts.failResume ?? 0;
  const card = buildAgentCard({
    name: "Remote",
    description: "remote agent",
    url: ENDPOINT
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = request.url;
      if (url.includes("chat.update")) {
        const params = new URLSearchParams(await request.clone().text());
        captured.slackUpdates.push(params);
        await opts.onUpdate?.(params);
        // Refuse what real Slack refuses, so an answered state that would not
        // render cannot pass here as one that did.
        const violations = messageViolations(blocksOf(params));
        const refusal = violations.length
          ? violations
          : opts.refuseUpdate?.(params);
        if (refusal) {
          return Response.json({
            ok: false,
            error: "invalid_blocks",
            response_metadata: { messages: refusal }
          });
        }
        return Response.json({ ok: true, ts: "1700.9" });
      }
      if (url.includes("views.update")) {
        const params = new URLSearchParams(await request.clone().text());
        captured.viewUpdates?.push({
          viewId: params.get("view_id") ?? "",
          view: JSON.parse(params.get("view") ?? "{}") as Record<
            string,
            unknown
          >,
          hash: params.get("hash") ?? ""
        });
        return Response.json({ ok: true, view: { id: "V1" } });
      }
      if (url.includes("views.open")) {
        const params = new URLSearchParams(await request.clone().text());
        captured.views?.push(
          JSON.parse(params.get("view") ?? "{}") as Record<string, unknown>
        );
        return Response.json({ ok: true, view: { id: "V1" } });
      }
      if (url.includes("chat.postEphemeral")) {
        captured.slackEphemerals.push(
          new URLSearchParams(await request.clone().text())
        );
        return Response.json({ ok: true, message_ts: "1700.99" });
      }
      if (url.includes("chat.postMessage")) {
        captured.slackReplies.push(
          new URLSearchParams(await request.clone().text())
        );
        return Response.json({ ok: true, ts: "1700.98" });
      }
      // A2A: card discovery (GET) + SendMessage (POST).
      if (request.method.toUpperCase() === "POST") {
        const rpc = (await request.clone().json()) as {
          id?: unknown;
          params?: { message?: Message };
        };
        // The message arrives as protobuf-JSON; decode it so assertions run
        // against the same typed shape the gatekeeper sent.
        captured.resumeMessages.push(
          Message.fromJSON(rpc.params?.message ?? {})
        );
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new TypeError("fetch failed");
        }
        if (opts.rejectResume) {
          // Sync reply instead of a Task ack → the gatekeeper treats it as a non-accept.
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: SendMessageResponse.toJSON({
              payload: {
                $case: "message",
                value: agentMessage("no ack", { contextId: "reply" })
              }
            })
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: SendMessageResponse.toJSON({
            payload: {
              $case: "task",
              value: makeTask({
                id: "task-remote-1",
                contextId: "reply",
                state: TaskState.TASK_STATE_SUBMITTED
              })
            }
          })
        });
      }
      return Response.json(AgentCard.toJSON(card));
    })
  );
}

/** A signed Slack Interactivity POST (form-encoded `payload=`). */
async function interactivityRequest(payload: unknown): Promise<Request> {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const headers = await slackHeaders(body);
  return new Request(`${ISSUER}/slack/interactivity`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
}

/** A typed answer submitted from the "Other…" modal, as Slack posts it. */
function freeformSubmission(requestId: string, text: string) {
  return {
    type: "view_submission",
    user: { id: "U1" },
    view: {
      callback_id: FORM_CALLBACK_ID,
      private_metadata: JSON.stringify({ r: requestId }),
      state: {
        values: {
          [otherBlockId(0)]: {
            value: { type: "plain_text_input", value: text }
          }
        }
      }
    }
  };
}

/** The prompt `seedParkedRequest` stands for, as `deliverHitlRequest` posts it. */
function promptBlocks(requestId: string): unknown[] {
  return requestBlocks(choiceForm(requestId));
}

/**
 * A click on the prompt's button for `optionId`. Slack sends the message's
 * blocks as they are at the moment of the click; pass `blocks` to click a
 * prompt the gatekeeper has since changed.
 */
function buttonAction(
  requestId: string,
  optionId: string,
  blocks: unknown[] = promptBlocks(requestId)
) {
  const index = ["approve", "reject"].indexOf(optionId);
  return {
    type: "block_actions",
    user: { id: "U1" },
    trigger_id: "trig-1",
    channel: { id: "C1" },
    message: { ts: "1700.9", blocks },
    actions: [
      {
        action_id: `${PICK_ACTION}-${index}`,
        value: JSON.stringify({ r: requestId, q: 0, o: index }),
        type: "button"
      }
    ]
  };
}

async function seedParkedRequest(
  requestId: string,
  prompt = "Proceed?",
  request = choiceForm(requestId, prompt)
) {
  await createAgentTask({
    token: "tok-1",
    taskId: "task-1",
    agentName: "remoteagent",
    channelId: "C1",
    messageTs: "1700.1",
    replyThreadTs: "1700.1",
    eventId: "Ev1"
  });
  await suspendForInput("tok-1");
  await createHitlForm({
    requestId,
    token: "tok-1",
    taskId: "task-1",
    contextId: "reply",
    agentName: "remoteagent",
    channelId: "C1",
    threadTs: "1700.1",
    request,
    deadlineAt: Math.floor(Date.now() / 1000) + 600
  });
  // Simulate the prompt having been posted, so the answered-state update targets it.
  await setHitlFormMessageTs(requestId, "1700.9");
}

beforeEach(async () => {
  _resetIssuerCacheForTest();
  await setPublicUrl(ISSUER);
  await setAllowedRemoteAgentDomains(["remote.example.com"]);
  await registerAgent({
    name: "remoteagent",
    kind: "remote",
    a2aEndpoint: ENDPOINT,
    tenantId: "main",
    notifyOn: "mention",
    workspaceId: 0
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The blocks a captured `chat.update` set. */
function blocksOf(update: URLSearchParams | undefined): unknown[] {
  return JSON.parse(update?.get("blocks") ?? "[]") as unknown[];
}

/** Every delivery note a captured `chat.update` carries. */
function notesOf(update: URLSearchParams | undefined): string[] {
  return blocksOf(update)
    .filter(
      (b): b is { elements: { text: string }[] } =>
        (b as { block_id?: string }).block_id === "hitl-delivery-note"
    )
    .map((b) => b.elements[0].text);
}

function noteOf(update: URLSearchParams | undefined): string | undefined {
  return notesOf(update)[0];
}

/** Whether a captured `chat.update` put the prompt in its answered state. */
function isAnswered(update: URLSearchParams | undefined): boolean {
  return update?.get("text")?.startsWith("Answered:") ?? false;
}

describe("handleSlackInteractivity", () => {
  it("rejects a request with a bad signature", async () => {
    const req = new Request(`${ISSUER}/slack/interactivity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": "1",
        "x-slack-signature": "v0=deadbeef"
      },
      body: "payload=%7B%7D"
    });
    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(req, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("claims a button answer, updates Slack, and resumes the task", async () => {
    await seedParkedRequest("req-1");
    const captured: Captured = {
      slackUpdates: [],
      slackEphemerals: [],
      slackReplies: [],
      resumeMessages: []
    };
    stub(captured);

    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(
      await interactivityRequest(buttonAction("req-1", "approve")),
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);

    // Request is now answered by U1.
    const row = await getHitlForm("req-1");
    expect(row?.status).toBe("answered");
    expect(row?.answeredBy).toBe("U1");
    expect(row?.answersJson).toEqual({ q1: { optionIds: ["approve"] } });

    // The prompt said the answer was on its way, then that it was answered.
    expect(captured.slackUpdates).toHaveLength(2);
    expect(blocksOf(captured.slackUpdates[0])).not.toContainEqual(
      expect.objectContaining({ type: "actions" })
    );
    expect(noteOf(captured.slackUpdates[0])).toContain(
      "Sending <@U1>'s answer"
    );
    expect(isAnswered(captured.slackUpdates[1])).toBe(true);

    // Task resumed: an A2A continuation went to the remote carrying the answer.
    expect(captured.resumeMessages).toHaveLength(1);
    const resume = captured.resumeMessages[0];
    expect(resume.taskId).toBe("task-1");
    expect(resume.referenceTaskIds).toEqual(["task-1"]);
    const answer = resume.parts.map(dataOf).find((d) => d !== undefined);
    expect(answer).toMatchObject({
      type: HITL_RESPONSE_TYPE,
      requestId: "req-1",
      answers: { q1: { optionIds: ["approve"] } }
    });
    // The human-readable option label rides in the text part.
    expect(partsText(resume.parts)).toBe("Approve");

    // The paired task row is un-parked.
    expect((await getAgentTaskByToken("tok-1"))?.status).toBe("pending");
  });

  it("posts an ephemeral and does not resume when already answered", async () => {
    await seedParkedRequest("req-2");
    const captured: Captured = {
      slackUpdates: [],
      slackEphemerals: [],
      slackReplies: [],
      resumeMessages: []
    };
    stub(captured);

    // First answer wins.
    const ctx1 = createExecutionContext();
    await handleSlackInteractivity(
      await interactivityRequest(buttonAction("req-2", "approve")),
      ctx1
    );
    await waitOnExecutionContext(ctx1);

    // Second click on the same (now answered) prompt.
    const ctx2 = createExecutionContext();
    await handleSlackInteractivity(
      await interactivityRequest(buttonAction("req-2", "reject")),
      ctx2
    );
    await waitOnExecutionContext(ctx2);

    expect(captured.resumeMessages).toHaveLength(1); // only the first resumed
    expect(captured.slackEphemerals).toHaveLength(1); // second got a notice
    expect(captured.slackEphemerals[0].get("user")).toBe("U1");
  });

  it("notifies the thread when the remote does not accept the resumed answer", async () => {
    await seedParkedRequest("req-3");
    const captured: Captured = {
      slackUpdates: [],
      slackEphemerals: [],
      slackReplies: [],
      resumeMessages: []
    };
    stub(captured, { rejectResume: true });

    const ctx = createExecutionContext();
    await handleSlackInteractivity(
      await interactivityRequest(buttonAction("req-3", "approve")),
      ctx
    );
    await waitOnExecutionContext(ctx);

    // The answer is recorded and the prompt shows the answered state — the
    // human's action stands; only the handoff to the agent failed.
    const row = await getHitlForm("req-3");
    expect(row?.status).toBe("answered");
    expect(isAnswered(captured.slackUpdates.at(-1))).toBe(true);

    // A refusal is a verdict: the same request would earn the same one, so it is
    // attempted once and not retried.
    expect(captured.resumeMessages).toHaveLength(1);
    expect((await getAgentTaskByToken("tok-1"))?.status).toBe("awaiting-input");

    // The thread is told the agent couldn't be reached, so the user can fix it.
    expect(captured.slackReplies).toHaveLength(1);
    expect(captured.slackReplies[0].get("thread_ts")).toBe("1700.1");
    expect(captured.slackReplies[0].get("text")).toContain("remoteagent");
  });
});

/**
 * An answer that doesn't reach the agent.
 *
 * All of it runs in `ctx.waitUntil`, after Slack has its ack and shows nothing
 * more of its own accord, so every sign of what happened is an update the
 * gatekeeper makes. The waits between attempts are the runtime's
 * `scheduler.wait`, stubbed here so the ladder is recorded rather than slept.
 */
describe("an answer that doesn't reach the agent", () => {
  const emptyCapture = (): Captured => ({
    slackUpdates: [],
    slackEphemerals: [],
    slackReplies: [],
    resumeMessages: []
  });

  let waits: number[];
  beforeEach(() => {
    waits = [];
    vi.spyOn(scheduler, "wait").mockImplementation(async (ms: number) => {
      waits.push(ms);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function click(action: unknown): Promise<void> {
    const ctx = createExecutionContext();
    await handleSlackInteractivity(await interactivityRequest(action), ctx);
    await waitOnExecutionContext(ctx);
  }

  it("is retried after 2s and 5s, and resumes when a retry gets through", async () => {
    await seedParkedRequest("req-retry");
    const captured = emptyCapture();
    stub(captured, { failResume: 2 });

    await click(buttonAction("req-retry", "approve"));

    expect(waits).toEqual([2_000, 5_000]);
    // One answer, sent three times under one id, so the agent can only take it once.
    expect(captured.resumeMessages).toHaveLength(3);
    expect(new Set(captured.resumeMessages.map((m) => m.messageId)).size).toBe(
      1
    );
    expect((await getHitlForm("req-retry"))?.status).toBe("answered");
    expect((await getAgentTaskByToken("tok-1"))?.status).toBe("pending");
    expect(isAnswered(captured.slackUpdates.at(-1))).toBe(true);
    expect(captured.slackEphemerals).toEqual([]);
  });

  it("re-opens the prompt as it was clicked when every attempt fails", async () => {
    await seedParkedRequest("req-lost");
    const captured = emptyCapture();
    stub(captured, { failResume: 3 });

    await click(buttonAction("req-lost", "approve"));

    expect(captured.resumeMessages).toHaveLength(3);
    const row = await getHitlForm("req-lost");
    expect(row?.status).toBe("awaiting");
    expect(row?.answeredBy).toBeNull();
    expect(row?.answersJson).toBeNull();
    expect((await getAgentTaskByToken("tok-1"))?.status).toBe("awaiting-input");

    // First "sending", with the controls gone; last, the prompt exactly as it was
    // clicked — controls and all — under a note saying the answer didn't arrive.
    const last = captured.slackUpdates.at(-1);
    expect(isAnswered(last)).toBe(false);
    expect(blocksOf(last).slice(0, -1)).toEqual(promptBlocks("req-lost"));
    expect(notesOf(last)).toEqual([
      "⚠️ <@U1>'s answer (*Approve*) didn't reach *remoteagent* — please answer again."
    ]);
    expect(captured.slackReplies).toEqual([]);
    expect(captured.slackEphemerals).toEqual([]);
  });

  it("can be answered again, and a second failure replaces the note rather than adding one", async () => {
    await seedParkedRequest("req-again");
    const captured = emptyCapture();
    stub(captured, { failResume: 6 });

    await click(buttonAction("req-again", "approve"));
    // Slack hands back the prompt as the gatekeeper last left it, note included.
    await click(
      buttonAction(
        "req-again",
        "reject",
        blocksOf(captured.slackUpdates.at(-1))
      )
    );

    expect((await getHitlForm("req-again"))?.status).toBe("awaiting");
    expect(notesOf(captured.slackUpdates.at(-1))).toEqual([
      "⚠️ <@U1>'s answer (*Reject*) didn't reach *remoteagent* — please answer again."
    ]);

    await click(
      buttonAction(
        "req-again",
        "approve",
        blocksOf(captured.slackUpdates.at(-1))
      )
    );

    expect(captured.resumeMessages).toHaveLength(7);
    expect((await getHitlForm("req-again"))?.status).toBe("answered");
    expect((await getAgentTaskByToken("tok-1"))?.status).toBe("pending");
    expect(isAnswered(captured.slackUpdates.at(-1))).toBe(true);
  });

  it("re-opens even while the 'sending' update is still hanging", async () => {
    // A Slack call has no timeout, and a cosmetic one must not stand between a
    // lost answer and the claim being undone.
    await seedParkedRequest("req-hung");
    const captured = emptyCapture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    stub(captured, {
      failResume: 3,
      onUpdate: async (params) => {
        if (params.get("text")?.startsWith("Sending:")) await held;
      }
    });

    const done = click(buttonAction("req-hung", "approve"));
    await vi.waitFor(async () => {
      expect((await getHitlForm("req-hung"))?.status).toBe("awaiting");
    });
    release();
    await done;

    expect(notesOf(captured.slackUpdates.at(-1))).toHaveLength(1);
  });

  it("closes the prompt again if the task ends between re-opening and restoring it", async () => {
    await seedParkedRequest("req-race");
    const captured = emptyCapture();
    stub(captured, {
      failResume: 3,
      onUpdate: async (params) => {
        // A final status closes the task's prompts while the restore is in flight.
        if (params.get("text") === "Proceed?") {
          await cancelHitlFormsByToken("tok-1");
        }
      }
    });

    await click(buttonAction("req-race", "approve"));

    expect((await getHitlForm("req-race"))?.status).toBe("canceled");
    const last = captured.slackUpdates.at(-1);
    expect(last?.get("text")).toBe(TASK_ENDED_NOTE);
    expect(blocksOf(last)).not.toContainEqual(
      expect.objectContaining({ type: "actions" })
    );
  });

  it("hands a typed answer back to its author, since there is no prompt to restore", async () => {
    await seedParkedRequest("req-typed");
    const captured = emptyCapture();
    stub(captured, { failResume: 3 });

    await click(freeformSubmission("req-typed", "ship it on friday"));

    expect(captured.resumeMessages).toHaveLength(3);
    expect((await getHitlForm("req-typed"))?.status).toBe("awaiting");
    // A modal submission carries no blocks, so the prompt was never touched.
    expect(captured.slackUpdates).toEqual([]);
    expect(captured.slackEphemerals).toHaveLength(1);
    expect(captured.slackEphemerals[0].get("user")).toBe("U1");
    expect(captured.slackEphemerals[0].get("text")).toContain(
      "ship it on friday"
    );
  });

  it("stays answered when the task ends while the answer is on its way", async () => {
    await seedParkedRequest("req-ended");
    const captured = emptyCapture();
    stub(captured, { failResume: 3 });
    // The task finishes during the first wait — a 🛑, or the agent giving up.
    vi.mocked(scheduler.wait).mockImplementation(async (ms: number) => {
      waits.push(ms);
      await completeAgentTask("tok-1");
    });

    await click(buttonAction("req-ended", "approve"));

    // Re-opening would put live controls back on a finished task.
    expect((await getHitlForm("req-ended"))?.status).toBe("answered");
    expect(isAnswered(captured.slackUpdates.at(-1))).toBe(true);
    expect(captured.slackEphemerals).toEqual([]);
  });

  it("is not retried when the agent refuses it", async () => {
    await seedParkedRequest("req-refused");
    const captured = emptyCapture();
    stub(captured, { rejectResume: true });

    await click(buttonAction("req-refused", "approve"));

    expect(waits).toEqual([]);
    expect(captured.resumeMessages).toHaveLength(1);
    expect((await getHitlForm("req-refused"))?.status).toBe("answered");
    expect(captured.slackReplies).toHaveLength(1);
  });
});

/**
 * The size bound on a typed answer, enforced where it can still be corrected.
 *
 * The agent runtime refuses message text over `MAX_MESSAGE_TEXT_BYTES`. If the
 * gatekeeper finds that out during the resume — which runs in `ctx.waitUntil`,
 * after the response has gone — the prompt has already been claimed, so the
 * answer is lost and the question can never be answered again. These three cases
 * pin the boundary that keeps it correctable instead: one byte over, exactly at
 * the limit, and the same limit measured in bytes rather than characters.
 */
describe("an over-long freeform answer", () => {
  const emptyCapture = (): Captured => ({
    slackUpdates: [],
    slackEphemerals: [],
    slackReplies: [],
    resumeMessages: []
  });

  it("is refused with the modal left open, and leaves the prompt answerable", async () => {
    await seedParkedRequest("req-long");
    const captured = emptyCapture();
    stub(captured);

    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(
      await interactivityRequest(
        freeformSubmission("req-long", "a".repeat(MAX_MESSAGE_TEXT_BYTES + 1))
      ),
      ctx
    );
    await waitOnExecutionContext(ctx);

    // `response_action: "errors"` is what keeps the modal open with the typed
    // text still in it; the block id is what puts the message under the input.
    expect(await res.json()).toEqual({
      response_action: "errors",
      errors: {
        [otherBlockId(0)]: expect.stringContaining("too long")
      }
    });

    // Nothing was consumed: no resume, no answered-state update, and — the one
    // that matters — the prompt is still open for a shorter answer.
    expect(captured.resumeMessages).toEqual([]);
    expect(captured.slackUpdates).toEqual([]);
    expect((await getHitlForm("req-long"))?.status).toBe("awaiting");
    expect((await getAgentTaskByToken("tok-1"))?.status).toBe("awaiting-input");
  });

  it("goes through at exactly the limit", async () => {
    // The off-by-one that would make the check useful-looking and wrong.
    await seedParkedRequest("req-exact");
    const captured = emptyCapture();
    stub(captured);

    const answer = "a".repeat(MAX_MESSAGE_TEXT_BYTES);
    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(
      await interactivityRequest(freeformSubmission("req-exact", answer)),
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(captured.resumeMessages).toHaveLength(1);
    expect(partsText(captured.resumeMessages[0].parts)).toBe(answer);
    expect((await getHitlForm("req-exact"))?.status).toBe("answered");
  });

  it("measures bytes, not characters", async () => {
    // The distinction the contract is explicit about. This answer is well under
    // the limit in characters and one byte over it in UTF-8, so a length check
    // would let it through to be refused by the agent, too late to fix.
    await seedParkedRequest("req-utf8");
    const captured = emptyCapture();
    stub(captured);

    const multibyte = "é".repeat(MAX_MESSAGE_TEXT_BYTES / 2) + "a";
    expect(multibyte.length).toBeLessThan(MAX_MESSAGE_TEXT_BYTES);

    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(
      await interactivityRequest(freeformSubmission("req-utf8", multibyte)),
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { response_action?: string }).response_action
    ).toBe("errors");
    expect((await getHitlForm("req-utf8"))?.status).toBe("awaiting");
  });
});

/**
 * The prompt once answered. It re-shows the question with the answer under it,
 * so a long question and a long answer together must still fit one message —
 * and the agent is sent the answer whole, however much of it Slack shows.
 */
describe("the answered state", () => {
  const emptyCapture = (): Captured => ({
    slackUpdates: [],
    slackEphemerals: [],
    slackReplies: [],
    resumeMessages: []
  });

  async function submit(action: unknown): Promise<void> {
    const ctx = createExecutionContext();
    await handleSlackInteractivity(await interactivityRequest(action), ctx);
    await waitOnExecutionContext(ctx);
  }

  const longQuestion = Array.from(
    { length: 40 },
    (_, i) => `Paragraph ${i + 1}: ${"some context. ".repeat(8)}`
  ).join("\n\n");

  it("shows a long typed answer under a long question, cut to fit", async () => {
    await seedParkedRequest("req-essay", longQuestion);
    const captured = emptyCapture();
    stub(captured);

    const answer = "I never merge work in progress. ".repeat(400);
    await submit(freeformSubmission("req-essay", answer));

    expect(partsText(captured.resumeMessages[0].parts)).toBe(answer.trim());
    expect(captured.slackUpdates).toHaveLength(1);
    const update = captured.slackUpdates[0];
    expect(isAnswered(update)).toBe(true);
    expect(update.get("text")?.length).toBeLessThanOrEqual(3_000);
    const text = blocksText(blocksOf(update));
    expect(text).toContain("Paragraph 40:");
    expect(text).toContain("the agent has the full answer");
  });

  it("falls back to an 'answered by' line when Slack refuses the answered state, logging why", async () => {
    await seedParkedRequest("req-refused-blocks");
    const captured = emptyCapture();
    const why =
      "[ERROR] failed to match all allowed schemas [json-pointer:/blocks/1]";
    let refused = false;
    stub(captured, {
      refuseUpdate: () => (refused ? undefined : ((refused = true), [why]))
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await submit(freeformSubmission("req-refused-blocks", "ship it"));

    expect(captured.slackUpdates).toHaveLength(2);
    const fallback = blocksOf(captured.slackUpdates[1]);
    expect(fallback).not.toContainEqual(
      expect.objectContaining({ type: "actions" })
    );
    expect(blocksText(fallback)).toContain("Answered by <@U1>");
    expect(errors).toHaveBeenCalledWith(
      "[hitl] failed to update answered prompt",
      expect.objectContaining({
        err: "Slack chat.update failed: invalid_blocks",
        slack: [why]
      })
    );
    errors.mockRestore();
  });
});

/**
 * A form of several questions: answered in a modal opened from the prompt's
 * one button, and sent as one answer per question.
 */
describe("a form of several questions", () => {
  const form: HitlRequestData = {
    type: HITL_REQUEST_TYPE,
    requestId: "req-form",
    questions: [
      {
        kind: "choice",
        id: "db",
        prompt: "Which database?",
        header: "Database",
        options: [
          { id: "pg", label: "Postgres" },
          { id: "lite", label: "SQLite" }
        ]
      },
      { kind: "text", id: "name", prompt: "Name it?" }
    ]
  };

  const emptyCapture = (): Captured => ({
    slackUpdates: [],
    slackEphemerals: [],
    slackReplies: [],
    resumeMessages: [],
    views: []
  });

  async function send(payload: unknown): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(
      await interactivityRequest(payload),
      ctx
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  function submission(values: Record<string, Record<string, unknown>>) {
    return {
      type: "view_submission",
      user: { id: "U1" },
      view: {
        callback_id: FORM_CALLBACK_ID,
        private_metadata: JSON.stringify({ r: "req-form", p: 0 }),
        state: { values }
      }
    };
  }

  it("opens the form from the prompt's Answer button", async () => {
    await seedParkedRequest("req-form", "", form);
    const captured = emptyCapture();
    stub(captured);
    const [answer] = (
      requestBlocks(form).find(
        (b) => (b as { type?: string }).type === "actions"
      ) as { elements: { action_id: string; value: string }[] }
    ).elements;

    await send({
      type: "block_actions",
      user: { id: "U1" },
      trigger_id: "trig-1",
      channel: { id: "C1" },
      message: { ts: "1700.9", blocks: requestBlocks(form) },
      actions: [{ ...answer, type: "button" }]
    });

    expect(captured.views).toHaveLength(1);
    expect(captured.views![0]).toMatchObject({
      callback_id: FORM_CALLBACK_ID,
      private_metadata: JSON.stringify({ r: "req-form", p: 0 })
    });
  });

  it("sends one answer per question, keyed by its id", async () => {
    await seedParkedRequest("req-form", "", form);
    const captured = emptyCapture();
    stub(captured);

    const res = await send(
      submission({
        "q0:choice": {
          value: { type: "radio_buttons", selected_option: { value: "0" } }
        },
        "q0:other": { value: { type: "plain_text_input", value: null } },
        "q1:text": { value: { type: "plain_text_input", value: "forms" } }
      })
    );

    expect(res.status).toBe(200);
    const resume = captured.resumeMessages[0]!;
    expect(resume.parts.map(dataOf).find((d) => d !== undefined)).toMatchObject(
      {
        requestId: "req-form",
        answers: { db: { optionIds: ["pg"] }, name: { text: "forms" } }
      }
    );
    expect(partsText(resume.parts)).toBe(
      "Database\nPostgres\n\nName it?\nforms"
    );
    expect((await getHitlForm("req-form"))?.status).toBe("answered");
  });

  it("keeps the modal open on a question left unanswered, claiming nothing", async () => {
    await seedParkedRequest("req-form", "", form);
    const captured = emptyCapture();
    stub(captured);

    const res = await send(
      submission({
        "q0:choice": {
          value: { type: "radio_buttons", selected_option: null }
        },
        "q0:other": { value: { type: "plain_text_input", value: "  " } },
        "q1:text": { value: { type: "plain_text_input", value: "forms" } }
      })
    );

    expect(await res.json()).toEqual({
      response_action: "errors",
      errors: { "q0:choice": expect.stringContaining("Pick one") }
    });
    expect(captured.resumeMessages).toEqual([]);
    expect((await getHitlForm("req-form"))?.status).toBe("awaiting");
  });
});

/**
 * A form past what one modal holds, answered page by page: each page is checked
 * and kept as the person goes, Back keeps what a page holds, and the last page
 * sends every answer at once — the one form the agent asked.
 */
describe("a form too long for one modal", () => {
  const form: HitlRequestData = {
    type: HITL_REQUEST_TYPE,
    requestId: "req-paged",
    questions: Array.from({ length: 40 }, (_, i) => ({
      kind: "choice" as const,
      id: `c${i}`,
      prompt: `Question ${i}?`,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" }
      ]
    }))
  };
  const pages = formPages(form);

  const emptyCapture = (): Captured => ({
    slackUpdates: [],
    slackEphemerals: [],
    slackReplies: [],
    resumeMessages: [],
    views: [],
    viewUpdates: []
  });

  async function send(payload: unknown): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(
      await interactivityRequest(payload),
      ctx
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  /** Each question at `positions` picked `pick`, as a modal's state holds it. */
  function picked(positions: readonly number[], pick: string | null = "0") {
    return Object.fromEntries(
      positions.flatMap((i) => [
        [
          `q${i}:choice`,
          {
            value: {
              type: "radio_buttons",
              selected_option: pick === null ? null : { value: pick }
            }
          }
        ],
        [`q${i}:other`, { value: { type: "plain_text_input", value: null } }]
      ])
    );
  }

  function submitPage(
    page: number,
    values: Record<string, unknown>,
    user = "U1"
  ) {
    return {
      type: "view_submission",
      user: { id: user },
      view: {
        id: "V1",
        callback_id: FORM_CALLBACK_ID,
        private_metadata: JSON.stringify({ r: "req-paged", p: page }),
        state: { values }
      }
    };
  }

  function openForm(user = "U1") {
    return {
      type: "block_actions",
      user: { id: user },
      trigger_id: "trig-1",
      channel: { id: "C1" },
      message: { ts: "1700.9", blocks: requestBlocks(form) },
      actions: [
        {
          action_id: OPEN_ACTION,
          value: JSON.stringify({ r: "req-paged" }),
          type: "button"
        }
      ]
    };
  }

  function back(from: number, values: Record<string, unknown>) {
    return {
      type: "block_actions",
      user: { id: "U1" },
      trigger_id: "trig-2",
      container: { type: "view", view_id: "V1" },
      view: {
        id: "V1",
        hash: "h-1",
        callback_id: FORM_CALLBACK_ID,
        private_metadata: JSON.stringify({ r: "req-paged", p: from }),
        state: { values }
      },
      actions: [
        {
          action_id: BACK_ACTION,
          value: JSON.stringify({ r: "req-paged", p: from - 1 }),
          type: "button"
        }
      ]
    };
  }

  /** What each input of a view holds, by block id. */
  function held(view: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      (view.blocks as Record<string, unknown>[])
        .filter((b) => b.type === "input")
        .map((b) => {
          const e = b.element as Record<string, unknown>;
          const one = e.initial_option as { value: string } | undefined;
          return [b.block_id, e.initial_value ?? one?.value];
        })
    );
  }

  it("is paged, Next keeping each page, and the last sending every answer at once", async () => {
    await seedParkedRequest("req-paged", "", form);
    const captured = emptyCapture();
    stub(captured);
    expect(pages.length).toBeGreaterThan(1);

    await send(openForm());
    expect(captured.views![0]).toMatchObject({
      title: { text: `Your answer · 1 of ${pages.length}` }
    });

    for (let p = 0; p < pages.length - 1; p++) {
      const res = await send(submitPage(p, picked(pages[p]!)));
      const body = (await res.json()) as {
        response_action: string;
        view: Record<string, unknown>;
      };
      expect(body.response_action).toBe("update");
      expect(body.view).toMatchObject({
        private_metadata: JSON.stringify({ r: "req-paged", p: p + 1 })
      });
      expect(captured.resumeMessages).toEqual([]);
    }

    const last = pages.length - 1;
    const res = await send(submitPage(last, picked(pages[last]!, "1")));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    const data = captured.resumeMessages[0]!.parts.map(dataOf).find(
      (d) => d !== undefined
    ) as { answers: Record<string, unknown> };
    expect(Object.keys(data.answers)).toEqual(form.questions.map((q) => q.id));
    expect(data.answers.c0).toEqual({ optionIds: ["a"] });
    expect(data.answers[`c${pages[last]![0]}`]).toEqual({ optionIds: ["b"] });
    expect((await getHitlForm("req-paged"))?.status).toBe("answered");
  });

  it("goes Back keeping what the page held, and shows each page again as answered", async () => {
    await seedParkedRequest("req-paged", "", form);
    const captured = emptyCapture();
    stub(captured);

    await send(submitPage(0, picked(pages[0]!, "1")));
    // Page 1 half done: its first question picked, the rest not yet.
    const [first, ...rest] = pages[1]!;
    await send(back(1, { ...picked([first!], "1"), ...picked(rest, null) }));

    expect(captured.viewUpdates).toHaveLength(1);
    const update = captured.viewUpdates![0]!;
    expect(update).toMatchObject({ viewId: "V1", hash: "h-1" });
    expect(held(update.view)[`q${pages[0]![0]}:choice`]).toBe("1");

    // Next again: page 1 comes back holding the pick made before Back.
    const res = await send(submitPage(0, picked(pages[0]!, "1")));
    const { view } = (await res.json()) as { view: Record<string, unknown> };
    expect(held(view)[`q${first}:choice`]).toBe("1");
    expect(held(view)[`q${rest[0]}:choice`]).toBeUndefined();
  });

  it("reopens where the person left it, and keeps each person's answers apart", async () => {
    await seedParkedRequest("req-paged", "", form);
    const captured = emptyCapture();
    stub(captured);

    await send(submitPage(0, picked(pages[0]!)));
    await send(openForm("U1"));
    await send(openForm("U2"));

    expect(
      captured.views!.map((v) => JSON.parse(v.private_metadata as string))
    ).toEqual([
      { r: "req-paged", p: 1 },
      { r: "req-paged", p: 0 }
    ]);
    expect(
      held(captured.views![1]!)[`q${pages[0]![0]}:choice`]
    ).toBeUndefined();
  });

  it("keeps a page open on a question left unanswered, and moves on from nothing", async () => {
    await seedParkedRequest("req-paged", "", form);
    const captured = emptyCapture();
    stub(captured);

    const [first, ...rest] = pages[0]!;
    const res = await send(
      submitPage(0, { ...picked([first!], null), ...picked(rest) })
    );
    expect(await res.json()).toEqual({
      response_action: "errors",
      errors: { [`q${first}:choice`]: expect.stringContaining("Pick one") }
    });
    expect((await getHitlForm("req-paged"))?.draftsJson).toBeNull();
  });

  it("closes a page submitted after someone else answered, and says so", async () => {
    await seedParkedRequest("req-paged", "", form);
    const captured = emptyCapture();
    stub(captured);
    await cancelHitlFormsByToken("tok-1");

    const res = await send(submitPage(0, picked(pages[0]!)));
    expect(await res.text()).toBe("");
    expect(captured.slackEphemerals).toHaveLength(1);
    expect(captured.resumeMessages).toEqual([]);
  });
});
