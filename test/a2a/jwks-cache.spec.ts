import { describe, it, expect, afterEach, vi } from "vitest";
import { FlattenedSign, type JWK } from "jose";
import type { AgentCard } from "@a2a-js/sdk";
import { buildAgentCard } from "@/a2a/card";
import {
  canonicalCardPayload,
  resolveSigningKey,
  verifyRemoteAgentEndpoint
} from "@/a2a/card-verify";
import { InvalidEndpointError } from "@/a2a/endpoint";
import { makeKey, type TestKey } from "../helpers/auth";

/**
 * The JWKS cache in front of {@link resolveSigningKey}.
 *
 * Every push-notification callback verifies against the remote's pinned JWKS,
 * and a task reports non-terminal status many times before it finishes — so
 * uncached, each POST paid for a full HTTPS round-trip to the remote before any
 * of its own work started. These assert the cache removes those fetches
 * *without* removing anything the fetch was carrying: the allowlist still runs,
 * a rotated key is still picked up immediately, and a key that is genuinely
 * absent is still refused.
 *
 * The counter is the point of most of these. An assertion that the right key
 * came back passes just as well with no cache at all; what distinguishes the
 * implementations is how many times `fetch` was called to produce it.
 *
 * `Date.now` is stubbed rather than advanced, because the cache reads the clock
 * and a Worker's clock only moves on I/O — there is no real elapsed time to
 * wait for inside a test that never performs any.
 */

const JKU = "https://agent.example.com/.well-known/jwks.json";
const DOMAINS = ["agent.example.com"];
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Freeze the clock at an absolute instant. */
function clockAt(ms: number): void {
  vi.spyOn(Date, "now").mockReturnValue(ms);
}

/**
 * Let a not-awaited background refresh finish. Stale-while-revalidate returns
 * before its fetch does, deliberately, so the test has to yield for it.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

interface JwksServer {
  /** Mutable so a test can rotate the published key set mid-flight. */
  keys: JWK[];
  /** When set, the endpoint answers 500 — an outage, not a key change. */
  fail: boolean;
  /** How many times the JWKS itself was fetched. */
  calls: number;
}

/** Serve a JWKS at {@link JKU}, counting fetches and 404ing everything else. */
function stubJwksServer(keys: JWK[]): JwksServer {
  const server: JwksServer = { keys, fail: false, calls: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url !== JKU) return new Response("not found", { status: 404 });
      server.calls += 1;
      if (server.fail) return new Response("unavailable", { status: 503 });
      return Response.json({ keys: server.keys });
    })
  );
  return server;
}

