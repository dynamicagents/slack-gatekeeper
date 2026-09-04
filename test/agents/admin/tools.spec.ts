import { describe, it, expect } from "vitest";
import type { UserAuthContext } from "@/auth";
import type { HitlRequest } from "@/a2a/hitl";
import type { GatedAction } from "@/agents/admin/approvals";
import {
  agentsRead,
  agentsCreate,
  agentsUpdate,
  agentsAllowChannel,
  agentsRevokeChannel,
  agentsRegenerateAvatar,
  agentsDelete,
  agentsRepin,
  askUser,
  workspaceRead,
  workspaceCreate,
  agentsDomainsList,
  agentsDomainsAdd,
  agentsDomainsRemove,
  selfSetAvatar,
  selfSetDisplayName,
  buildAdminTools,
  type AdminToolDeps
} from "@/agents/admin/tools";
import {
  ORG_WORKSPACE_ID,
  setWorkspaceAdminChannel
} from "@/db/models/workspaces";
import { getAgent } from "@/db/models/agents";
import {
  setPublicUrl,
  getAdminIconUrl,
  getAdminDisplayName
} from "@/db/models/workspace-configs";
import { makeAuthCtx, freshWsId } from "../../helpers/workspace";

const ctx = makeAuthCtx;

const orgAdmin = ctx({ isOrgAdmin: true });

function deps(wsId: number, c: UserAuthContext | null): AdminToolDeps {
  return {
    ctx: c,
    wsId,
    // Offline stub: pretend every endpoint serves a validly-signed card.
    verifyEndpoint: async (url) => ({
      pin: {
        cardSigningJku: `${new URL(url).origin}/.well-known/jwks.json`,
        cardSigningKid: "test-kid"
      },
      displayName: "Stubbed Agent",
      endpoint: url
    })
  };
}

