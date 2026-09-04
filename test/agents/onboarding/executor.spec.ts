import { describe, it, expect, afterEach, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { OnboardingAgentExecutor } from "@/agents/onboarding/executor";
import type { SessionHost } from "@/agents/shared/session";
import type { UserAuthContext } from "@/auth";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";
import { TaskState } from "@a2a-js/sdk";
import {
  FakeSession,
  fakeRecallEnv,
  okResult,
  toolCallResult,
  makeRequest,
  terminalTaskText,
  terminalTaskState
} from "../../helpers/agents";
import { userMessage } from "../../helpers/a2a";

const sqlHost: SessionHost = { sql: () => [] };

const caller: UserAuthContext = {
  slackUserId: "U_onb",
  displayName: "Newbie",
  isPrimaryOwner: false,
  isOrgAdmin: false,
  adminWorkspaces: []
};

const onboardingRequest = () =>
  makeRequest({
    contextId: "D_ONB:thread-1",
    text: "how does Dynamic Agents work?",
    metadata: { user: caller, agentKind: "local", tenant: "onboarding" }
  });

afterEach(() => vi.restoreAllMocks());

describe("OnboardingAgentExecutor", () => {
  it("runs the loop and completes an A2A task with the model's reply", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        okResult("Dynamic Agents routes work through Slack.") as never
    });
    const exec = new OnboardingAgentExecutor(sqlHost, {
      model,
      createSession: () => session
    });

    const t = onboardingRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(2);
    expect(terminalTaskText(t.published)).toBe(
      "Dynamic Agents routes work through Slack."
    );
    // user turn + assistant turn persisted
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("publishes a friendly error and still finishes when the loop throws", async () => {
    class ThrowingSession extends FakeSession {
      async refreshSystemPrompt(): Promise<string> {
        throw new Error("memory boom");
      }
    }
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });
    const exec = new OnboardingAgentExecutor(sqlHost, {
      model,
      createSession: () => new ThrowingSession()
    });

    const t = onboardingRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(2);
    // The state — not wording in the reply — is what tells the gatekeeper this
    // turn broke; v1.0 gives a failing task no other machine-readable signal.
    expect(terminalTaskState(t.published)).toBe(TaskState.TASK_STATE_FAILED);
    expect(terminalTaskText(t.published)).toBeTruthy();
  });

  it("offers recall and routes it through the user namespace", async () => {
    const session = new FakeSession([{ id: "c1" }]); // hasArchive=true
    const { query } = fakeRecallEnv();
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        (call++ === 0
          ? toolCallResult("recall", { query: "what did I set up before?" })
          : okResult("Found it in past context.")) as never
    });
    const exec = new OnboardingAgentExecutor(sqlHost, {
      model,
      createSession: () => session
    });

    const t = onboardingRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(2);
    // Recall must be scoped to the caller's user namespace.
    expect(query).toHaveBeenCalledTimes(1);
    const opts = query.mock.calls[0][1] as { namespace: string };
    expect(opts.namespace).toBe("onboarding:U_onb");
  });

  it("errors at the boundary when caller context is absent (no null path)", async () => {
    const session = new FakeSession([{ id: "c1" }]);
    let modelCalled = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        modelCalled = true;
        return okResult("unused") as never;
      }
    });
    const exec = new OnboardingAgentExecutor(sqlHost, {
      model,
      createSession: () => session
    });

    // Request without a user — the Slack user is now a required precondition
    // (uniform with admin), so prepare throws and the loop publishes the
    // friendly error rather than running a degraded, null-tolerant turn.
    const requestContext = {
      contextId: "D_ONB:no-user",
      userMessage: userMessage("hello", {
        messageId: "m_nouser",
        metadata: { agentKind: "local", tenant: "onboarding" } // no user field
      })
    };
    const published: AgentExecutionEvent[] = [];
    let finished = false;
    const eventBus = {
      publish: (e: unknown) => published.push(e as never),
      finished: () => {
        finished = true;
      }
    };

    await exec.execute(requestContext as never, eventBus as never);

    expect(finished).toBe(true);
    expect(published).toHaveLength(2);
    expect(terminalTaskState(published)).toBe(TaskState.TASK_STATE_FAILED);
    expect(terminalTaskText(published)).toBeTruthy();
    expect(modelCalled).toBe(false);
  });
});