describe("JWKS cache", () => {
  it("answers a second resolve without a second fetch", async () => {
    clockAt(T0);
    const key = await makeKey("k1");
    const server = stubJwksServer([key.publicJwk]);

    const first = await resolveSigningKey(JKU, "k1", DOMAINS);
    const second = await resolveSigningKey(JKU, "k1", DOMAINS);

    expect(server.calls).toBe(1);
    expect(second.x).toBe(first.x);
  });

  it("coalesces concurrent cold-cache resolves into one fetch", async () => {
    clockAt(T0);
    const key = await makeKey("k1");
    const server = stubJwksServer([key.publicJwk]);

    // The stampede a cold isolate sees when a task's callbacks arrive together.
    const resolved = await Promise.all(
      Array.from({ length: 8 }, () => resolveSigningKey(JKU, "k1", DOMAINS))
    );

    expect(server.calls).toBe(1);
    expect(resolved.every((k) => k.x === key.publicJwk.x)).toBe(true);
  });

  it("picks up a rotated key immediately instead of waiting out the TTL", async () => {
    // The case that decides whether caching is safe at all: the remote publishes
    // a new `kid` and signs with it. A cache that answered from what it had
    // would reject every callback until the entry expired.
    clockAt(T0);
    const first = await makeKey("k1");
    const rotated = await makeKey("k2");
    const server = stubJwksServer([first.publicJwk]);

    await resolveSigningKey(JKU, "k1", DOMAINS);
    expect(server.calls).toBe(1);

    server.keys = [first.publicJwk, rotated.publicJwk];
    const key = await resolveSigningKey(JKU, "k2", DOMAINS);

    expect(key.x).toBe(rotated.publicJwk.x);
    expect(server.calls).toBe(2);

    // …and the refreshed set is what is cached now, so the new key is free too.
    await resolveSigningKey(JKU, "k2", DOMAINS);
    expect(server.calls).toBe(2);
  });

  it("still refuses a kid the refreshed JWKS does not have", async () => {
    clockAt(T0);
    const key = await makeKey("k1");
    const server = stubJwksServer([key.publicJwk]);
    await resolveSigningKey(JKU, "k1", DOMAINS);

    await expect(resolveSigningKey(JKU, "ghost", DOMAINS)).rejects.toThrow(
      /signing key 'ghost' not found in JWKS/
    );

    // One forced refresh, then the same refusal as before the cache existed —
    // the unknown `kid` costs exactly the one fetch it always cost, never more.
    expect(server.calls).toBe(2);
  });

  it("serves a stale entry past the TTL while it refreshes behind it", async () => {
    clockAt(T0);
    const original = await makeKey("k1");
    const replaced = await makeKey("k1"); // same kid, new key material
    const server = stubJwksServer([original.publicJwk]);

    await resolveSigningKey(JKU, "k1", DOMAINS);
    server.keys = [replaced.publicJwk];

    clockAt(T0 + 6 * MINUTE);
    const stale = await resolveSigningKey(JKU, "k1", DOMAINS);

    // Answered from the stale copy — the caller did not wait on the refresh.
    expect(stale.x).toBe(original.publicJwk.x);
    expect(server.calls).toBe(2);

    await settle();
    const refreshed = await resolveSigningKey(JKU, "k1", DOMAINS);
    expect(refreshed.x).toBe(replaced.publicJwk.x);
    expect(server.calls).toBe(2); // the refresh re-armed the TTL
  });

  it("keeps serving the stale entry when the refresh fails", async () => {
    // A JWKS endpoint that is briefly down must not take the remote's callbacks
    // down with it: a key that verified a minute ago did not stop being valid
    // because its server stopped answering.
    clockAt(T0);
    const key = await makeKey("k1");
    const server = stubJwksServer([key.publicJwk]);
    await resolveSigningKey(JKU, "k1", DOMAINS);

    server.fail = true;
    clockAt(T0 + 6 * MINUTE);
    const stale = await resolveSigningKey(JKU, "k1", DOMAINS);
    await settle();

    expect(stale.x).toBe(key.publicJwk.x);
    // The failure is not cached, so the entry stands and the next call retries.
    const again = await resolveSigningKey(JKU, "k1", DOMAINS);
    await settle();
    expect(again.x).toBe(key.publicJwk.x);
  });

  it("stops serving an entry once it is stale beyond the outage window", async () => {
    clockAt(T0);
    const original = await makeKey("k1");
    const replaced = await makeKey("k1");
    const server = stubJwksServer([original.publicJwk]);
    await resolveSigningKey(JKU, "k1", DOMAINS);
    server.keys = [replaced.publicJwk];

    clockAt(T0 + 61 * MINUTE);
    const key = await resolveSigningKey(JKU, "k1", DOMAINS);

    // Past an hour the caller waits for the real answer rather than getting a
    // guess, so this is the fetched key, not the expired one.
    expect(key.x).toBe(replaced.publicJwk.x);
    expect(server.calls).toBe(2);
  });

  it("fails the fetch rather than the cache when the JWKS is unreachable", async () => {
    clockAt(T0);
    const server = stubJwksServer([]);
    server.fail = true;

    await expect(resolveSigningKey(JKU, "k1", DOMAINS)).rejects.toThrow(
      /returned HTTP 503/
    );
    expect(server.calls).toBe(1);
  });

  it("re-runs the SSRF allowlist on every call, cached or not", async () => {
    // The cache is keyed by URL and shared across orgs; approval is neither. A
    // hit that skipped this check would be a way to read a JWKS from a domain
    // the caller's org never approved.
    clockAt(T0);
    const key = await makeKey("k1");
    const server = stubJwksServer([key.publicJwk]);
    await resolveSigningKey(JKU, "k1", DOMAINS);
    expect(server.calls).toBe(1);

    await expect(
      resolveSigningKey(JKU, "k1", ["other.example.com"])
    ).rejects.toThrow(InvalidEndpointError);
    await expect(resolveSigningKey(JKU, "k1", [])).rejects.toThrow(
      InvalidEndpointError
    );

    // Rejected on the way in — nothing was fetched, and nothing was served.
    expect(server.calls).toBe(1);
  });

  it("does not let a cached entry stand in for an unapproved host", async () => {
    clockAt(T0);
    const key = await makeKey("k1");
    stubJwksServer([key.publicJwk]);

    // Never approved, never fetched, never cached — and still refused when the
    // host it happens to share a scheme with is.
    await expect(
      resolveSigningKey(
        "https://elsewhere.example.com/.well-known/jwks.json",
        "k1",
        DOMAINS
      )
    ).rejects.toThrow(InvalidEndpointError);
  });

  it("evicts the least recently fetched entry rather than growing forever", async () => {
    // An approved provider chooses the `jku` *path*, so the key space is not
    // bounded by the number of registered agents. Past the bound the oldest
    // fetch is dropped, which costs a re-fetch and nothing else.
    clockAt(T0);
    const key = await makeKey("k1");
    const calls = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.set(url, (calls.get(url) ?? 0) + 1);
        return Response.json({ keys: [key.publicJwk] });
      })
    );

    const at = (n: number) => `https://agent.example.com/jwks/${n}.json`;
    // One past the 64-entry bound, so the first URL is the one evicted.
    for (let n = 0; n <= 64; n += 1) {
      await resolveSigningKey(at(n), "k1", DOMAINS);
    }

    await resolveSigningKey(at(0), "k1", DOMAINS);
    expect(calls.get(at(0))).toBe(2);

    // The survivors are still hits — eviction is bounded, not a flush.
    await resolveSigningKey(at(64), "k1", DOMAINS);
    expect(calls.get(at(64))).toBe(1);
  });
});