describe("admin tools — agents_create / agents_read", () => {
  it("registers a custom agent scoped to the workspace and reads it back", async () => {
    const wsId = await freshWsId("tools-ws-a");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    const reg = await agentsCreate(d, {
      name: "tool-agent-a",
      displayName: "Tool Agent A",
      a2aEndpoint: "https://example.com/tool-agent-a",
      tenantId: "unregister_agent",
      notifyOn: "mention"
    });
    expect(reg).toMatchObject({ ok: true });

    type ReadResult = {
      agents: Array<{
        name: string;
        kind: string;
        tenantId: string;
        workspaceId: number;
      }>;
    };
    const read = (await agentsRead(d, { name: "tool-agent-a" })) as ReadResult;
    expect(read.agents).toHaveLength(1);
    expect(read.agents[0]).toMatchObject({
      name: "tool-agent-a",
      kind: "remote",
      tenantId: "unregister_agent",
      workspaceId: wsId
    });

    // The list path shapes rows separately from the by-name lookup, so it needs
    // its own assertion that tenantId — which addresses the agent at its
    // endpoint — is surfaced too.
    const listed = (await agentsRead(d, {})) as ReadResult;
    expect(listed.agents).toEqual([
      expect.objectContaining({
        name: "tool-agent-a",
        tenantId: "unregister_agent"
      })
    ]);
  });

  it("denies a caller who is not an admin of the workspace", async () => {
    const d = deps(101, ctx({ adminWorkspaces: [999] }));
    expect(await agentsRead(d, {})).toHaveProperty("error");
    expect(
      await agentsCreate(d, {
        name: "nope",
        a2aEndpoint: "https://example.com/nope",
        tenantId: "main",
        notifyOn: "mention"
      })
    ).toHaveProperty("error");
  });

  it("denies when there is no authenticated caller", async () => {
    const d = deps(102, null);
    expect(await agentsRead(d, {})).toHaveProperty("error");
  });

  it("refuses reserved/built-in names and duplicates", async () => {
    const d = deps(ORG_WORKSPACE_ID, orgAdmin);
    expect(
      await agentsCreate(d, {
        name: "admin",
        a2aEndpoint: "https://example.com/admin",
        tenantId: "main",
        notifyOn: "mention"
      })
    ).toHaveProperty("error");
    // built-in admin row cannot be modified
    expect(await agentsDelete(d, { name: "admin" })).toHaveProperty("error");

    const wsId = await freshWsId("tools-ws-dup");
    const d2 = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await agentsCreate(d2, {
      name: "dup-agent",
      a2aEndpoint: "https://example.com/dup-agent",
      tenantId: "main",
      notifyOn: "mention"
    });
    expect(
      await agentsCreate(d2, {
        name: "dup-agent",
        a2aEndpoint: "https://example.com/dup-agent",
        tenantId: "main",
        notifyOn: "mention"
      })
    ).toHaveProperty("error");
  });

  it("adds and removes channels one at a time", async () => {
    const wsId = await freshWsId("tools-ws-chan");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await agentsCreate(d, {
      name: "chan-agent",
      a2aEndpoint: "https://example.com/chan-agent",
      tenantId: "main",
      notifyOn: "mention"
    });
    await agentsUpdate(d, {
      name: "chan-agent",
      displayName: "Channeled"
    });
    await agentsAllowChannel(d, {
      name: "chan-agent",
      channelId: "C_A"
    });
    await agentsAllowChannel(d, {
      name: "chan-agent",
      channelId: "C_B"
    });
    const afterAttach = (await agentsRead(d, { name: "chan-agent" })) as {
      agents: Array<{ displayName: string; channels: string[] }>;
    };
    expect(afterAttach.agents[0].displayName).toBe("Channeled");
    expect(afterAttach.agents[0].channels.sort()).toEqual(["C_A", "C_B"]);

    await agentsRevokeChannel(d, {
      name: "chan-agent",
      channelId: "C_A"
    });
    const afterDetach = (await agentsRead(d, { name: "chan-agent" })) as {
      agents: Array<{ channels: string[] }>;
    };
    expect(afterDetach.agents[0].channels).toEqual(["C_B"]);
  });

  it("rejects channel ops on built-in / cross-workspace agents", async () => {
    const wsA = await freshWsId("tools-ws-chan-owner");
    const wsB = await freshWsId("tools-ws-chan-other");
    const owner = deps(wsA, ctx({ adminWorkspaces: [wsA] }));
    await agentsCreate(owner, {
      name: "chan-owned",
      a2aEndpoint: "https://example.com/chan-owned",
      tenantId: "main",
      notifyOn: "mention"
    });
    const other = deps(wsB, ctx({ adminWorkspaces: [wsB] }));
    expect(
      await agentsAllowChannel(other, {
        name: "chan-owned",
        channelId: "C_X"
      })
    ).toHaveProperty("error");
    expect(
      await agentsRevokeChannel(owner, {
        name: "admin",
        channelId: "C_X"
      })
    ).toHaveProperty("error");
  });

  it("rejects agents_allow_channel for DM (onboarding) channels", async () => {
    const wsId = await freshWsId("tools-ws-dm-guard");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await agentsCreate(d, {
      name: "dm-guard-agent",
      a2aEndpoint: "https://example.com/dm-guard-agent",
      tenantId: "main",
      notifyOn: "mention"
    });
    expect(
      await agentsAllowChannel(d, {
        name: "dm-guard-agent",
        channelId: "DABC123"
      })
    ).toHaveProperty("error");
  });

  it("rejects agents_allow_channel for admin channels", async () => {
    const wsId = await freshWsId("tools-ws-admin-guard");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await agentsCreate(d, {
      name: "admin-guard-agent",
      a2aEndpoint: "https://example.com/admin-guard-agent",
      tenantId: "main",
      notifyOn: "mention"
    });
    await setWorkspaceAdminChannel(wsId, "C_ADMIN_CH");
    expect(
      await agentsAllowChannel(d, {
        name: "admin-guard-agent",
        channelId: "C_ADMIN_CH"
      })
    ).toHaveProperty("error");
  });

  it("cannot write to an agent in another workspace", async () => {
    const wsA = await freshWsId("tools-ws-owner");
    const wsB = await freshWsId("tools-ws-other");
    const owner = deps(wsA, ctx({ adminWorkspaces: [wsA] }));
    await agentsCreate(owner, {
      name: "wsa-agent",
      a2aEndpoint: "https://example.com/wsa-agent",
      tenantId: "main",
      notifyOn: "mention"
    });
    const other = deps(wsB, ctx({ adminWorkspaces: [wsB] }));
    expect(await agentsDelete(other, { name: "wsa-agent" })).toHaveProperty(
      "error"
    );
  });
});

