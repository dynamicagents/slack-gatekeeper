import { describe, it, expect, afterEach, vi } from "vitest";
import { stubSlack } from "./slack-stub";
import {
  iterateSlackUsers,
  iterateSlackChannels,
  fetchChannelMemberIds,
  getBotUserId,
  postReply,
  addReaction,
  removeReaction,
  _resetBotInfoCacheForTest
} from "@/wrappers/slack";
import type { SlackUserInfo } from "@/wrappers/slack";

afterEach(() => {
  vi.unstubAllGlobals();
  // getBotInfo memoizes on a single module-level value; clear it so a prior
  // test's cached bot identity doesn't short-circuit the next auth.test call.
  _resetBotInfoCacheForTest();
});

describe("iterateSlackUsers", () => {
  it("follows the cursor across pages", async () => {
    stubSlack((method, body) => {
      if (method !== "users.list") return { ok: true };
      return body.get("cursor")
        ? { ok: true, members: [{ id: "U2" }] }
        : {
            ok: true,
            members: [{ id: "U1" }],
            response_metadata: { next_cursor: "c2" }
          };
    });
    const ids: string[] = [];
    for await (const u of iterateSlackUsers()) ids.push(u.id);
    expect(ids).toEqual(["U1", "U2"]);
  });

  it("normalizes flags and prefers display name", async () => {
    stubSlack((method) =>
      method === "users.list"
        ? {
            ok: true,
            members: [
              {
                id: "U1",
                is_primary_owner: true,
                profile: { display_name: "Owner", real_name: "Owner Real" }
              },
              { id: "U2", is_admin: true, name: "adminuser" },
              { id: "U3", deleted: true }
            ]
          }
        : { ok: true }
    );
    const users: SlackUserInfo[] = [];
    for await (const u of iterateSlackUsers()) users.push(u);
    expect(users[0]).toMatchObject({
      id: "U1",
      isPrimaryOwner: true,
      displayName: "Owner"
    });
    expect(users[1]).toMatchObject({
      id: "U2",
      isPrimaryOwner: false,
      displayName: "adminuser"
    });
    expect(users[2]).toMatchObject({
      id: "U3",
      deleted: true
    });
  });
});

describe("fetchChannelMemberIds", () => {
  it("follows the cursor and unions members", async () => {
    stubSlack((method, body) => {
      if (method !== "conversations.members") return { ok: true };
      return body.get("cursor")
        ? { ok: true, members: ["U3"] }
        : {
            ok: true,
            members: ["U1", "U2"],
            response_metadata: { next_cursor: "c2" }
          };
    });
    const ids = await fetchChannelMemberIds("C1");
    expect([...ids].sort()).toEqual(["U1", "U2", "U3"]);
  });
});

describe("iterateSlackChannels", () => {
  it("follows the cursor and yields named channels across pages", async () => {
    stubSlack((method, body) => {
      if (method !== "conversations.list") return { ok: true };
      return body.get("cursor")
        ? {
            ok: true,
            channels: [{ id: "C_TARGET", name: "da-org-admin" }]
          }
        : {
            ok: true,
            channels: [{ id: "C_OTHER", name: "general" }],
            response_metadata: { next_cursor: "c2" }
          };
    });
    const channels: { id: string; name: string }[] = [];
    for await (const c of iterateSlackChannels()) channels.push(c);
    expect(channels).toEqual([
      { id: "C_OTHER", name: "general" },
      { id: "C_TARGET", name: "da-org-admin" }
    ]);
  });

  it("skips channels without a name", async () => {
    stubSlack((method) =>
      method === "conversations.list"
        ? { ok: true, channels: [{ id: "C1", name: "ok" }, { id: "C2" }] }
        : { ok: true }
    );
    const ids: string[] = [];
    for await (const c of iterateSlackChannels()) ids.push(c.id);
    expect(ids).toEqual(["C1"]);
  });
});

describe("getBotUserId", () => {
  it("resolves the bot user id", async () => {
    stubSlack((method) =>
      method === "auth.test" ? { ok: true, user_id: "UBOT" } : { ok: true }
    );
    expect(await getBotUserId()).toBe("UBOT");
  });

  it("throws on a non-ok response (e.g. missing scope)", async () => {
    stubSlack(() => ({ ok: false, error: "missing_scope" }));
    // The afterEach reset clears the cache from the success test above, so this
    // call actually hits auth.test and surfaces the error.
    await expect(getBotUserId()).rejects.toThrow(/missing_scope/);
  });
});

