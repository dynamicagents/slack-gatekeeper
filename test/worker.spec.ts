import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import worker from "../src/server";

describe("Worker routing", () => {
  it("returns 404 for GET /", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown paths", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/some-unknown-path"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it("routes POST /slack/events to the Slack webhook handler", async () => {
    // A missing-signature request reaching the handler proves routing works;
    // the full ingress pipeline is tested in slack-webhook-handler.spec.ts.
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "x" })
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    // No signature headers → 401 from the handler (proves routing reached it)
    expect(res.status).toBe(401);
  });

  it("serves a stored admin avatar with a long immutable cache", async () => {
    // Seed an avatar in the admin:0 DO, then fetch it through the public route.
    const stub = env.AdminAgent.get(env.AdminAgent.idFromName("admin:0"));
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
    const { key } = await stub.putIcon(data, "image/jpeg", "admin");

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`http://localhost/icons/0/admin/${key}.jpg`),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
    expect(res.headers.get("cache-control")).toContain("s-maxage=31536000");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...data]);
  });

  it("returns 404 for an unknown admin avatar key", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/icons/0/admin/deadbeefdeadbeef.jpg"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  // Regression: the /icons route must only forward the exact avatar shape
  // ({16-hex}.{ext}). A path with extra segments must NOT reach the admin DO,
  // otherwise it would fall through to the A2A handler and expose the
  // AgentCard (and any other GET the bridge serves) under the /icons prefix.
  it.each([
    "/icons/0/admin/.well-known/agent-card.json",
    "/icons/0/admin/deadbeefdeadbeef.jpg/extra",
    "/icons/0/admin/nothex.jpg",
    "/icons/0/admin/deadbeefdeadbeef"
  ])("returns 404 without forwarding non-avatar path %s", async (path) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`http://localhost${path}`),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("application/json");
  });

  describe("admin avatar icon index (sliding window pruning)", () => {
    it("keeps both icons when exactly ICON_KEEP (2) are stored", async () => {
      const stub = env.AdminAgent.get(env.AdminAgent.idFromName("admin:10"));
      const { key: k1 } = await stub.putIcon(
        new Uint8Array([0x01]),
        "image/jpeg",
        "admin"
      );
      const { key: k2 } = await stub.putIcon(
        new Uint8Array([0x02]),
        "image/jpeg",
        "admin"
      );
      expect(await stub.getIcon("admin", k1)).not.toBeNull();
      expect(await stub.getIcon("admin", k2)).not.toBeNull();
    });

    it("evicts the oldest icon when a 3rd distinct icon is stored", async () => {
      const stub = env.AdminAgent.get(env.AdminAgent.idFromName("admin:11"));
      const { key: k1 } = await stub.putIcon(
        new Uint8Array([0x0a]),
        "image/jpeg",
        "admin"
      );
      const { key: k2 } = await stub.putIcon(
        new Uint8Array([0x0b]),
        "image/jpeg",
        "admin"
      );
      const { key: k3 } = await stub.putIcon(
        new Uint8Array([0x0c]),
        "image/jpeg",
        "admin"
      );
      expect(await stub.getIcon("admin", k1)).toBeNull(); // pruned
      expect(await stub.getIcon("admin", k2)).not.toBeNull();
      expect(await stub.getIcon("admin", k3)).not.toBeNull();
    });

    it("deduplicates: storing the same bytes twice does not grow the index", async () => {
      const stub = env.AdminAgent.get(env.AdminAgent.idFromName("admin:12"));
      const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
      const { key: k1 } = await stub.putIcon(bytes, "image/jpeg", "admin");
      const { key: k2 } = await stub.putIcon(bytes, "image/jpeg", "admin");
      expect(k1).toBe(k2); // same content → same hash
      // A third distinct icon should only evict nothing (index length is still 1).
      const { key: k3 } = await stub.putIcon(
        new Uint8Array([0x01]),
        "image/jpeg",
        "admin"
      );
      expect(await stub.getIcon("admin", k1)).not.toBeNull(); // k1/k2 still alive (only 2 in index)
      expect(await stub.getIcon("admin", k3)).not.toBeNull();
    });

    it("prunes per agent: a custom agent's avatars don't evict the admin's own", async () => {
      const stub = env.AdminAgent.get(env.AdminAgent.idFromName("admin:13"));
      // The admin's own avatar under the "admin" name.
      const { key: self } = await stub.putIcon(
        new Uint8Array([0x10]),
        "image/jpeg",
        "admin"
      );
      // Three distinct avatars for a custom agent would blow past ICON_KEEP if
      // they shared the admin index — but they're keyed under the agent's name.
      await stub.putIcon(new Uint8Array([0x11]), "image/jpeg", "paint-agent");
      await stub.putIcon(new Uint8Array([0x12]), "image/jpeg", "paint-agent");
      const { key: a3 } = await stub.putIcon(
        new Uint8Array([0x13]),
        "image/jpeg",
        "paint-agent"
      );
      // Admin avatar survives; the custom agent's latest is still there.
      expect(await stub.getIcon("admin", self)).not.toBeNull();
      expect(await stub.getIcon("paint-agent", a3)).not.toBeNull();
      // Bytes are namespaced by name: the admin's key does not resolve under the
      // custom agent's namespace, even though they live in the same DO.
      expect(await stub.getIcon("paint-agent", self)).toBeNull();
    });
  });

  it("serves the gatekeeper public JWKS at /.well-known/jwks.json", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/.well-known/jwks.json"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age");
    const body = (await res.json()) as {
      keys: Array<{ kty: string; crv: string; kid: string; d?: string }>;
    };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    // Never leak the private scalar.
    expect(body.keys[0].d).toBeUndefined();
    expect(body.keys[0].kid).toBeTruthy();
  });
});