describe("admin tools — human-in-the-loop", () => {
  /** deps that capture parked prompts + stored pending actions. */
  function hitlDeps(wsId: number, c: UserAuthContext | null) {
    const parked: HitlRequest[] = [];
    const stored: { requestId: string; action: GatedAction }[] = [];
    const d: AdminToolDeps = {
      ...deps(wsId, c),
      park: (req) => parked.push(req),
      storePendingAction: async (requestId, action) => {
        stored.push({ requestId, action });
      }
    };
    return { d, parked, stored };
  }

  it("ask_user parks a choice prompt with a freeform option and stores nothing", async () => {
    const { d, parked, stored } = hitlDeps(1, ctx({ adminWorkspaces: [1] }));
    const res = await askUser(d, {
      question: "Which environment?",
      options: [{ label: "dev" }, { label: "prod" }]
    });

    expect(res).toMatchObject({ status: "awaiting_user" });
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      requestKind: "choice",
      prompt: "Which environment?",
      allowFreeform: true
    });
    expect(parked[0].options).toHaveLength(2);
    expect(stored).toHaveLength(0);
  });

  it("ask_user reports unavailable when the turn can't be parked", async () => {
    const res = await askUser(deps(1, ctx({ adminWorkspaces: [1] })), {
      question: "hi?",
      options: [{ label: "a" }]
    });
    expect(res).toHaveProperty("error");
  });

  it("gates agents_delete behind an approval instead of deleting", async () => {
    const wsId = await freshWsId("tools-ws-gate");
    const { d, parked, stored } = hitlDeps(
      wsId,
      ctx({ adminWorkspaces: [wsId] })
    );
    await agentsCreate(d, {
      name: "gate-agent",
      a2aEndpoint: "https://example.com/gate-agent",
      tenantId: "main",
      notifyOn: "mention"
    });

    const res = await agentsDelete(d, { name: "gate-agent" });

    expect(res).toMatchObject({ status: "awaiting_approval" });
    // Not deleted yet — it awaits the human's approval.
    expect(await getAgent("gate-agent")).not.toBeNull();
    expect(parked).toHaveLength(1);
    expect(parked[0].requestKind).toBe("approval");
    // The pending action is stored under the same id the prompt carries.
    expect(stored).toHaveLength(1);
    expect(stored[0].action).toEqual({
      kind: "unregister_agent",
      name: "gate-agent",
      wsId
    });
    expect(stored[0].requestId).toBe(parked[0].requestId);
  });

  it("still denies agents_delete for a reserved name before parking", async () => {
    const { d, parked } = hitlDeps(ORG_WORKSPACE_ID, orgAdmin);
    expect(await agentsDelete(d, { name: "admin" })).toHaveProperty("error");
    expect(parked).toHaveLength(0);
  });

  /** hitlDeps whose verifier reports whatever `kid` the card is meant to name. */
  function repinDeps(wsId: number, c: UserAuthContext | null, kid: string) {
    const base = hitlDeps(wsId, c);
    return {
      ...base,
      d: {
        ...base.d,
        verifyEndpoint: async (url: string) => ({
          pin: {
            cardSigningJku: `${new URL(url).origin}/.well-known/jwks.json`,
            cardSigningKid: kid
          },
          displayName: "Stubbed Agent",
          endpoint: url
        })
      } satisfies AdminToolDeps
    };
  }

  it("agents_repin is a no-op when the card still names the pinned key", async () => {
    const wsId = await freshWsId("tools-ws-repin-same");
    // `deps` and `repinDeps` agree on the kid, so registration pins what the
    // card will report on the re-read.
    const { d, parked, stored } = repinDeps(
      wsId,
      ctx({ adminWorkspaces: [wsId] }),
      "test-kid"
    );
    await agentsCreate(d, {
      name: "repin-same",
      a2aEndpoint: "https://example.com/repin-same",
      tenantId: "main",
      notifyOn: "mention"
    });

    const res = await agentsRepin(d, { name: "repin-same" });

    expect(res).toMatchObject({ ok: true });
    expect(res.note).toContain("already pinned");
    // A no-op must not spend a human's approval.
    expect(parked).toHaveLength(0);
    expect(stored).toHaveLength(0);
  });

  it("agents_repin gates a changed key behind an approval and names both", async () => {
    const wsId = await freshWsId("tools-ws-repin-new");
    const admin = ctx({ adminWorkspaces: [wsId] });
    // Registered against the default verifier ("test-kid")…
    const registered = hitlDeps(wsId, admin);
    await agentsCreate(registered.d, {
      name: "repin-new",
      a2aEndpoint: "https://example.com/repin-new",
      tenantId: "main",
      notifyOn: "mention"
    });
    // …then the agent rotates its key.
    const { d, parked, stored } = repinDeps(wsId, admin, "rotated-kid");

    const res = await agentsRepin(d, { name: "repin-new" });

    expect(res).toMatchObject({ status: "awaiting_approval" });
    // Nothing is written until the human approves.
    expect((await getAgent("repin-new"))?.cardSigningKid).toBe("test-kid");
    expect(parked).toHaveLength(1);
    expect(parked[0].requestKind).toBe("approval");
    // Both keys are on screen — that is the whole basis for the decision.
    expect(parked[0].prompt).toContain("test-kid");
    expect(parked[0].prompt).toContain("rotated-kid");
    expect(stored).toHaveLength(1);
    expect(stored[0].action).toEqual({
      kind: "repin_agent",
      name: "repin-new",
      wsId,
      jku: "https://example.com/.well-known/jwks.json",
      kid: "rotated-kid"
    });
    expect(stored[0].requestId).toBe(parked[0].requestId);
  });

  it("agents_repin refuses a built-in agent and a non-admin caller", async () => {
    const wsId = await freshWsId("tools-ws-repin-deny");
    const reserved = repinDeps(wsId, ctx({ adminWorkspaces: [wsId] }), "k");
    expect(await agentsRepin(reserved.d, { name: "admin" })).toHaveProperty(
      "error"
    );
    expect(reserved.parked).toHaveLength(0);

    const outsider = repinDeps(
      wsId,
      ctx({ adminWorkspaces: [wsId + 999] }),
      "k"
    );
    expect(await agentsRepin(outsider.d, { name: "anything" })).toHaveProperty(
      "error"
    );
    expect(outsider.parked).toHaveLength(0);
  });

  it("agents_repin reports a card it cannot read, without parking", async () => {
    const wsId = await freshWsId("tools-ws-repin-down");
    const admin = ctx({ adminWorkspaces: [wsId] });
    const base = hitlDeps(wsId, admin);
    await agentsCreate(base.d, {
      name: "repin-down",
      a2aEndpoint: "https://example.com/repin-down",
      tenantId: "main",
      notifyOn: "mention"
    });
    const d: AdminToolDeps = {
      ...base.d,
      verifyEndpoint: async () => {
        throw new Error("card fetch failed");
      }
    };

    const res = await agentsRepin(d, { name: "repin-down" });

    expect(res.error).toContain("card fetch failed");
    expect(base.parked).toHaveLength(0);
  });
});