describe("postReply", () => {
  it("posts a threaded reply with channel + thread_ts + text", async () => {
    let captured: URLSearchParams | undefined;
    stubSlack((method, body) => {
      if (method === "chat.postMessage") captured = body;
      return { ok: true, ts: "1.2" };
    });
    await postReply("C1", "1700.1", "hello world");
    expect(captured?.get("channel")).toBe("C1");
    expect(captured?.get("thread_ts")).toBe("1700.1");
    expect(captured?.get("text")).toBe("hello world");
  });

  it("omits thread_ts when null (top-level post)", async () => {
    let captured: URLSearchParams | undefined;
    stubSlack((method, body) => {
      if (method === "chat.postMessage") captured = body;
      return { ok: true };
    });
    await postReply("D1", null, "hi");
    expect(captured?.has("thread_ts")).toBe(false);
  });

  it("sets username when a display name is provided", async () => {
    let captured: URLSearchParams | undefined;
    stubSlack((method, body) => {
      if (method === "chat.postMessage") captured = body;
      return { ok: true, ts: "1.2" };
    });
    await postReply("C1", "1700.1", "hello", "Analytics Bot");
    expect(captured?.get("username")).toBe("Analytics Bot");
  });

  it("omits username when absent or empty", async () => {
    let captured: URLSearchParams | undefined;
    stubSlack((method, body) => {
      if (method === "chat.postMessage") captured = body;
      return { ok: true, ts: "1.2" };
    });
    await postReply("C1", "1700.1", "hello");
    expect(captured?.has("username")).toBe(false);
    await postReply("C1", "1700.1", "hello", "");
    expect(captured?.has("username")).toBe(false);
  });

  it("sets icon_url when iconUrl is provided", async () => {
    let captured: URLSearchParams | undefined;
    stubSlack((method, body) => {
      if (method === "chat.postMessage") captured = body;
      return { ok: true, ts: "1.2" };
    });
    await postReply(
      "C1",
      "1700.1",
      "hello",
      "Bot",
      "https://example.com/icon.png"
    );
    expect(captured?.get("icon_url")).toBe("https://example.com/icon.png");
  });

  it("omits icon_url when absent or null", async () => {
    let captured: URLSearchParams | undefined;
    stubSlack((method, body) => {
      if (method === "chat.postMessage") captured = body;
      return { ok: true, ts: "1.2" };
    });
    await postReply("C1", "1700.1", "hello");
    expect(captured?.has("icon_url")).toBe(false);
    await postReply("C1", "1700.1", "hello", null, null);
    expect(captured?.has("icon_url")).toBe(false);
  });

  it("throws on a non-ok response", async () => {
    stubSlack(() => ({ ok: false, error: "channel_not_found" }));
    await expect(postReply("C1", null, "x")).rejects.toThrow(
      /channel_not_found/
    );
  });
});

describe("addReaction", () => {
  it("calls reactions.add with channel, timestamp, and name", async () => {
    let captured: URLSearchParams | undefined;
    stubSlack((method, body) => {
      if (method === "reactions.add") captured = body;
      return { ok: true };
    });
    await addReaction("C1", "1700.1", "octagonal_sign");
    expect(captured?.get("channel")).toBe("C1");
    expect(captured?.get("timestamp")).toBe("1700.1");
    expect(captured?.get("name")).toBe("octagonal_sign");
  });

  it("treats already_reacted as success (idempotent)", async () => {
    stubSlack((method) =>
      method === "reactions.add"
        ? { ok: false, error: "already_reacted" }
        : { ok: true }
    );
    await expect(addReaction("C1", "1700.1", "x")).resolves.toBeUndefined();
  });

  it("throws on other Slack errors", async () => {
    stubSlack((method) =>
      method === "reactions.add"
        ? { ok: false, error: "missing_scope" }
        : { ok: true }
    );
    await expect(addReaction("C1", "1700.1", "x")).rejects.toThrow(
      /missing_scope/
    );
  });
});

describe("removeReaction", () => {
  it("calls reactions.remove with channel, timestamp, and name", async () => {
    let captured: URLSearchParams | undefined;
    stubSlack((method, body) => {
      if (method === "reactions.remove") captured = body;
      return { ok: true };
    });
    await removeReaction("C1", "1700.1", "octagonal_sign");
    expect(captured?.get("channel")).toBe("C1");
    expect(captured?.get("timestamp")).toBe("1700.1");
    expect(captured?.get("name")).toBe("octagonal_sign");
  });

  it("treats no_reaction and message_not_found as success (idempotent)", async () => {
    for (const error of ["no_reaction", "message_not_found"]) {
      stubSlack((method) =>
        method === "reactions.remove" ? { ok: false, error } : { ok: true }
      );
      await expect(
        removeReaction("C1", "1700.1", "x")
      ).resolves.toBeUndefined();
    }
  });

  it("throws on other Slack errors", async () => {
    stubSlack((method) =>
      method === "reactions.remove"
        ? { ok: false, error: "missing_scope" }
        : { ok: true }
    );
    await expect(removeReaction("C1", "1700.1", "x")).rejects.toThrow(
      /missing_scope/
    );
  });
});
