import { describe, it, expect } from "vitest";
import type { UserAuthContext } from "@/auth";
import {
  adminToolApproval,
  agentsRead,
  agentsCreate,
  agentsUpdate,
  agentsAllowChannel,
  agentsRevokeChannel,
  agentsRegenerateAvatar,
  agentsDelete,
  agentsRepin,
  agentsRepinApply,
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
import { useStorageReset } from "../../helpers/storage";

useStorageReset();

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

describe("admin tools — destructive calls and their approval policy", () => {
  /** deps whose verifier reports whatever `kid` the card is meant to name. */
  function depsWithKid(
    wsId: number,
    c: UserAuthContext | null,
    kid: string
  ): AdminToolDeps {
    return {
      ...deps(wsId, c),
      verifyEndpoint: async (url: string) => ({
        pin: {
          cardSigningJku: `${new URL(url).origin}/.well-known/jwks.json`,
          cardSigningKid: kid
        },
        displayName: "Stubbed Agent",
        endpoint: url
      })
    };
  }

  /** One gated tool's policy entry, as something a spec can call directly. */
  function policyFor(d: AdminToolDeps, name: string) {
    const policy = adminToolApproval(d) as unknown as Record<
      string,
      (
        input: unknown,
        options: unknown
      ) => Promise<{ type: string; reason?: string }>
    >;
    return (input: unknown) => policy[name](input, {});
  }

  /** A custom agent, pinned to the default verifier's "test-kid". */
  async function registerCustom(d: AdminToolDeps, name: string): Promise<void> {
    await agentsCreate(d, {
      name,
      a2aEndpoint: `https://example.com/${name}`,
      tenantId: "main",
      notifyOn: "mention"
    });
  }

  const JKU = "https://example.com/.well-known/jwks.json";

  // --- agents_delete acts for itself ---------------------------------------

  it("agents_delete removes the agent", async () => {
    const wsId = await freshWsId("del-ok");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await registerCustom(d, "del-ok");

    expect(await agentsDelete(d, { name: "del-ok" })).toMatchObject({
      ok: true,
      deleted: "del-ok"
    });
    expect(await getAgent("del-ok")).toBeNull();
  });

  it("agents_delete refuses a non-admin, and the agent survives", async () => {
    // The policy gates the call, but the tool does not lean on it having run: an
    // execute that trusted its caller would be one wiring mistake from deleting.
    const wsId = await freshWsId("del-unauth");
    await registerCustom(
      deps(wsId, ctx({ adminWorkspaces: [wsId] })),
      "del-unauth"
    );

    const d = deps(wsId, ctx({ adminWorkspaces: [wsId + 999] }));
    expect(await agentsDelete(d, { name: "del-unauth" })).toHaveProperty(
      "error"
    );
    expect(await getAgent("del-unauth")).not.toBeNull();
  });

  it("agents_delete refuses a built-in agent", async () => {
    expect(
      await agentsDelete(deps(ORG_WORKSPACE_ID, orgAdmin), { name: "admin" })
    ).toHaveProperty("error");
  });

  // --- and the policy decides who may ask -----------------------------------

  it("the delete policy asks a human, naming the agent", async () => {
    const wsId = await freshWsId("del-policy");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await registerCustom(d, "del-policy");

    const status = await policyFor(d, "agents_delete")({ name: "del-policy" });

    expect(status.type).toBe("user-approval");
    // The prompt is the whole basis for the decision, so it has to name the target.
    expect(status.reason).toContain("del-policy");
    expect(status.reason).toContain("cannot be undone");
  });

  it("the delete policy denies a non-admin, with no prompt raised", async () => {
    // Denied, not user-approval: nobody should be asked to approve a call that
    // would be refused whatever they answered.
    const wsId = await freshWsId("del-policy-unauth");
    await registerCustom(
      deps(wsId, ctx({ adminWorkspaces: [wsId] })),
      "del-policy-unauth"
    );

    const d = deps(wsId, ctx({ adminWorkspaces: [wsId + 999] }));
    const status = await policyFor(
      d,
      "agents_delete"
    )({
      name: "del-policy-unauth"
    });
    expect(status.type).toBe("denied");
  });

  it("the delete policy denies a built-in agent", async () => {
    const status = await policyFor(
      deps(ORG_WORKSPACE_ID, orgAdmin),
      "agents_delete"
    )({ name: "admin" });
    expect(status.type).toBe("denied");
  });

  // --- agents_repin only reads ----------------------------------------------

  it("agents_repin reports both keys when the card advertises a new one", async () => {
    const wsId = await freshWsId("repin-new");
    const admin = ctx({ adminWorkspaces: [wsId] });
    await registerCustom(deps(wsId, admin), "repin-new");
    const d = depsWithKid(wsId, admin, "rotated-kid");

    const res = await agentsRepin(d, { name: "repin-new" });

    expect(res).toMatchObject({
      ok: true,
      changed: true,
      pinned: { kid: "test-kid" },
      advertised: { kid: "rotated-kid" }
    });
    // Reading must never write.
    expect((await getAgent("repin-new"))?.cardSigningKid).toBe("test-kid");
  });

  it("agents_repin says there is nothing to change when the key still matches", async () => {
    const wsId = await freshWsId("repin-same");
    const d = depsWithKid(wsId, ctx({ adminWorkspaces: [wsId] }), "test-kid");
    await registerCustom(d, "repin-same");

    const res = await agentsRepin(d, { name: "repin-same" });

    expect(res).toMatchObject({ ok: true, changed: false });
    expect(String(res.note)).toContain("already pinned");
  });

  it("agents_repin reports a card it cannot read", async () => {
    const wsId = await freshWsId("repin-down");
    const admin = ctx({ adminWorkspaces: [wsId] });
    await registerCustom(deps(wsId, admin), "repin-down");
    const d: AdminToolDeps = {
      ...deps(wsId, admin),
      verifyEndpoint: async () => {
        throw new Error("card fetch failed");
      }
    };

    const res = await agentsRepin(d, { name: "repin-down" });
    expect(String(res.error)).toContain("card fetch failed");
  });

  it("agents_repin refuses a built-in agent and a non-admin caller", async () => {
    const wsId = await freshWsId("repin-deny");
    expect(
      await agentsRepin(
        depsWithKid(wsId, ctx({ adminWorkspaces: [wsId] }), "k"),
        {
          name: "admin"
        }
      )
    ).toHaveProperty("error");
    expect(
      await agentsRepin(
        depsWithKid(wsId, ctx({ adminWorkspaces: [wsId + 999] }), "k"),
        { name: "anything" }
      )
    ).toHaveProperty("error");
  });

  // --- agents_repin_apply writes, and only what was approved -----------------

  it("agents_repin_apply writes the key when the live card still names it", async () => {
    const wsId = await freshWsId("apply-ok");
    const admin = ctx({ adminWorkspaces: [wsId] });
    await registerCustom(deps(wsId, admin), "apply-ok");
    const d = depsWithKid(wsId, admin, "rotated-kid");

    const res = await agentsRepinApply(d, {
      name: "apply-ok",
      jku: JKU,
      kid: "rotated-kid"
    });

    expect(res).toMatchObject({ ok: true });
    expect((await getAgent("apply-ok"))?.cardSigningKid).toBe("rotated-kid");
  });

  it("agents_repin_apply refuses a key that moved again since the approval", async () => {
    // The human approved one key. Writing whatever the card says now would be a
    // decision nobody made.
    const wsId = await freshWsId("apply-moved");
    const admin = ctx({ adminWorkspaces: [wsId] });
    await registerCustom(deps(wsId, admin), "apply-moved");
    const d = depsWithKid(wsId, admin, "newer-kid");

    const res = await agentsRepinApply(d, {
      name: "apply-moved",
      jku: JKU,
      kid: "rotated-kid"
    });

    expect(String(res.error)).toContain("changed again");
    // Neither the approved key nor the surprise one is written.
    expect((await getAgent("apply-moved"))?.cardSigningKid).toBe("test-kid");
  });

  it("agents_repin_apply refuses a non-admin", async () => {
    const wsId = await freshWsId("apply-unauth");
    await registerCustom(
      deps(wsId, ctx({ adminWorkspaces: [wsId] })),
      "apply-unauth"
    );
    const d = depsWithKid(
      wsId,
      ctx({ adminWorkspaces: [wsId + 999] }),
      "rotated-kid"
    );

    expect(
      await agentsRepinApply(d, {
        name: "apply-unauth",
        jku: JKU,
        kid: "rotated-kid"
      })
    ).toHaveProperty("error");
    expect((await getAgent("apply-unauth"))?.cardSigningKid).toBe("test-kid");
  });

  it("the apply policy asks a human, naming both keys", async () => {
    const wsId = await freshWsId("apply-policy");
    const admin = ctx({ adminWorkspaces: [wsId] });
    await registerCustom(deps(wsId, admin), "apply-policy");
    const d = depsWithKid(wsId, admin, "rotated-kid");

    const status = await policyFor(
      d,
      "agents_repin_apply"
    )({
      name: "apply-policy",
      jku: JKU,
      kid: "rotated-kid"
    });

    expect(status.type).toBe("user-approval");
    // Both keys on screen: that is the whole basis for the decision.
    expect(status.reason).toContain("test-kid");
    expect(status.reason).toContain("rotated-kid");
  });

  it("the apply policy denies a no-op rather than spending an approval", async () => {
    const wsId = await freshWsId("apply-noop");
    const d = depsWithKid(wsId, ctx({ adminWorkspaces: [wsId] }), "test-kid");
    await registerCustom(d, "apply-noop");
    const row = await getAgent("apply-noop");

    const status = await policyFor(
      d,
      "agents_repin_apply"
    )({
      name: "apply-noop",
      jku: row?.cardSigningJku,
      kid: "test-kid"
    });

    expect(status.type).toBe("denied");
    expect(status.reason).toContain("nothing to change");
  });

  it("the apply policy denies a key the live card does not advertise", async () => {
    const wsId = await freshWsId("apply-stale");
    const admin = ctx({ adminWorkspaces: [wsId] });
    await registerCustom(deps(wsId, admin), "apply-stale");
    const d = depsWithKid(wsId, admin, "newer-kid");

    const status = await policyFor(
      d,
      "agents_repin_apply"
    )({
      name: "apply-stale",
      jku: JKU,
      kid: "rotated-kid"
    });

    expect(status.type).toBe("denied");
    expect(status.reason).toContain("newer-kid");
  });

  it("the apply policy denies a non-admin, with no prompt raised", async () => {
    const wsId = await freshWsId("apply-policy-unauth");
    await registerCustom(
      deps(wsId, ctx({ adminWorkspaces: [wsId] })),
      "apply-policy-unauth"
    );
    const d = depsWithKid(
      wsId,
      ctx({ adminWorkspaces: [wsId + 999] }),
      "rotated-kid"
    );

    const status = await policyFor(
      d,
      "agents_repin_apply"
    )({
      name: "apply-policy-unauth",
      jku: JKU,
      kid: "rotated-kid"
    });
    expect(status.type).toBe("denied");
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

  it("declares ask_user with no handler, so the turn pauses on the call itself", () => {
    const tools = buildAdminTools(deps(3, ctx({ adminWorkspaces: [3] })));
    expect(tools.ask_user).toBeDefined();
    expect(tools.ask_user.execute).toBeUndefined();
  });

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
        "agents_repin",
        "agents_repin_apply",
        "agents_allow_channel",
        "agents_revoke_channel",
        "agents_regenerate_avatar",
        "workspace_read"
      ])
    );
  });

  it("declares the gated tools with real handlers", () => {
    // They act for themselves now. What stops them acting unasked is the approval
    // policy, not a missing implementation.
    const tools = buildAdminTools(deps(3, ctx({ adminWorkspaces: [3] })));
    expect(tools.agents_delete.execute).toBeDefined();
    expect(tools.agents_repin_apply.execute).toBeDefined();
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
