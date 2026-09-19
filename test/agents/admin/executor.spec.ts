import { describe, it, expect, afterEach, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { AdminAgentExecutor } from "@/agents/admin/executor";
import type { UserAuthContext } from "@/auth";
import { Role, type Message } from "@a2a-js/sdk";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";
import { buildMessage } from "@/a2a/parts";
import {
  buildHitlResponseParts,
  buildHitlTimeoutParts,
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID
} from "@/a2a/hitl";
import { getAgent, registerAgent } from "@/db/models/agents";
import {
  FakeSession,
  MemoryOpenCalls,
  fakeAgentSession,
  fakeRecallEnv,
  fakeSessionHost,
  finalReplyResult,
  okResult,
  toolCallResult,
  makeRequest,
  terminalTaskText
} from "../../helpers/agents";
import { freshWsId } from "../../helpers/workspace";
import { useStorageReset } from "../../helpers/storage";

useStorageReset();

const sqlHost = fakeSessionHost();

const caller: UserAuthContext = {
  slackUserId: "U1",
  displayName: "Tester",
  isPrimaryOwner: false,
  isOrgAdmin: true,
  adminWorkspaces: []
};

const adminRequest = () =>
  makeRequest({
    contextId: "C_ADMIN:thread-1",
    text: "list agents",
    metadata: {
      user: caller,
      agentKind: "local",
      tenant: "admin",
      adminWorkspaceId: 0
    }
  });

afterEach(() => vi.restoreAllMocks());

describe("AdminAgentExecutor", () => {
  it("runs the loop and completes an A2A task with the model's reply", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Here are your agents.") as never
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => fakeAgentSession(session)
    });

    const t = adminRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(2);
    expect(terminalTaskText(t.published)).toBe("Here are your agents.");
    // user turn + assistant turn persisted
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("publishes a friendly error and still finishes when the loop throws", async () => {
    // A session whose history read fails exercises the executor's catch path
    // without invoking the model (and its telemetry internals).
    class ThrowingSession extends FakeSession {
      async refreshSystemPrompt(): Promise<string> {
        throw new Error("memory boom");
      }
    }
    const model = new MockLanguageModelV4({
      doGenerate: async () => okResult("unused") as never
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => fakeAgentSession(new ThrowingSession())
    });

    const t = adminRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(2);
    expect(terminalTaskText(t.published)?.toLowerCase()).toContain("error");
  });

  it("withholds the recall tool before the first compaction", async () => {
    const session = new FakeSession([]); // no compactions → hasArchive=false
    let capturedToolNames: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        capturedToolNames = (options.tools ?? []).map((t) => t.name);
        return finalReplyResult("done") as never;
      }
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => fakeAgentSession(session)
    });

    const t = adminRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(capturedToolNames).not.toContain("recall");
  });

  it("offers recall and routes it through the workspace namespace", async () => {
    const session = new FakeSession([{ id: "c1" }]); // hasArchive=true
    const { query } = fakeRecallEnv();
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        (call++ === 0
          ? toolCallResult("recall", {
              query: "what did we decide last month?"
            })
          : finalReplyResult("Found it in past context.")) as never
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => fakeAgentSession(session)
    });

    const t = adminRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(2);
    // The recall tool must have been executed against the workspace namespace.
    expect(query).toHaveBeenCalledTimes(1);
    const opts = query.mock.calls[0][1] as { namespace: string };
    expect(opts.namespace).toBe("admin:0");
  });
});

// ---------------------------------------------------------------------------
// Approvals end to end: the real tools, the real policy, and real D1 rows.
//
// The loop specs drive the mechanism with a stub tool; these prove the thing that
// actually matters — that Approve deletes the agent and nothing else does.
// ---------------------------------------------------------------------------