/**
 * Registration reads two cards and verifies both signatures, and each
 * verification resolves the signing key — so before the cache one
 * human-approved re-pin cost four round-trips: the two card fetches, and two
 * fetches of the same JWKS URL behind them. The cache can only remove the
 * second kind; a card is read fresh every time by design.
 */
describe("registration fetch count", () => {
  const ENDPOINT = "https://agent.example.com/a2a";

  function baseCard(): AgentCard {
    return buildAgentCard({
      name: "Example",
      description: "test agent",
      url: ENDPOINT
    });
  }

  async function signCard(card: AgentCard, key: TestKey): Promise<AgentCard> {
    const payload = new TextEncoder().encode(canonicalCardPayload(card));
    const jws = await new FlattenedSign(payload)
      .setProtectedHeader({
        alg: "EdDSA",
        kid: key.publicJwk.kid as string,
        typ: "JOSE",
        jku: JKU
      })
      .sign(key.privateKey);
    return {
      ...card,
      signatures: [{ protected: jws.protected, signature: jws.signature }]
    } as AgentCard;
  }

  const tenantCard = (tenant: string): AgentCard => ({
    ...baseCard(),
    name: "Reactive Agent",
    supportedInterfaces: [
      { ...baseCard().supportedInterfaces[0], url: ENDPOINT, tenant }
    ]
  });

  it("resolves the whole registration on one JWKS fetch", async () => {
    clockAt(T0);
    const key = await makeKey("k1");
    const stub = await signCard(baseCard(), key);
    const extended = await signCard(tenantCard("reactive"), key);
    const counts = { jwks: 0 };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        if (request.url === JKU) {
          counts.jwks += 1;
          return Response.json({ keys: [key.publicJwk] });
        }
        if (request.method === "GET") return Response.json(stub);
        return Response.json({ jsonrpc: "2.0", id: 1, result: extended });
      })
    );

    const verified = await verifyRemoteAgentEndpoint({
      url: "https://agent.example.com",
      tenantId: "reactive",
      allowedDomains: DOMAINS,
      authToken: async () => "gw-token"
    });

    expect(verified.pin).toEqual({
      cardSigningJku: JKU,
      cardSigningKid: "k1"
    });
    expect(counts.jwks).toBe(1);
  });
});
