import { vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { getPublicJwks } from "@/auth/agent-outbound";

export interface TestKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export async function makeKey(kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  return { privateKey, publicJwk };
}

/** Stubs global fetch to serve a JWKS at `jku` with the given keys; 404s everything else. */
export function stubJwks(jku: string, keys: JWK[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === jku) {
      return new Response(JSON.stringify({ keys }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Signs an EdDSA JWT with the given key and claim/header values. */
export async function signJwt(
  key: TestKey,
  opts: {
    kid?: string;
    jku: string;
    sub: string;
    aud: string;
    iatOffsetSec?: number;
    expiresIn?: string;
  }
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) + (opts.iatOffsetSec ?? 0);
  return new SignJWT({})
    .setProtectedHeader({
      alg: "EdDSA",
      kid: opts.kid ?? (key.publicJwk.kid as string),
      jku: opts.jku
    })
    .setSubject(opts.sub)
    .setAudience(opts.aud)
    .setIssuedAt(iat)
    .setExpirationTime(opts.expiresIn ?? "2m")
    .sign(key.privateKey);
}

/** Imports the gatekeeper's own public Ed25519 key from the public JWKS. */
export async function importGatekeeperPublicKey() {
  const { keys } = getPublicJwks();
  return importJWK(keys[0], "EdDSA");
}
