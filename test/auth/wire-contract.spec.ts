import { describe, it, expect } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  A2A_JWS_ALG,
  endpointUrl,
  jwksUrl,
  readIdentityClaim,
  readTenantClaim
} from "@dynamicagents/g2a-protocol";
import gatewayPkg from "../../package.json";
import protocolPkg from "@dynamicagents/g2a-protocol/package.json";
import { signGatekeeperToken } from "@/auth/agent-outbound";
import { audienceFor } from "@/a2a/endpoint";

/**
 * The wire contract with a remote agent — now a **conformance test**.
 *
 * ## What changed, and why this file still exists
 *
 * These values used to be asserted here as literals, because the other half of
 * the contract lived in `@dynamicagents/core` and the gateway must not import it.
 * That made this file the only mechanism holding the two repos together, and a
 * weak one: it could prove the gateway was self-consistent, never that the
 * remote agreed.
 *
 * Both sides now derive the contract from `@dynamicagents/g2a-protocol`, so drift
 * is no longer possible by construction and pinning the strings again here
 * would test nothing — the package's own specs pin them, once, at the source.
 *
 * What is left is the part that is still genuinely two-sided: **that the
 * gateway actually uses the shared package everywhere it mints.** A token can
 * be built with a hand-written claim key, a hardcoded `jku`, or a hand-rolled
 * audience and still look perfectly correct in isolation. So every assertion
 * below reads the minted artifact and checks it against the package, rather
 * than against a copy of what the package says.
 *
 * The rule that produced all of this is unchanged and still absolute: **the
 * gateway never imports `@dynamicagents/core`.** The protocol package is a
 * zero-dependency leaf holding names and pure string rules — no crypto, no
 * verification logic, no agent runtime.
 */

const AGENT_ORIGIN = "https://agent.example.com";
const ENDPOINT = endpointUrl(AGENT_ORIGIN);
const ISSUER = "https://gw.example.com";

const IDENTITY = {
  key: "remote:7:analytics",
  name: "Analytics",
  kind: "remote",
  workspaceId: 7
};

async function mint(
  overrides: Partial<Parameters<typeof signGatekeeperToken>[0]> = {}
) {
  return signGatekeeperToken({
    audience: audienceFor(ENDPOINT),
    issuer: ISSUER,
    identity: IDENTITY,
    tenant: "reactive",
    ...overrides
  });
}

describe("a minted token, read back through the protocol package", () => {
  it("carries both claims where the package says to look for them", async () => {
    // Read with the package's own readers — the same ones `@dynamicagents/core`
    // verifies with. If the gateway ever spelled a claim key by hand and got it
    // wrong, these come back empty, which is exactly what the remote would see.
    const payload = decodeJwt(await mint()) as Record<string, unknown>;

    expect(readTenantClaim(payload)).toBe("reactive");
    expect(readIdentityClaim(payload)).toEqual(IDENTITY);
  });

  it("signs with the one algorithm every verifier pins", async () => {
    const header = decodeProtectedHeader(await mint());
    expect(header.alg).toBe(A2A_JWS_ALG);
  });

  it("advertises its keys where the package says they live", async () => {
    // RFC 7515 §4.1.2. The remote validates this origin against its allowlist
    // *before* fetching, so a `jku` composed by hand here is a key-resolution
    // failure at the far end of an HTTP hop.
    const header = decodeProtectedHeader(await mint());
    expect(header.jku).toBe(jwksUrl(ISSUER));
    expect(header.kid).toBeTruthy();
  });

  it("addresses the endpoint, not the origin", async () => {
    // Every tenant of a deployment shares one endpoint and therefore one
    // audience; the tenant claim above is what separates them. Minting
    // `aud: origin` against an agent that advertises `origin + /a2a` is a 401
    // on every request, and the message names the audience rather than the
    // mistake.
    const payload = decodeJwt(await mint());
    expect(payload.aud).toBe(ENDPOINT);
    expect(payload.aud).not.toBe(AGENT_ORIGIN);
    expect(payload.iss).toBe(ISSUER);
  });

  it("refuses to sign without a tenant, rather than minting an unusable token", async () => {
    // A tenant-less token is read by the remote as "authorizes no tenant" and
    // refused on every request. Failing here puts the error where the cause is
    // visible.
    await expect(mint({ tenant: "" })).rejects.toThrow(/tenant/);
  });
});

describe("the audience rule, on both sides of it", () => {
  it("is a fixed point over the URL an agent's card advertises", async () => {
    // The load-bearing relationship. A remote composes its card's interface URL
    // with `endpointUrl` and verifies incoming tokens against that same string;
    // the gateway reads that URL off the card and mints `aud` from it with
    // `audienceFor`. The two agree only if this holds for every path.
    for (const path of ["/a2a", "/api/v2/agent", "/", "/deep/nested/rpc"]) {
      const advertised = endpointUrl(AGENT_ORIGIN, path);
      expect(audienceFor(advertised)).toBe(advertised);
    }
  });

  it("survives the decoration a stored endpoint picks up", async () => {
    // The two sides store the endpoint in different systems. Rebuilding from
    // `origin + pathname` is what makes them produce one string anyway.
    const payload = decodeJwt(
      await mint({ audience: audienceFor(`${ENDPOINT}?x=1#frag`) })
    );
    expect(payload.aud).toBe(ENDPOINT);
  });
});

describe("the boundary that made a shared package possible", () => {
  /** Everything a manifest can pull into a tree, including at dev time. */
  const EVERY_FIELD = [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
    "devDependencies"
  ] as const;

  /** …and the subset that reaches a *consumer's* tree. */
  const INSTALLED_FIELDS = EVERY_FIELD.slice(0, 3);

  const namesIn = (pkg: object, fields: readonly string[]) =>
    fields.flatMap((f) =>
      Object.keys(
        ((pkg as Record<string, unknown>)[f] as Record<string, string>) ?? {}
      )
    );

  it("never depends on the agent runtime", () => {
    // The rule everything here rests on: `@dynamicagents/core` is the agent
    // runtime, a gateway is not an agent, and it must never import core. It was
    // a review convention; the shared package makes it tempting to relax
    // ("we already share one thing"), so it is a test now — dev dependencies
    // included, since a test importing the runtime reaches it just as surely.
    expect(namesIn(gatewayPkg, EVERY_FIELD)).not.toContain(
      "@dynamicagents/core"
    );
    expect(namesIn(gatewayPkg, EVERY_FIELD)).toContain(
      "@dynamicagents/g2a-protocol"
    );
  });

  it("shares only a package that installs nothing", () => {
    // Sharing the contract is acceptable *because* what is shared costs
    // nothing. If the protocol package ever grows a dependency it stops being a
    // leaf and becomes a channel the runtime could arrive through.
    //
    // Note this passes at the type level too: `protocolPkg` is imported as
    // JSON, so TypeScript infers the manifest's exact shape, and it has no
    // `dependencies` key at all for `namesIn` to read.
    expect(namesIn(protocolPkg, INSTALLED_FIELDS)).toEqual([]);
  });
});