describe("admin tools — card-signing verification + pin (TOFU)", () => {
  /** deps with an explicit endpoint verifier (signed-card check seam). */
  function depsWith(
    wsId: number,
    c: UserAuthContext | null,
    verifyEndpoint: AdminToolDeps["verifyEndpoint"]
  ): AdminToolDeps {
    return { ctx: c, wsId, verifyEndpoint };
  }

  it("persists the verified signing pin on register", async () => {
    const wsId = await freshWsId("tools-ws-pin");
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async (url) => ({
      pin: {
        cardSigningJku: "https://signed.example.com/.well-known/jwks.json",
        cardSigningKid: "pin-kid-1"
      },
      displayName: "Pinned Agent",
      endpoint: url
    }));
    const reg = await agentsCreate(d, {
      name: "pinned-agent",
      a2aEndpoint: "https://signed.example.com/a2a",
      tenantId: "unregister_agent",
      notifyOn: "mention"
    });
    expect(reg).toMatchObject({ ok: true });

    const row = await getAgent("pinned-agent");
    expect(row?.cardSigningJku).toBe(
      "https://signed.example.com/.well-known/jwks.json"
    );
    expect(row?.cardSigningKid).toBe("pin-kid-1");
  });

  it("rejects registration when card verification fails (unsigned/forged)", async () => {
    const wsId = await freshWsId("tools-ws-unsigned");
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async () => {
      throw new Error("AgentCard is not signed");
    });
    const res = await agentsCreate(d, {
      name: "unsigned-agent",
      a2aEndpoint: "https://unsigned.example.com/a2a",
      tenantId: "main",
      notifyOn: "mention"
    });
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toContain("verification failed");
    expect(await getAgent("unsigned-agent")).toBeNull();
  });

  it("rejects re-pointing to an endpoint signed by a different key (TOFU)", async () => {
    const wsId = await freshWsId("tools-ws-tofu");
    const original = depsWith(
      wsId,
      ctx({ adminWorkspaces: [wsId] }),
      async (url) => ({
        pin: {
          cardSigningJku: "https://a.example.com/.well-known/jwks.json",
          cardSigningKid: "key-A"
        },
        displayName: "Agent A",
        endpoint: url
      })
    );
    await agentsCreate(original, {
      name: "tofu-agent",
      a2aEndpoint: "https://a.example.com/a2a",
      tenantId: "main",
      notifyOn: "mention"
    });

    // A new endpoint that verifies — but with a DIFFERENT pinned identity.
    const repointed = depsWith(
      wsId,
      ctx({ adminWorkspaces: [wsId] }),
      async (url) => ({
        pin: {
          cardSigningJku: "https://b.example.com/.well-known/jwks.json",
          cardSigningKid: "key-B"
        },
        displayName: "Agent B",
        endpoint: url
      })
    );
    const res = await agentsUpdate(repointed, {
      name: "tofu-agent",
      a2aEndpoint: "https://b.example.com/a2a",
      tenantId: "main"
    });
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toContain("different key");

    // The original pin and endpoint are unchanged.
    const row = await getAgent("tofu-agent");
    expect(row?.cardSigningKid).toBe("key-A");
    expect(row?.a2aEndpoint).toBe("https://a.example.com/a2a");
  });

  it("allows re-pointing to a new endpoint with the SAME pinned key", async () => {
    const wsId = await freshWsId("tools-ws-tofu-ok");
    const pin = {
      cardSigningJku: "https://same.example.com/.well-known/jwks.json",
      cardSigningKid: "key-same"
    };
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async (url) => ({
      pin,
      displayName: "Same Agent",
      endpoint: url
    }));
    await agentsCreate(d, {
      name: "tofu-ok-agent",
      a2aEndpoint: "https://same.example.com/a2a",
      tenantId: "main",
      notifyOn: "mention"
    });
    const res = await agentsUpdate(d, {
      name: "tofu-ok-agent",
      a2aEndpoint: "https://same.example.com/v2",
      tenantId: "main"
    });
    expect(res).toMatchObject({ ok: true });
    const row = await getAgent("tofu-ok-agent");
    expect(row?.a2aEndpoint).toBe("https://same.example.com/v2");
  });
});

