import {
  importJWK,
  jwtVerify,
  decodeProtectedHeader,
  type JWK,
  type JWTPayload
} from "jose";
import { A2A_JWS_ALG } from "@dynamicagents/g2a-protocol";
import { resolveSigningKey } from "@/a2a/card-verify";

/** The pinned signing identity of a remote agent, from its registry row. */
export interface CallbackVerifyPin {
  cardSigningJku: string;
  cardSigningKid: string;
}

/** Thrown when a remote agent's push-notification callback token fails verification. */
export class AgentCallbackAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCallbackAuthError";
  }
}

/**
 * Verify a remote agent's push-notification callback JWT (A2A spec §13.2). The
 * token MUST be signed by the agent's already-pinned AgentCard key: the protected
 * header's `jku`/`kid` must exactly equal the registry pin (the Trust-On-First-Use
 * anchor), so a validly-signed token from any *other* key is rejected. Standard
 * claims are enforced too — `aud` must equal our webhook URL, and `iat`/`exp` must
 * be fresh (short max age + small clock tolerance).
 *
 * This authenticates the caller; durable single-use is enforced separately by the
 * caller atomically flipping the `agent_tasks` row (`completeAgentTask`), which
 * dedupes replays across isolates. Returns the verified claims on success.
 *
 * Throws {@link AgentCallbackAuthError} on any mismatch.
 */
export async function verifyAgentCallbackToken(args: {
  token: string;
  pin: CallbackVerifyPin;
  /** The webhook URL the token's `aud` must match. */
  audience: string;
  /** Org-approved domains — SSRF guard when resolving the pinned JWKS. */
  allowedDomains: string[];
}): Promise<JWTPayload> {
  const { token, pin, audience, allowedDomains } = args;

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new AgentCallbackAuthError("callback token is not a valid JWS");
  }
  if (header.alg !== A2A_JWS_ALG) {
    throw new AgentCallbackAuthError(
      `unexpected alg '${header.alg ?? "none"}'`
    );
  }
  // TOFU: the token must be signed by the exact key pinned at registration.
  if (header.jku !== pin.cardSigningJku || header.kid !== pin.cardSigningKid) {
    throw new AgentCallbackAuthError(
      "callback token key does not match the agent's pinned signing key"
    );
  }

  let jwk: JWK;
  try {
    jwk = await resolveSigningKey(
      pin.cardSigningJku,
      pin.cardSigningKid,
      allowedDomains
    );
  } catch (err) {
    throw new AgentCallbackAuthError(
      `could not resolve pinned signing key: ${(err as Error).message}`
    );
  }

  const key = await importJWK(jwk, A2A_JWS_ALG);
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [A2A_JWS_ALG],
      audience,
      clockTolerance: 60,
      maxTokenAge: "10 minutes"
    });
    return payload;
  } catch (err) {
    throw new AgentCallbackAuthError(
      `callback token verification failed: ${(err as Error).message}`
    );
  }
}
