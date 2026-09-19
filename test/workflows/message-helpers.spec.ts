import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { setWorkspaceAdminChannel } from "@/db/models/workspaces";
import { STOP_REACTION } from "@/workflows/reaction";
import {
  dispatchMessage,
  feedText,
  replyThreadTs,
  collectIfEventDrained,
  type AgentPlan
} from "@/workflows/message-helpers";
import { registerAgent } from "@/db/models/agents";
import { createAgentTask, completeAgentTask } from "@/db/models/agent-tasks";
import type { MessageWorkflowParams } from "@/slack/types";
import { stubSlack } from "../wrappers/slack-stub";
import { stubAgentAi } from "../helpers/agents";
import {
  trigger,
  makeAppMentionRequest,
  type PostCall,
  type ReactionCall
} from "../helpers/slack-events";
import { useStorageReset } from "../helpers/storage";

useStorageReset();

// Tests covering the shared helpers in message-helpers.ts:
//   replyThreadTs   — direct unit tests (pure fn)
//   feedText        — direct unit tests (pure fn)
//   dispatchMessage — InvalidEndpointError → error_reply path (no-domains-approved case)
//   resolveMessage  — exercised via the no-targets short-circuit
//   signalReactionCollect — exercised via the reaction-removal integration
//   handleUnreachable — covered indirectly via message.spec