describe("admin tools — derive displayName from card (iconUrl is never card-sourced)", () => {
  function depsWith(
    wsId: number,
    c: UserAuthContext | null,
    verifyEndpoint: AdminToolDeps["verifyEndpoint"]
  ): AdminToolDeps {
    return { ctx: c, wsId, verifyEndpoint };
  }

  it("uses card name as displayName and leaves iconUrl unset at register", async () => {
    const wsId = await freshWsId("tools-ws-derive-a");
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async (url) => ({
      pin: {
        cardSigningJku: "https://derive.example.com/.well-known/jwks.json",
        cardSigningKid: "k1"
      },
      displayName: "From Card",
      endpoint: url
    }));
    await agentsCreate(d, {
      name: "derive-agent",
      a2aEndpoint: "https://derive.example.com/a2a",
      tenantId: "main",
      notifyOn: "mention"
    });
    const row = await getAgent("derive-agent");
    expect(row?.displayName).toBe("From Card");
    // A custom agent has no avatar until the admin generates one.
    expect(row?.iconUrl).toBeNull();
  });

  it("explicit displayName at register overrides the card name", async () => {
    const wsId = await freshWsId("tools-ws-derive-b");
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async (url) => ({
      pin: {
        cardSigningJku: "https://derive2.example.com/.well-known/jwks.json",
        cardSigningKid: "k2"
      },
      displayName: "From Card",
      endpoint: url
    }));
    await agentsCreate(d, {
      name: "derive-override-agent",
      displayName: "My Override",
      a2aEndpoint: "https://derive2.example.com/a2a",
      tenantId: "main",
      notifyOn: "mention"
    });
    const row = await getAgent("derive-override-agent");
    expect(row?.displayName).toBe("My Override");
  });

  it("rejects an admin-supplied displayName with a channel-wide mention", async () => {
    const wsId = await freshWsId("tools-ws-derive-broadcast");
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async (url) => ({
      pin: {
        cardSigningJku: "https://bcast.example.com/.well-known/jwks.json",
        cardSigningKid: "kb"
      },
      displayName: "From Card",
      endpoint: url
    }));
    const created = (await agentsCreate(d, {
      name: "broadcast-name-agent",
      displayName: "<!here> Helper",
      a2aEndpoint: "https://bcast.example.com/a2a",
      tenantId: "main",
      notifyOn: "mention"
    })) as { error?: string };
    expect(created.error).toContain("channel-wide mention");
    expect(await getAgent("broadcast-name-agent")).toBeNull();

    await agentsCreate(d, {
      name: "broadcast-name-agent",
      a2aEndpoint: "https://bcast.example.com/a2a",
      tenantId: "main",
      notifyOn: "mention"
    });
    const updated = (await agentsUpdate(d, {
      name: "broadcast-name-agent",
      displayName: "@channel"
    })) as { error?: string };
    expect(updated.error).toContain("channel-wide mention");
    expect((await getAgent("broadcast-name-agent"))?.displayName).toBe(
      "From Card"
    );
  });

  it("endpoint update re-derives displayName but never touches iconUrl", async () => {
    const wsId = await freshWsId("tools-ws-derive-c");
    const pin = {
      cardSigningJku: "https://rederive.example.com/.well-known/jwks.json",
      cardSigningKid: "k3"
    };
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async (url) => ({
      pin,
      displayName: "New Card Name",
      endpoint: url
    }));
    await agentsCreate(d, {
      name: "rederive-agent",
      a2aEndpoint: "https://rederive.example.com/v1",
      tenantId: "main",
      notifyOn: "mention"
    });
    // Give the agent a gatekeeper-hosted avatar, then re-point the endpoint.
    const withSeams: AdminToolDeps = {
      ...d,
      generateImage: async () => ({
        data: new Uint8Array([9, 9, 9]),
        contentType: "image/jpeg"
      }),
      storeIcon: async () => ({
        key: "deadbeefdeadbeef",
        contentType: "image/jpeg"
      })
    };
    await setPublicUrl("https://gw.example.com");
    await agentsRegenerateAvatar(withSeams, {
      name: "rederive-agent"
    });
    const generated = (await getAgent("rederive-agent"))?.iconUrl;
    expect(generated).toBe(
      `https://gw.example.com/icons/${wsId}/rederive-agent/deadbeefdeadbeef.jpg`
    );

    await agentsUpdate(d, {
      name: "rederive-agent",
      a2aEndpoint: "https://rederive.example.com/v2",
      tenantId: "main"
    });
    const row = await getAgent("rederive-agent");
    expect(row?.a2aEndpoint).toBe("https://rederive.example.com/v2");
    expect(row?.displayName).toBe("New Card Name");
    // The admin-generated avatar survives the endpoint change.
    expect(row?.iconUrl).toBe(generated);
  });

  it("explicit displayName on endpoint update overrides re-derived card name", async () => {
    const wsId = await freshWsId("tools-ws-derive-d");
    const pin = {
      cardSigningJku: "https://override2.example.com/.well-known/jwks.json",
      cardSigningKid: "k4"
    };
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async (url) => ({
      pin,
      displayName: "Card Name",
      endpoint: url
    }));
    await agentsCreate(d, {
      name: "override2-agent",
      a2aEndpoint: "https://override2.example.com/v1",
      tenantId: "main",
      notifyOn: "mention"
    });
    await agentsUpdate(d, {
      name: "override2-agent",
      a2aEndpoint: "https://override2.example.com/v2",
      tenantId: "main",
      displayName: "Manual Override"
    });
    const row = await getAgent("override2-agent");
    expect(row?.displayName).toBe("Manual Override");
  });
});

