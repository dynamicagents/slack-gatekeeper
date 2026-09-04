import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { setWorkspaceAdminChannel } from "@/db/models/workspaces";
import {
  getAgentTaskByToken,
  getPendingAgentTasksByEventId
} from "@/db/models/agent-tasks";
import { AGENT_UNREACHABLE_BASE_TEXT } from "@/workflows/message-helpers";
import { STOP_REACTION } from "@/workflows/reaction";
import { buildDispatchId, _resetIssuerCacheForTest } from "@/agents/dispatch";
import {
  setAllowedRemoteAgentDomains,
  setPublicUrl
} from "@/db/models/workspace-configs";
import { buildAgentCard } from "@/a2a/card";
import { AgentCard, SendMessageResponse, TaskState } from "@a2a-js/sdk";
import { agentMessage, makeTask } from "../helpers/a2a";
import { stubSlack } from "../wrappers/slack-stub";
import { stubAgentAi } from "../helpers/agents";
import {
  trigger,
  makeAppMentionRequest,
  type PostCall,
  type ReactionCall
} from "../helpers/slack-events";

// The single MessageWorkflow handles every woken agent for an event, dispatching
// each by `agent.kind`. These suites exercise its two dispatch paths — local
// built-in (admin / onboarding, in-process DO) and remote custom (HTTP + async
// push callback) — against the one workflow binding.

// ---------------------------------------------------------------------------
// Local built-in agents (admin / onboarding)
// ---------------------------------------------------------------------------