beforeEach(async () => {
  // A mention in the admin channel wakes the real admin agent; stub its model so
  // the turn finishes offline instead of rejecting on the DO's detached promise.
  stubAgentAi();
  await setWorkspaceAdminChannel(0, "C_ORGADMIN");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function captureSlackWithReactions(): {
  post: PostCall[];
  reactions: ReactionCall[];
} {
  const post: PostCall[] = [];
  const reactions: ReactionCall[] = [];
  stubSlack((method, body) => {
    if (method === "chat.postMessage") {
      post.push({
        channel: body.get("channel") ?? "",
        thread_ts: body.get("thread_ts") ?? undefined,
        text: body.get("text") ?? ""
      });
    } else if (method === "reactions.add" || method === "reactions.remove") {
      reactions.push({
        method,
        channel: body.get("channel") ?? "",
        timestamp: body.get("timestamp") ?? "",
        name: body.get("name") ?? ""
      });
    }
    return { ok: true, ts: "1700.2" };
  });
  return { post, reactions };
}

// Minimal MessageWorkflowParams fixture for pure-function tests.
function makeParams(
  overrides: Partial<MessageWorkflowParams> = {}
): MessageWorkflowParams {
  return {
    eventId: "Ev-helpers-0",
    eventType: "app_mention",
    channelId: "C1",
    threadTs: "1700.1",
    ts: "1700.1",
    userId: "U1",
    text: "hello world",
    raw: {},
    targets: [],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// replyThreadTs
// ---------------------------------------------------------------------------

describe("replyThreadTs", () => {
  it("returns null when threadTs equals ts (not inside a real thread)", () => {
    expect(
      replyThreadTs(makeParams({ ts: "1700.1", threadTs: "1700.1" }))
    ).toBeNull();
  });

  it("returns null when threadTs is falsy (top-level channel message)", () => {
    expect(
      replyThreadTs(makeParams({ ts: "1700.1", threadTs: "" }))
    ).toBeNull();
  });

  it("returns threadTs when it differs from ts (genuine thread reply)", () => {
    expect(
      replyThreadTs(makeParams({ ts: "1700.5", threadTs: "1699.0" }))
    ).toBe("1699.0");
  });
});

// ---------------------------------------------------------------------------
// feedText
// ---------------------------------------------------------------------------

describe("feedText", () => {
  it("returns the message text verbatim for a plain message", () => {
    expect(feedText(makeParams({ text: "plain message" }))).toBe(
      "plain message"
    );
  });

  it("renders an edit feed turn as a wdiff of the changed words", () => {
    const result = feedText(
      makeParams({
        editKind: "edited",
        ts: "1700.1",
        text: "the new text here",
        prevText: "the old text here"
      })
    );
    expect(result).toContain("edited");
    // Only the changed word is marked; unchanged surrounding words stay as context.
    expect(result).toContain("[-old-]");
    expect(result).toContain("[+new+]");
    expect(result).not.toContain("before:");
  });

  it("sends only the diff + context, not the whole body, for a long edit", () => {
    const shared = "x".repeat(400);
    const result = feedText(
      makeParams({
        editKind: "edited",
        ts: "1700.1",
        text: `${shared} alpha ${shared}`,
        prevText: `${shared} omega ${shared}`
      })
    );
    expect(result).toContain("[-omega-]");
    expect(result).toContain("[+alpha+]");
    // The full 400-char blocks must not be resent — context is truncated with an ellipsis.
    expect(result).not.toContain(shared);
    expect(result).toContain("…");
  });

  it("renders a delete feed turn with the prior text as transcript", () => {
    const result = feedText(
      makeParams({
        editKind: "deleted",
        ts: "1700.1",
        prevText: "deleted content"
      })
    );
    expect(result).toContain("deleted");
    expect(result).toContain("deleted content");
  });
});

// ---------------------------------------------------------------------------
// dispatchMessage — InvalidEndpointError → error_reply
// ---------------------------------------------------------------------------

describe("dispatchMessage", () => {
  it("returns error_reply when the endpoint domain is not in the approved list", async () => {
    // No setAllowedRemoteAgentDomains call → DB has no approved domains →
    // validateRemoteEndpoint throws InvalidEndpointError → dispatchMessage catches
    // it and converts to error_reply (does NOT retry, since this is a policy verdict).
    const plan: AgentPlan = {
      agent: {
        name: "blocked-agent",
        kind: "remote",
        a2aEndpoint: "https://notapproved.example.com/a2a",
        tenantId: "main",
        workspaceId: 1
      },
      workspaceId: 1,
      text: "hello",
      channelName: null,
      user: {
        slackUserId: "U1",
        displayName: null,
        isPrimaryOwner: false,
        isOrgAdmin: false,
        adminWorkspaces: []
      }
    };
    const result = await dispatchMessage(makeParams(), plan);
    expect(result).toMatchObject({
      kind: "error_reply",
      text: expect.stringContaining("security policy")
    });
    expect((result as { kind: "error_reply"; text: string }).text).toContain(
      "blocked-agent"
    );
  });
});

// ---------------------------------------------------------------------------
// resolveMessage — empty-targets path
// ---------------------------------------------------------------------------

describe("resolveMessage (via webhook handler)", () => {
  it("no-match channel: no agent woken, no workflow created, nothing posted", async () => {
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body } = makeAppMentionRequest(
        "C_UNCONFIGURED",
        "<@UBOT> anyone?"
      );
      const res = await trigger(body);
      expect(res.status).toBe(200);

      // resolveMessage returns an empty target list → handler skips the
      // workflow and the reaction entirely; no reaction flicker.
      expect(await introspector.get()).toHaveLength(0);
    } finally {
      await introspector.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// signalReactionCollect — 🛑 removal
// ---------------------------------------------------------------------------

describe("signalReactionCollect (via MessageWorkflow)", () => {
  it("sends reply_posted to ReactionWorkflow once the local reply is done, removing 🛑", async () => {
    const { reactions } = captureSlackWithReactions();
    const msgIntrospector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    const reactionIntrospector = await introspectWorkflow(
      env.REACTION_WORKFLOW
    );
    try {
      const { body } = makeAppMentionRequest("C_ORGADMIN", "<@UBOT> hello");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [reaction] = await reactionIntrospector.get();
      expect(reaction).toBeDefined();

      const [msg] = await msgIntrospector.get();
      await msg.waitForStatus("complete");
      await reaction.waitForStatus("complete");

      expect(reactions.map((r) => r.method)).toEqual([
        "reactions.add",
        "reactions.remove"
      ]);
      expect(reactions[0]).toMatchObject({
        channel: "C_ORGADMIN",
        timestamp: "1700.1",
        name: STOP_REACTION
      });
    } finally {
      await reactionIntrospector.dispose();
      await msgIntrospector.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// collectIfEventDrained — the 🛑 clears only when the last fan-out task is done
// ---------------------------------------------------------------------------

describe("collectIfEventDrained (fan-out drain)", () => {
  beforeEach(async () => {
    await registerAgent({
      name: "wf-agent",
      kind: "remote",
      a2aEndpoint: "https://a.example.com/a2a",
      tenantId: "main",
      notifyOn: "channel_messages",
      workspaceId: 0
    });
  });

  const seed = (token: string) =>
    createAgentTask({
      token,
      taskId: "task-1",
      agentName: "wf-agent",
      channelId: "C1",
      messageTs: "1700.1",
      replyThreadTs: null,
      eventId: "EvDrain"
    });

  it("signals collect only once the last pending task of the event is done", async () => {
    const sendEvent = vi.fn(async () => {});
    vi.spyOn(env.REACTION_WORKFLOW, "get").mockResolvedValue({
      sendEvent
    } as unknown as WorkflowInstance);

    await seed("d1");
    await seed("d2");

    // Two agents of one trigger still working → the 🛑 must stay.
    await collectIfEventDrained("EvDrain");
    expect(sendEvent).not.toHaveBeenCalled();

    // First agent finishes — one still pending, so still no collect.
    await completeAgentTask("d1");
    await collectIfEventDrained("EvDrain");
    expect(sendEvent).not.toHaveBeenCalled();

    // Last agent finishes — the fan-out is drained, so now we collect.
    await completeAgentTask("d2");
    await collectIfEventDrained("EvDrain");
    expect(sendEvent).toHaveBeenCalledTimes(1);
  });
});