describe("admin tools — workspace_create instance scoping", () => {
  it("org instance (wsId 0) with org admin can create a workspace", async () => {
    const d = deps(ORG_WORKSPACE_ID, orgAdmin);
    const res = (await workspaceCreate(d, {
      name: "tools-created-ws"
    })) as { ok?: boolean; workspace?: { id: number } };
    expect(res.ok).toBe(true);
    expect(res.workspace?.id).toBeGreaterThan(ORG_WORKSPACE_ID);
  });

  it("workspace instance (wsId != 0) is denied even for an org admin", async () => {
    const d = deps(107, orgAdmin);
    expect(await workspaceCreate(d, { name: "should-fail" })).toHaveProperty(
      "error"
    );
  });

  it("org instance denies a non-org caller", async () => {
    const d = deps(ORG_WORKSPACE_ID, ctx({ adminWorkspaces: [5] }));
    expect(await workspaceCreate(d, { name: "should-fail" })).toHaveProperty(
      "error"
    );
  });
});

describe("admin tools — buildAdminTools availability", () => {
  const orgOnly = [
    "workspace_create",
    "workspace_set_admin_channel",
    "agents_domains_list",
    "agents_domains_add",
    "agents_domains_remove"
  ];

  it("exposes the org-only tools only on the org instance", () => {
    const orgTools = buildAdminTools(deps(ORG_WORKSPACE_ID, orgAdmin));
    expect(Object.keys(orgTools)).toEqual(expect.arrayContaining(orgOnly));

    const wsTools = buildAdminTools(deps(3, ctx({ adminWorkspaces: [3] })));
    for (const key of orgOnly) {
      expect(Object.keys(wsTools)).not.toContain(key);
    }
    expect(Object.keys(wsTools)).toEqual(
      expect.arrayContaining([
        "agents_read",
        "agents_create",
        "agents_update",
        "agents_delete",
        "agents_allow_channel",
        "agents_revoke_channel",
        "agents_regenerate_avatar",
        "workspace_read"
      ])
    );
  });
});

describe("admin tools — agents_domains", () => {
  const orgDeps = deps(ORG_WORKSPACE_ID, orgAdmin);

  it("lists empty approved domains initially", async () => {
    const res = (await agentsDomainsList(orgDeps)) as {
      approvedDomains: string[];
    };
    expect(Array.isArray(res.approvedDomains)).toBe(true);
  });

  it("adds a domain and reads it back via list", async () => {
    await agentsDomainsAdd(orgDeps, {
      domain: "agents.example-radt.com"
    });
    const res = (await agentsDomainsList(orgDeps)) as {
      approvedDomains: string[];
    };
    expect(res.approvedDomains).toContain("agents.example-radt.com");
  });

  it("is idempotent when adding the same domain twice", async () => {
    await agentsDomainsAdd(orgDeps, {
      domain: "idempotent.example-radt.com"
    });
    await agentsDomainsAdd(orgDeps, {
      domain: "idempotent.example-radt.com"
    });
    const res = (await agentsDomainsList(orgDeps)) as {
      approvedDomains: string[];
    };
    const count = res.approvedDomains.filter(
      (d) => d === "idempotent.example-radt.com"
    ).length;
    expect(count).toBe(1);
  });

  it("removes a domain", async () => {
    await agentsDomainsAdd(orgDeps, {
      domain: "remove-me.example-radt.com"
    });
    await agentsDomainsRemove(orgDeps, {
      domain: "remove-me.example-radt.com"
    });
    const res = (await agentsDomainsList(orgDeps)) as {
      approvedDomains: string[];
    };
    expect(res.approvedDomains).not.toContain("remove-me.example-radt.com");
  });

  it("remove is a no-op when domain is not in the list", async () => {
    const res = await agentsDomainsRemove(orgDeps, {
      domain: "never-added.example-radt.com"
    });
    expect(res).toMatchObject({ ok: true });
  });

  it("rejects adding a bare shared-infra root domain", async () => {
    for (const root of ["workers.dev", "pages.dev", "vercel.app"]) {
      const res = (await agentsDomainsAdd(orgDeps, {
        domain: root
      })) as { error: string };
      expect(res).toHaveProperty("error");
      expect(res.error).toContain("shared infrastructure root domain");
    }
  });

  it("allows adding an account-level subdomain of a shared-infra root", async () => {
    const res = await agentsDomainsAdd(orgDeps, {
      domain: "myorg.workers.dev"
    });
    expect(res).toMatchObject({ ok: true });
  });

  it("rejects a bare single-label domain", async () => {
    const res = await agentsDomainsAdd(orgDeps, {
      domain: "localhost"
    });
    expect(res).toHaveProperty("error");
  });

  it("denies a non-org-admin caller", async () => {
    const nonOrg = deps(ORG_WORKSPACE_ID, ctx({ adminWorkspaces: [5] }));
    expect(await agentsDomainsList(nonOrg)).toHaveProperty("error");
  });

  it("denies calls from a non-org workspace instance", async () => {
    const wsInstance = deps(3, orgAdmin);
    expect(await agentsDomainsList(wsInstance)).toHaveProperty("error");
  });

  it("denies unauthenticated calls", async () => {
    const noAuth = deps(ORG_WORKSPACE_ID, null);
    expect(await agentsDomainsList(noAuth)).toHaveProperty("error");
  });
});

