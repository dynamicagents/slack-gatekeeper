import { describe, it, expect, afterEach, vi } from "vitest";
import { decodeProtectedHeader, jwtVerify, type JWK } from "jose";
import {
  IDENTITY_CLAIM,
  getPublicJwks,
  signGatekeeperToken
} from "@/auth/agent-outbound";
import { audienceFor } from "@/a2a/endpoint";
import { importGatekeeperPublicKey } from "../helpers/auth";

const AUD = "https://agent.example.com";
/** Which agent at `AUD` the token authorizes — required on every mint. */
const TENANT = "main";
const PUBLIC_URL = "https://gatekeeper.test";
const EXPECTED_JKU = `${PUBLIC_URL}/.well-known/jwks.json`;

afterEach(() => {
  vi.useRealTimers();
});

describe("getPublicJwks", () => {
  it("publishes only the public Ed25519 key (no private scalar)", () => {
    const { keys } = getPublicJwks();
    expect(keys).toHaveLength(1);
    const k = keys[0] as JWK & { d?: string };
    expect(k.kty).toBe("OKP");
    expect(k.crv).toBe("Ed25519");
    expect(k.alg).toBe("EdDSA");
    expect(k.use).toBe("sig");
    expect(k.kid).toBeTruthy();
    expect(k.d).toBeUndefined();
    expect(k.x).toBeTruthy();
  });
});

describe("signGatekeeperToken", () => {
  it("round-trips: verifies against the public JWKS with correct claims", async () => {
    const token = await signGatekeeperToken({
      audience: AUD,
      issuer: PUBLIC_URL,
      tenant: TENANT,
      identity: {
        key: "custom:7:analytics",
        name: "analytics",
        kind: "remote",
        workspaceId: 7
      }
    });

    // The protected header must carry jku pointing at our JWKS (RFC 7515 §4.1.2).
    const header = decodeProtectedHeader(token) as {
      jku?: string;
      kid?: string;
    };
    expect(header.jku).toBe(EXPECTED_JKU);
    expect(header.kid).toBeTruthy();

    const { payload } = await jwtVerify(
      token,
      await importGatekeeperPublicKey(),
      {
        issuer: PUBLIC_URL,
        audience: AUD,
        algorithms: ["EdDSA"]
      }
    );
    expect(payload.iss).toBe(PUBLIC_URL);
    expect(payload.aud).toBe(AUD);
    expect(payload.sub).toBe("custom:7:analytics");
    expect(payload.jti).toBeTruthy();
    const identity = payload[IDENTITY_CLAIM] as Record<string, unknown>;
    expect(identity).toMatchObject({
      key: "custom:7:analytics",
      name: "analytics",
      kind: "remote",
      workspaceId: 7
    });
  });

  it("carries gatekeeper-agent identity only, not user auth fields", async () => {
    const token = await signGatekeeperToken({
      audience: AUD,
      issuer: PUBLIC_URL,
      tenant: TENANT,
      identity: {
        key: "custom:0:shared-endpoint",
        name: "shared-endpoint",
        kind: "remote",
        workspaceId: 0
      }
    });
    const { payload } = await jwtVerify(
      token,
      await importGatekeeperPublicKey(),
      {
        issuer: PUBLIC_URL,
        audience: AUD,
        algorithms: ["EdDSA"]
      }
    );
    const identity = payload[IDENTITY_CLAIM] as Record<string, unknown>;
    expect(identity).not.toHaveProperty("slackUserId");
    expect(identity).not.toHaveProperty("displayName");
    expect(identity.workspaceId).toBe(0);
  });

  it("rejects a token presented to the wrong audience", async () => {
    const token = await signGatekeeperToken({
      audience: AUD,
      issuer: PUBLIC_URL,
      tenant: TENANT,
      identity: {
        key: "custom:0:demo",
        name: "demo",
        kind: "remote",
        workspaceId: 0
      }
    });
    await expect(
      jwtVerify(token, await importGatekeeperPublicKey(), {
        issuer: PUBLIC_URL,
        audience: "https://someone-else.example.com",
        algorithms: ["EdDSA"]
      })
    ).rejects.toThrow();
  });

  describe("the endpoint-scoped audience dispatch mints", () => {
    /**
     * Checked from the *agent's* side rather than by inspecting the claim, since
     * what matters is which verifiers accept the token.
     *
     * This is the breaking half of the change: the token names one agent's exact
     * endpoint, so a sibling on the same host rejects it — and so does anything
     * still verifying the bare origin, which is why the gatekeeper and its
     * registered agents have to deploy together.
     */
    const ORIGIN = "https://agent.example.com";
    const ENDPOINT = `${ORIGIN}/proactive/a2a`;

    const verifyAs = async (audience: string) => {
      const token = await signGatekeeperToken({
        audience: audienceFor(ENDPOINT),
        issuer: PUBLIC_URL,
        tenant: TENANT,
        identity: {
          key: "custom:7:analytics",
          name: "analytics",
          kind: "remote",
          workspaceId: 7
        }
      });
      return jwtVerify(token, await importGatekeeperPublicKey(), {
        issuer: PUBLIC_URL,
        audience,
        algorithms: ["EdDSA"]
      });
    };

    it("is accepted by the agent at that endpoint", async () => {
      await expect(verifyAs(ENDPOINT)).resolves.toBeDefined();
    });

    it("is rejected by a sibling agent on the same origin", async () => {
      // The reason for the whole change: under an origin-only audience this
      // verified, and one agent could spend another's token.
      await expect(verifyAs(`${ORIGIN}/reactive/a2a`)).rejects.toThrow();
    });

    it("is rejected by anything verifying the bare origin", async () => {
      // The breaking half, asserted rather than left implicit: an agent on
      // @dynamicagents/core < 0.2.0 will refuse these tokens.
      await expect(verifyAs(ORIGIN)).rejects.toThrow();
    });

    it("is rejected by an unrelated host", async () => {
      await expect(
        verifyAs("https://someone-else.example.com")
      ).rejects.toThrow();
    });
  });

  it("rejects a tampered signature", async () => {
    const token = await signGatekeeperToken({
      audience: AUD,
      issuer: PUBLIC_URL,
      tenant: TENANT,
      identity: {
        key: "custom:0:demo",
        name: "demo",
        kind: "remote",
        workspaceId: 0
      }
    });
    const [h, p, s] = token.split(".");
    const flipped = s[0] === "A" ? "B" : "A";
    const tampered = `${h}.${p}.${flipped}${s.slice(1)}`;
    await expect(
      jwtVerify(tampered, await importGatekeeperPublicKey(), {
        issuer: PUBLIC_URL,
        audience: AUD,
        algorithms: ["EdDSA"]
      })
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const token = await signGatekeeperToken({
      audience: AUD,
      issuer: PUBLIC_URL,
      tenant: TENANT,
      identity: {
        key: "custom:0:demo",
        name: "demo",
        kind: "remote",
        workspaceId: 0
      }
    });
    // Advance past the 120s TTL.
    vi.setSystemTime(new Date("2025-01-01T00:05:00Z"));
    await expect(
      jwtVerify(token, await importGatekeeperPublicKey(), {
        issuer: PUBLIC_URL,
        audience: AUD,
        algorithms: ["EdDSA"]
      })
    ).rejects.toThrow();
  });
});