describe("MessageWorkflow — local built-in agents", () => {
  const ADMIN_AGENT_NAME = "admin";
  const AGENT_REPLY = "stubbed agent reply";

  beforeEach(async () => {
    // These agents run the real AI loop; stub the model so the turn completes
    // offline instead of rejecting on the DO's detached delivery promise.
    stubAgentAi(AGENT_REPLY);
    await setWorkspaceAdminChannel(0, "C_ORGADMIN");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function captureSlack(): PostCall[] {
    const calls: PostCall[] = [];
    stubSlack((method, body) => {
      if (method === "chat.postMessage") {
        calls.push({
          channel: body.get("channel") ?? "",
          thread_ts: body.get("thread_ts") ?? undefined,
          text: body.get("text") ?? ""
        });
      }
      return { ok: true, ts: "1700.2" };
    });
    return calls;
  }

  /**
   * A built-in agent's reply is delivered by the DO's push sender on
   * `ctx.waitUntil`, not by the workflow — so the workflow reaching `complete`
   * says nothing about the reply having landed. Poll for it (same reason the
   * delivery-failure test below polls its task row).
   */
  async function waitForCalls(calls: PostCall[], n: number): Promise<void> {
    for (let i = 0; i < 50 && calls.length < n; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  let seq = 0;
  function makeDmRequest(channelId: string, text: string) {
    const eventId = `Ev-local-dm-${++seq}`;
    const body = JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      team_id: "T1",
      event: {
        type: "message",
        channel_type: "im",
        channel: channelId,
        user: "U1",
        text,
        ts: "1700.1",
        event_ts: "1700.1"
      }
    });
    return { body, eventId };
  }

  it("admin-channel mention: resolve → dispatch → reply steps complete, channel-level reply posted", async () => {
    const calls = captureSlack();
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body } = makeAppMentionRequest("C_ORGADMIN", "<@UBOT> hello");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // The admin agent runs the real AI loop (Workers AI) over a stubbed model,
      // so this asserts the whole plumbing end to end: Workflow → A2A →
      // AdminAgent DO (Session over SQLite) → channel-level reply carrying the
      // model's text.
      await waitForCalls(calls, 1);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        channel: "C_ORGADMIN",
        text: AGENT_REPLY
      });
      expect(calls[0].thread_ts).toBeUndefined();
    } finally {
      await introspector.dispose();
    }
  });

  it("DM: resolve → dispatch → reply steps complete, channel-level reply posted", async () => {
    const calls = captureSlack();
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body } = makeDmRequest("D1", "hey there");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // The onboarding concierge runs the real AI loop (Workers AI) over a
      // stubbed model, keyed to a per-user DO instance: Workflow → A2A →
      // OnboardingAgent DO (Session over SQLite) → channel-level reply (no
      // thread) carrying the model's text.
      await waitForCalls(calls, 1);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ channel: "D1", text: AGENT_REPLY });
      expect(calls[0].thread_ts).toBeUndefined();
    } finally {
      await introspector.dispose();
    }
  });

  it("posts an unreachable notice when a dispatch's retries are exhausted", async () => {
    const calls = captureSlack();
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      // Force the admin dispatch to fail on every attempt (a persistent failure,
      // e.g. connection refused), with retry backoff disabled so we don't wait.
      await introspector.modifyAll(async (m) => {
        await m.disableRetryDelays([{ name: "dispatch:admin" }]);
        await m.mockStepError(
          { name: `dispatch:${ADMIN_AGENT_NAME}` },
          new Error("connection refused")
        );
      });

      const { body } = makeAppMentionRequest("C_ORGADMIN", "<@UBOT> hello");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // Instead of silently clearing the 🛑, the user is told the agent couldn't
      // be reached — posted under the agent's identity in the same channel.
      expect(calls).toHaveLength(1);
      expect(calls[0].channel).toBe("C_ORGADMIN");
      expect(calls[0].text).toContain(AGENT_UNREACHABLE_BASE_TEXT);
      expect(calls[0].text).toContain(ADMIN_AGENT_NAME);
    } finally {
      await introspector.dispose();
    }
  });

  it("a local task delivery failure is NOT reported as unreachable", async () => {
    const calls: PostCall[] = [];
    stubSlack((method, body) => {
      if (method === "chat.postMessage") {
        calls.push({
          channel: body.get("channel") ?? "",
          thread_ts: body.get("thread_ts") ?? undefined,
          text: body.get("text") ?? ""
        });
        return { ok: false, error: "service_unavailable" };
      }
      return { ok: true, ts: "1700.2" };
    });
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body, eventId } = makeAppMentionRequest(
        "C_ORGADMIN",
        "<@UBOT> hello"
      );
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // Delivery is fire-and-forget from the agent DO (the SDK does not await the
      // push sender) and retries a transient failure with backoff, so poll for
      // the recorded error rather than assuming it lands within the workflow's life.
      let pending;
      for (let i = 0; i < 50; i++) {
        [pending] = await getPendingAgentTasksByEventId(eventId);
        if (pending?.lastError) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // The sender captures the error on its durable pending task; it is not a
      // dispatch failure, so the workflow must not mislabel the agent unreachable.
      expect(calls.map((c) => c.text)).not.toContain(
        AGENT_UNREACHABLE_BASE_TEXT
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(pending?.lastError).toBe(
        "the local agent's reply could not be delivered"
      );
    } finally {
      await introspector.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Remote custom agents (HTTP + async push callback)
// ---------------------------------------------------------------------------

describe("MessageWorkflow — remote custom agents", () => {
  const REMOTE_ENDPOINT = "https://remote.example.com/a2a";
  /** Which agent at that endpoint — sent on every dispatch, and in the token. */
  const REMOTE_TENANT = "main";
  const REMOTE_CHANNEL = "C_REMOTE";
  const AGENT_NAME = "remote-test";

  type RemoteMode = "accepted" | "contract_violation" | "protocol_error";

  /**
   * Stub global fetch to route Slack API calls and remote agent calls separately.
   * The remote endpoint returns either an accepted Task ack or a contract-violating
   * Message (which `dispatchToAgent` normalises to `error_reply`).
   */
  function stubFetch({
    remoteMode = "accepted" as RemoteMode,
    slackPosts,
    slackReactions,
    remotePosts
  }: {
    remoteMode?: RemoteMode;
    slackPosts?: PostCall[];
    slackReactions?: ReactionCall[];
    /** Counts dispatch POSTs so a test can assert the step did not retry. */
    remotePosts?: { count: number };
  } = {}) {
    const card = buildAgentCard({
      name: "Remote Test",
      description: "test remote agent",
      url: REMOTE_ENDPOINT
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const url = request.url;

        // Route Slack API calls (chat.postMessage, reactions.add / .remove, etc.)
        if (url.includes("slack.com")) {
          const method = new URL(url).pathname.split("/").pop() ?? "";
          const raw = typeof init?.body === "string" ? init.body : "";
          const params = new URLSearchParams(raw);
          if (method === "chat.postMessage" && slackPosts) {
            slackPosts.push({
              channel: params.get("channel") ?? "",
              text: params.get("text") ?? "",
              thread_ts: params.get("thread_ts") ?? undefined
            });
          }
          if (
            (method === "reactions.add" || method === "reactions.remove") &&
            slackReactions
          ) {
            slackReactions.push({
              method,
              channel: params.get("channel") ?? "",
              timestamp: params.get("timestamp") ?? "",
              name: params.get("name") ?? ""
            });
          }
          return new Response(JSON.stringify({ ok: true, ts: "1700.5" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        // Remote agent card discovery (GET) — served as protobuf-JSON.
        if (request.method === "GET")
          return Response.json(AgentCard.toJSON(card));

        // Remote agent dispatch (POST).
        const rpc = (await request.clone().json()) as { id?: unknown };
        if (remotePosts) remotePosts.count += 1;

        if (remoteMode === "protocol_error") {
          // A deterministic A2A refusal: the agent understood the request and
          // said no (here: it doesn't speak v1.0).
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            error: { code: -32009, message: "unsupported version" }
          });
        }

        if (remoteMode === "accepted") {
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: SendMessageResponse.toJSON({
              payload: {
                $case: "task",
                value: makeTask({
                  id: "task-remote-1",
                  contextId: "ctx",
                  state: TaskState.TASK_STATE_SUBMITTED
                })
              }
            })
          });
        }

        // contract_violation: returns a Message instead of a Task.
        // dispatchToAgent normalises this to { kind: "error_reply" }.
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: SendMessageResponse.toJSON({
            payload: {
              $case: "message",
              value: agentMessage("unexpected sync reply", {
                messageId: "m1",
                contextId: "ctx"
              })
            }
          })
        });
      })
    );
  }

  let seq = 0;
  function makeChannelMessageRequest(channelId: string) {
    const eventId = `Ev-remote-${++seq}`;
    const body = JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      team_id: "T1",
      event: {
        type: "message",
        channel_type: "channel",
        channel: channelId,
        user: "U1",
        text: "hello remote",
        ts: "1700.1",
        event_ts: "1700.1"
      }
    });
    return { body, eventId };
  }

  // Compute the deterministic push token the workflow uses for this event + agent.
  async function tokenFor(eventId: string): Promise<string> {
    return buildDispatchId(eventId, {
      name: AGENT_NAME,
      kind: "remote",
      workspaceId: 0
    });
  }

  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO agents
         (name, kind, enabled, notify_on, a2a_endpoint, tenant_id, workspace_id)
       VALUES ('${AGENT_NAME}', 'remote', 1, 'channel_messages', '${REMOTE_ENDPOINT}', '${REMOTE_TENANT}', 0)`
    ).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO agent_channels (channel_id, agent_name, workspace_id)
       VALUES ('${REMOTE_CHANNEL}', '${AGENT_NAME}', 0)`
    ).run();
    await setPublicUrl("https://gatekeeper.test");
    await setAllowedRemoteAgentDomains(["remote.example.com"]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    _resetIssuerCacheForTest();
    await setAllowedRemoteAgentDomains([]);
  });

  it("record-task pre-writes the correlation row; update-task backfills the remote taskId on accepted", async () => {
    stubFetch({ remoteMode: "accepted" });
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body, eventId } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // record-task wrote the row before dispatch, update-task backfilled taskId.
      const row = await getAgentTaskByToken(await tokenFor(eventId));
      expect(row).not.toBeNull();
      expect(row?.taskId).toBe("task-remote-1");
      expect(row?.agentName).toBe(AGENT_NAME);
    } finally {
      await introspector.dispose();
    }
  });

  it("task row deleted when dispatch ends in error_reply (remote contract violation)", async () => {
    const slackPosts: PostCall[] = [];
    stubFetch({ remoteMode: "contract_violation", slackPosts });
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body, eventId } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // No push callback will arrive — the row must be cleaned up.
      expect(await getAgentTaskByToken(await tokenFor(eventId))).toBeNull();
      // The error_reply text is posted to Slack so the user isn't left in silence.
      expect(slackPosts).toHaveLength(1);
      expect(slackPosts[0].text).toContain("required task acknowledgment");
    } finally {
      await introspector.dispose();
    }
  });

  it("task row deleted and a specific notice posted on an A2A protocol refusal, without retrying", async () => {
    // The whole point of classifying protocol errors: a deterministic refusal
    // must reach the user as itself, on the first attempt, rather than being
    // retried until it degrades into the generic "unreachable" notice.
    const slackPosts: PostCall[] = [];
    const remotePosts = { count: 0 };
    stubFetch({ remoteMode: "protocol_error", slackPosts, remotePosts });
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body, eventId } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // No push callback will arrive — the row must be cleaned up.
      expect(await getAgentTaskByToken(await tokenFor(eventId))).toBeNull();
      expect(slackPosts).toHaveLength(1);
      expect(slackPosts[0].text).toContain("A2A v1.0");
      expect(slackPosts[0].text).toContain(AGENT_NAME);
      expect(slackPosts[0].text).not.toContain(AGENT_UNREACHABLE_BASE_TEXT);
      // Dispatched exactly once: the step returned a result, so it never retried.
      expect(remotePosts.count).toBe(1);
    } finally {
      await introspector.dispose();
    }
  });

  it("task row deleted and unreachable notice posted when dispatch retries exhausted", async () => {
    const slackPosts: PostCall[] = [];
    stubFetch({ slackPosts });
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      await introspector.modifyAll(async (m) => {
        await m.disableRetryDelays([{ name: `dispatch:${AGENT_NAME}` }]);
        await m.mockStepError(
          { name: `dispatch:${AGENT_NAME}` },
          new Error("connection refused")
        );
      });

      const { body, eventId } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // No push callback will arrive — row must be gone.
      expect(await getAgentTaskByToken(await tokenFor(eventId))).toBeNull();
      // User gets an explicit notice instead of silence.
      expect(slackPosts).toHaveLength(1);
      expect(slackPosts[0].channel).toBe(REMOTE_CHANNEL);
      expect(slackPosts[0].text).toContain(AGENT_UNREACHABLE_BASE_TEXT);
      expect(slackPosts[0].text).toContain(AGENT_NAME);
      expect(slackPosts[0].text).toContain("connection refused");
    } finally {
      await introspector.dispose();
    }
  });

  it("collect-reaction fires when all dispatches end in non-accepted (error_reply)", async () => {
    const slackReactions: ReactionCall[] = [];
    stubFetch({ remoteMode: "contract_violation", slackReactions });
    const msgIntrospector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    const reactionIntrospector = await introspectWorkflow(
      env.REACTION_WORKFLOW
    );
    try {
      const { body } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [msg] = await msgIntrospector.get();
      const [reaction] = await reactionIntrospector.get();
      await msg.waitForStatus("complete");
      await reaction.waitForStatus("complete");

      // 🛑 added by the handler; removed after the collect-reaction signal.
      expect(slackReactions.map((r) => r.method)).toEqual([
        "reactions.add",
        "reactions.remove"
      ]);
      expect(slackReactions[0]).toMatchObject({
        name: STOP_REACTION,
        channel: REMOTE_CHANNEL
      });
    } finally {
      await msgIntrospector.dispose();
      await reactionIntrospector.dispose();
    }
  });

  it("collect-reaction suppressed while at least one dispatch is accepted", async () => {
    const slackReactions: ReactionCall[] = [];
    stubFetch({ remoteMode: "accepted", slackReactions });
    const msgIntrospector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [instance] = await msgIntrospector.get();
      await instance.waitForStatus("complete");

      // Message workflow completed but no collect-reaction signal was sent —
      // the 🛑 must persist until the push-notification callback (or backstop)
      // removes it, so the user sees "in progress" until the agent actually replies.
      expect(
        slackReactions.filter((r) => r.method === "reactions.add")
      ).toHaveLength(1);
      expect(
        slackReactions.filter((r) => r.method === "reactions.remove")
      ).toHaveLength(0);
    } finally {
      await msgIntrospector.dispose();
    }
  });
});