describe("admin tools — workspace_read scoping", () => {
  it("a workspace admin reads only its own workspace", async () => {
    const d = deps(2, ctx({ adminWorkspaces: [2] }));
    const denied = await workspaceRead(d, { id: 999 });
    expect(denied).toHaveProperty("error");
  });
});

const okImage = {
  data: new Uint8Array([1, 2, 3]),
  contentType: "image/jpeg"
};

/** Tool deps with the image/store seams wired to in-memory fakes. */
function avatarDeps(
  wsId: number,
  c: UserAuthContext | null,
  overrides: Partial<AdminToolDeps> = {}
): AdminToolDeps {
  return {
    ...deps(wsId, c),
    generateImage: async () => okImage,
    storeIcon: async () => ({
      key: "abc123def4567890",
      contentType: "image/jpeg"
    }),
    ...overrides
  };
}

describe("admin tools — self_set_avatar", () => {
  it("generates, stores under the 'admin' name, and records the avatar URL", async () => {
    const wsId = await freshWsId("tools-ws-avatar");
    await setPublicUrl("https://gw.example.com");
    const prompts: string[] = [];
    const names: string[] = [];
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }), {
      generateImage: async (p) => {
        prompts.push(p);
        return okImage;
      },
      storeIcon: async (_img, name) => {
        names.push(name);
        return { key: "abc123def4567890", contentType: "image/jpeg" };
      }
    });

    const res = (await selfSetAvatar(d, {
      instructions: "blue robot"
    })) as { ok?: boolean; iconUrl?: string };
    expect(res.ok).toBe(true);
    expect(res.iconUrl).toBe(
      `https://gw.example.com/icons/${wsId}/admin/abc123def4567890.jpg`
    );
    expect(prompts[0]).toContain("tools-ws-avatar");
    expect(prompts[0]).toContain("blue robot");
    expect(names).toEqual(["admin"]);
    expect(await getAdminIconUrl(wsId)).toBe(res.iconUrl);
  });

  it("errors when the gatekeeper public URL isn't known yet", async () => {
    const wsId = await freshWsId("tools-ws-avatar-nourl");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }));
    expect(await selfSetAvatar(d, {})).toHaveProperty("error");
  });

  it("denies a caller who is not an admin of the workspace", async () => {
    const wsId = await freshWsId("tools-ws-avatar-deny");
    await setPublicUrl("https://gw.example.com");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [999] }));
    expect(await selfSetAvatar(d, {})).toHaveProperty("error");
  });

  it("errors when the image seams are absent", async () => {
    const wsId = await freshWsId("tools-ws-avatar-noseam");
    await setPublicUrl("https://gw.example.com");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] })); // no generateImage/storeIcon
    const res = (await selfSetAvatar(d, {})) as {
      error?: string;
    };
    expect(res.error).toContain("not available");
  });

  it("surfaces a friendly error when generation throws", async () => {
    const wsId = await freshWsId("tools-ws-avatar-fail");
    await setPublicUrl("https://gw.example.com");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }), {
      generateImage: async () => {
        throw new Error("model overloaded");
      }
    });
    const res = (await selfSetAvatar(d, {})) as {
      error?: string;
    };
    expect(res.error).toContain("Avatar generation failed");
  });
});

