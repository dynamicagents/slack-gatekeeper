import { SignJWT, importJWK, type JWK } from "jose";
import { env } from "cloudflare:workers";
import {
  A2A_JWS_ALG,
  gatekeeperTokenClaims,
  jwksUrl,
  type RemoteIdentity
} from "@dynamicagents/g2a-protocol";

/**
 * Gateway outbound identity for remote (custom) A2A agents.
 *
 * Zero-trust, no shared secrets: the gateway holds an Ed25519 private key and
 * publishes only the matching *public* JWKS (see `getPublicJwks` +
 * `/.well-known/jwks.json`). When dispatching to a remote agent it mints a
 * short-lived signed JWT; the remote verifies it against the public JWKS. This
 * proves "this request really came from the gateway" (the remote authenticates
 * the caller, A2A spec §7.4) and carries the calling gateway-agent instance in
 * tamper-proof claims — so endpoint sharing never aliases two logical agents.
 *
 * Algorithm is **EdDSA (Ed25519)**. The private key is a JWK stored in the
 * `GATEWAY_JWT_PRIVATE_KEY` secret; its `kid` identifies the key for rotation.
 */

/**
 * The claim names and the algorithm come from `@dynamicagents/g2a-protocol`.
 *
 * They used to be declared here and again in `@dynamicagents/core`, each with a
 * comment saying it must match the other, because the gateway deliberately does
 * **not** import core — core is the agent runtime, and a gateway is not an
 * agent. That comment was the whole mechanism, and it failed: one side moved to
 * the `dynamicagents.dev` namespace while the other still minted
 * `https://looping.ai/tenant`, the remote read an empty tenant, and every
 * request 401'd with both builds green.
 *
 * The protocol package is the shared artifact that rule permits — zero
 * dependencies, no crypto, no agent runtime, so depending on it commits this
 * gateway to nothing. The rule itself is unchanged and still absolute: **the
 * gateway must never import `@dynamicagents/core`.**
 *
 * Re-exported so this module stays the place the rest of the gateway imports
 * them from.
 */
export { IDENTITY_CLAIM, TENANT_CLAIM } from "@dynamicagents/g2a-protocol";

/** Token lifetime — short, since each dispatch mints a fresh one. */
const TOKEN_TTL_SECONDS = 120;

/**
 * Stable identity of the logical gateway-agent instance making a remote call.
 * Derived from the registered agent row, not from the endpoint URL, so two
 * distinct agents can safely share one remote service.
 *
 * From the protocol package, where it is the **minted** half of the pair: every
 * field required, because an issuer knows all of them. The remote parses the
 * same claim into a `GatekeeperIdentity` with every field optional, since a
 * signature proves a payload was not altered and never that it was well-formed.
 * That asymmetry is asserted at the type level over there, so this staying
 * assignable to what the remote accepts is checked rather than assumed.
 */
export type { RemoteIdentity };

interface SignGatekeeperTokenArgs {
  /**
   * Intended recipient — the remote agent's **exact endpoint**, not its origin.
   * See `audienceFor` in {@link file://../a2a/endpoint.ts}.
   */
  audience: string;
  /**
   * This gateway's public origin — stored in D1 by the fetch isolate on first
   * request and passed in here so Workflow context (no `Request`) can sign correctly.
   */
  issuer: string;
  /** Stable gateway-agent identity embedded under {@link IDENTITY_CLAIM}. */
  identity: RemoteIdentity;
  /**
   * Which agent at `audience` this token authorizes, under {@link TENANT_CLAIM}.
   *
   * Load-bearing rather than informational. A host serves several agents over
   * one endpoint, so they share an `aud` and the audience cannot tell them
   * apart — this claim is the only thing that can. The remote compares it
   * against the tenant the request body addressed and refuses a mismatch, which
   * is what stops a token minted for one agent being replayed against a sibling
   * by editing a field in the body.
   */
  tenant: string;
}

/** Parse + validate the configured private JWK (throws if misconfigured). */
function privateJwk(): JWK & { kid: string } {
  const raw = env.GATEWAY_JWT_PRIVATE_KEY;
  if (!raw) {
    throw new Error("GATEWAY_JWT_PRIVATE_KEY is not configured");
  }
  let jwk: JWK;
  try {
    jwk = JSON.parse(raw) as JWK;
  } catch {
    throw new Error("GATEWAY_JWT_PRIVATE_KEY is not valid JSON");
  }
  if (!jwk.kid) {
    throw new Error("GATEWAY_JWT_PRIVATE_KEY must include a `kid`");
  }
  if (!jwk.d) {
    throw new Error(
      "GATEWAY_JWT_PRIVATE_KEY must be a private key (missing `d`)"
    );
  }
  return jwk as JWK & { kid: string };
}

/**
 * Mint a short-lived gateway identity JWT for one remote dispatch. Signed with
 * EdDSA; carries `iss`/`aud`/`sub`/`iat`/`exp`/`jti` plus the gateway-agent
 * identity and tenant claims. The remote agent verifies it against the
 * gateway's public JWKS.
 */
export async function signGatekeeperToken(
  args: SignGatekeeperTokenArgs
): Promise<string> {
  const jwk = privateJwk();
  const { issuer } = args;
  const key = await importJWK(jwk, A2A_JWS_ALG);

  // A tokenless tenant would be verified by the remote as "authorizes no
  // tenant" and refused on every request, so fail here where the cause is
  // visible instead of at the far end of an HTTP hop.
  if (!args.tenant) {
    throw new Error(
      `refusing to sign a gateway token with no tenant for '${args.audience}'`
    );
  }

  return (
    // The claim keys are spelled by the package that owns them rather than
    // here, so the shape the remote parses and the shape this builds cannot
    // drift apart field by field.
    new SignJWT(gatekeeperTokenClaims(args.identity, args.tenant))
      // jku (RFC 7515 §4.1.2): the URL of our public JWKS, embedded in the token so
      // remote agents can locate the verification key without separate configuration.
      .setProtectedHeader({
        alg: A2A_JWS_ALG,
        kid: jwk.kid,
        typ: "JWT",
        jku: jwksUrl(issuer)
      })
      .setIssuer(issuer)
      .setSubject(args.identity.key)
      .setAudience(args.audience)
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
      .setJti(crypto.randomUUID())
      .sign(key)
  );
}

/**
 * The gateway's public JWKS — the only key material ever exposed. Derived from
 * the configured private JWK by dropping the private component (`d`). Served at
 * `/.well-known/jwks.json` for remote agents to fetch and cache.
 */
export function getPublicJwks(): { keys: JWK[] } {
  const jwk = privateJwk();
  // Strip the private scalar; publish only the public point.
  const { d: _d, ...pub } = jwk;
  void _d;
  return { keys: [{ ...pub, use: "sig", alg: A2A_JWS_ALG }] };
}