describe("AdminAgentExecutor — approval resume", () => {
  /** A custom agent to act on. */
  async function registerCustom(name: string, wsId: number): Promise<void> {
    await registerAgent({
      name,
      kind: "remote",
      displayName: name,
      a2aEndpoint: `https://example.com/${name}`,
      tenantId: "main",
      notifyOn: "mention",
      workspaceId: wsId
    });
  }

  /** The delete this agent paused on, as the store kept it. */
  function heldDelete(name: string) {
    return {
      requestId: "aitxt-1",
      toolCallId: "tc-del",
      toolName: "agents_delete",
      input: { name },
      approval: { reason: `Delete agent *${name}*?` },
      createdAt: Date.now()
    };
  }

  /** A resume request carrying `parts` as the user turn, answered by `user`. */
  function resumeRequest(
    parts: Message["parts"],
    user: UserAuthContext,
    wsId: number
  ) {
    const published: AgentExecutionEvent[] = [];
    let finished = false;
    const eventBus = {
      publish: (e: unknown) => published.push(e as never),
      finished: () => {
        finished = true;
      }
    };
    const message = buildMessage({
      messageId: "r1",
      role: Role.ROLE_USER,
      parts,
      contextId: "C_ADMIN:thread-1",
      metadata: {
        user,
        agentKind: "local",
        tenant: "admin",
        adminWorkspaceId: wsId
      }
    });
    const requestContext = {
      contextId: "C_ADMIN:thread-1",
      taskId: "task-test",
      request: {
        tenant: "",
        message,
        configuration: undefined,
        metadata: undefined
      },
      userMessage: message
    };
    return {
      published,
      isFinished: () => finished,
      eventBus: eventBus as never,
      requestContext: requestContext as never
    };
  }

  const answer = (optionId: string, humanText: string) =>
    buildHitlResponseParts({
      requestId: "aitxt-1",
      optionId,
      answeredBy: "U1",
      humanText
    });

  const admin = (wsId: number): UserAuthContext => ({
    ...caller,
    isOrgAdmin: false,
    adminWorkspaces: [wsId]
  });

  const outsider: UserAuthContext = {
    ...caller,
    slackUserId: "U2",
    displayName: "Passer-by",
    isOrgAdmin: false,
    adminWorkspaces: []
  };

  /** An executor wired to a seeded open-call store. */
  function executorFor(name: string) {
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    void openCalls.put(heldDelete(name));
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("All done.") as never
    });
    return {
      session,
      openCalls,
      exec: new AdminAgentExecutor(sqlHost, {
        model,
        createSession: () => fakeAgentSession(session),
        openCalls
      })
    };
  }

  it("deletes the agent when an admin approves", async () => {
    const wsId = await freshWsId("resume-approve");
    await registerCustom("resume-del", wsId);
    const { exec, openCalls } = executorFor("resume-del");

    const t = resumeRequest(
      answer(HITL_APPROVE_OPTION_ID, "Approve"),
      admin(wsId),
      wsId
    );
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(await getAgent("resume-del")).toBeNull();
    // Settled, so a second delivery of the same click cannot delete anything else.
    expect(openCalls.held.size).toBe(0);
    expect(terminalTaskText(t.published)).toBe("All done.");
  });

  it("does not delete when a non-admin approves", async () => {
    // Anyone in the channel can press the button, so the approver is re-checked
    // twice over: the policy re-runs against whoever pressed it, and the tool
    // re-authorizes its caller. Either alone stops this, which is why breaking one
    // of them does not fail this spec — the loop specs pin the policy half, with a
    // gated tool that has no check of its own to fall back on.
    const wsId = await freshWsId("resume-outsider");
    await registerCustom("resume-outsider", wsId);
    const { exec } = executorFor("resume-outsider");

    const t = resumeRequest(
      answer(HITL_APPROVE_OPTION_ID, "Approve"),
      outsider,
      wsId
    );
    await exec.execute(t.requestContext, t.eventBus);

    expect(await getAgent("resume-outsider")).not.toBeNull();
  });

  it("does not delete when the user rejects", async () => {
    const wsId = await freshWsId("resume-reject");
    await registerCustom("resume-keep", wsId);
    const { exec } = executorFor("resume-keep");

    const t = resumeRequest(
      answer(HITL_REJECT_OPTION_ID, "Reject"),
      admin(wsId),
      wsId
    );
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(await getAgent("resume-keep")).not.toBeNull();
  });

  it("does not delete when nobody answered in time", async () => {
    const wsId = await freshWsId("resume-timeout");
    await registerCustom("resume-timeout", wsId);
    const { exec } = executorFor("resume-timeout");

    const t = resumeRequest(
      buildHitlTimeoutParts("aitxt-1"),
      admin(wsId),
      wsId
    );
    await exec.execute(t.requestContext, t.eventBus);

    expect(await getAgent("resume-timeout")).not.toBeNull();
  });

  it("resumes an ask_user answer from its open call, as the call's result", async () => {
    const session = new FakeSession();
    const openCalls = new MemoryOpenCalls();
    await openCalls.put({
      requestId: "q-1",
      toolCallId: "tc-ask",
      toolName: "ask_user",
      input: {
        question: "Which environment?",
        options: [{ label: "staging" }]
      },
      createdAt: Date.now()
    });
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Great, using staging.") as never
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => fakeAgentSession(session),
      openCalls
    });

    const t = resumeRequest(
      buildHitlResponseParts({
        requestId: "q-1",
        optionId: "opt_0",
        answeredBy: "U1",
        humanText: "staging"
      }),
      caller,
      0
    );
    await exec.execute(t.requestContext, t.eventBus);

    expect(terminalTaskText(t.published)).toBe("Great, using staging.");
    // The answer is the call's result, recorded ahead of the reply — not a user turn.
    expect(session.messages.map((m) => m.role)).toEqual([
      "assistant",
      "assistant"
    ]);
    expect(session.messages[0].parts[0]).toMatchObject({
      type: "tool-ask_user",
      output: { answer: "staging", answeredBy: "Tester" }
    });
    expect(openCalls.held.size).toBe(0);
  });

  it("treats an answer with nothing to resume as a normal turn", async () => {
    // A prompt raised before open calls existed: there is nothing to settle.
    const session = new FakeSession();
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalReplyResult("Great, using staging.") as never
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => fakeAgentSession(session),
      openCalls: new MemoryOpenCalls()
    });

    const t = resumeRequest(
      buildHitlResponseParts({
        requestId: "no-such-req",
        optionId: "opt_1",
        answeredBy: "U1",
        humanText: "staging"
      }),
      caller,
      0
    );
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(terminalTaskText(t.published)).toBe("Great, using staging.");
    // The human's chosen label flows in as the user turn the model continues from.
    expect(session.messages[0].parts[0]).toMatchObject({ text: "staging" });
  });
});