describe("admin tools — self_set_display_name", () => {
  it("records the per-workspace admin display name", async () => {
    const wsId = await freshWsId("tools-ws-selfname");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    const res = (await selfSetDisplayName(d, {
      displayName: "  Ops Bot  "
    })) as { ok?: boolean; displayName?: string };
    expect(res.ok).toBe(true);
    expect(res.displayName).toBe("Ops Bot");
    expect(await getAdminDisplayName(wsId)).toBe("Ops Bot");
  });

  it("rejects an empty display name", async () => {
    const wsId = await freshWsId("tools-ws-selfname-empty");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    expect(await selfSetDisplayName(d, { displayName: "   " })).toHaveProperty(
      "error"
    );
  });

  it("rejects a display name carrying a channel-wide mention, either spelling", async () => {
    const wsId = await freshWsId("tools-ws-selfname-broadcast");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    for (const displayName of ["Ops <!channel> Bot", "Ops @here Bot"]) {
      const res = (await selfSetDisplayName(d, { displayName })) as {
        error?: string;
      };
      expect(res.error).toContain("channel-wide mention");
      expect(await getAdminDisplayName(wsId)).toBeNull();
    }
  });

  it("denies a non-admin caller", async () => {
    const wsId = await freshWsId("tools-ws-selfname-deny");
    const d = deps(wsId, ctx({ adminWorkspaces: [999] }));
    expect(await selfSetDisplayName(d, { displayName: "X" })).toHaveProperty(
      "error"
    );
  });
});

describe("admin tools — self_* tools are always registered", () => {
  it("registers self_set_avatar and self_set_display_name with and without the image seams", () => {
    const wsId = 3;
    const base = ctx({ adminWorkspaces: [wsId] });
    const without = buildAdminTools(deps(wsId, base));
    expect(Object.keys(without)).toEqual(
      expect.arrayContaining(["self_set_avatar", "self_set_display_name"])
    );

    const withSeams = buildAdminTools(avatarDeps(wsId, base));
    expect(Object.keys(withSeams)).toEqual(
      expect.arrayContaining(["self_set_avatar", "self_set_display_name"])
    );
  });
});

describe("admin tools — agents_regenerate_avatar", () => {
  async function registerAgentFor(
    wsId: number,
    name: string,
    d: AdminToolDeps
  ): Promise<void> {
    await agentsCreate(d, {
      name,
      a2aEndpoint: `https://${name}.example.com/a2a`,
      tenantId: "main",
      notifyOn: "mention"
    });
  }

  it("generates an avatar and sets the custom agent's iconUrl", async () => {
    const wsId = await freshWsId("tools-ws-agent-avatar");
    await setPublicUrl("https://gw.example.com");
    const prompts: string[] = [];
    const names: string[] = [];
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }), {
      generateImage: async (p) => {
        prompts.push(p);
        return okImage;
      },
      storeIcon: async (_img, name) => {
        names.push(name);
        return { key: "abc123def4567890", contentType: "image/jpeg" };
      }
    });
    await registerAgentFor(wsId, "paint-agent", d);

    const res = (await agentsRegenerateAvatar(d, {
      name: "paint-agent",
      instructions: "teal owl"
    })) as { ok?: boolean; agent?: { iconUrl?: string } };
    expect(res.ok).toBe(true);
    const expected = `https://gw.example.com/icons/${wsId}/paint-agent/abc123def4567890.jpg`;
    expect(res.agent?.iconUrl).toBe(expected);
    expect((await getAgent("paint-agent"))?.iconUrl).toBe(expected);
    // Prompt anchors on the agent's display name, not the "admin assistant";
    // stored under the per-agent name.
    expect(prompts[0]).toContain("Stubbed Agent"); // the registered displayName
    expect(prompts[0]).not.toContain("admin assistant");
    expect(prompts[0]).toContain("teal owl");
    expect(names).toEqual(["paint-agent"]);
  });

  it("rejects a built-in / reserved agent", async () => {
    const wsId = await freshWsId("tools-ws-agent-avatar-builtin");
    await setPublicUrl("https://gw.example.com");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }));
    expect(await agentsRegenerateAvatar(d, { name: "admin" })).toHaveProperty(
      "error"
    );
  });

  it("rejects an agent that doesn't belong to this workspace", async () => {
    const wsId = await freshWsId("tools-ws-agent-avatar-scope");
    await setPublicUrl("https://gw.example.com");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }));
    expect(
      await agentsRegenerateAvatar(d, {
        name: "nonexistent-agent"
      })
    ).toHaveProperty("error");
  });

  it("errors when the image seams are absent", async () => {
    const wsId = await freshWsId("tools-ws-agent-avatar-noseam");
    await setPublicUrl("https://gw.example.com");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await registerAgentFor(wsId, "noseam-agent", d);
    const res = (await agentsRegenerateAvatar(d, {
      name: "noseam-agent"
    })) as { error?: string };
    expect(res.error).toContain("not available");
  });

  it("errors when the gatekeeper public URL isn't known yet", async () => {
    const wsId = await freshWsId("tools-ws-agent-avatar-nourl");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await registerAgentFor(wsId, "nourl-agent", d);
    expect(
      await agentsRegenerateAvatar(d, {
        name: "nourl-agent"
      })
    ).toHaveProperty("error");
  });
});
