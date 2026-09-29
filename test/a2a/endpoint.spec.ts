import { describe, it, expect } from "vitest";
import {
  audienceFor,
  InvalidEndpointError,
  originOf,
  SHARED_INFRA_ROOTS,
  validateRemoteEndpoint
} from "@/a2a/endpoint";

describe("validateRemoteEndpoint — format / protocol", () => {
  it("rejects a non-URL string", () => {
    expect(() => validateRemoteEndpoint("not a url", ["example.com"])).toThrow(
      InvalidEndpointError
    );
  });

  it("rejects http (non-https)", () => {
    expect(() =>
      validateRemoteEndpoint("http://agent.example.com", ["example.com"])
    ).toThrow(InvalidEndpointError);
  });

  it("rejects ftp scheme", () => {
    expect(() =>
      validateRemoteEndpoint("ftp://agent.example.com", ["example.com"])
    ).toThrow(InvalidEndpointError);
  });
});

describe("validateRemoteEndpoint — empty approved-domains list (deny-all)", () => {
  it("rejects any public HTTPS host when no domains are approved", () => {
    expect(() => validateRemoteEndpoint("https://agent.example.com")).toThrow(
      InvalidEndpointError
    );
    expect(() =>
      validateRemoteEndpoint("https://agent.example.com", [])
    ).toThrow(InvalidEndpointError);
  });
});

describe("validateRemoteEndpoint — shared-infra root domain rejection", () => {
  for (const root of SHARED_INFRA_ROOTS) {
    it(`permanently blocks the bare root '${root}'`, () => {
      // Should be blocked even if somehow present in the approved list.
      expect(() =>
        validateRemoteEndpoint(`https://${root}/a2a`, [root])
      ).toThrow(InvalidEndpointError);
    });
  }
});

describe("validateRemoteEndpoint — approved-domain matching", () => {
  it("accepts a host that exactly matches an approved domain", () => {
    expect(
      validateRemoteEndpoint("https://agent.example.com/a2a", [
        "agent.example.com"
      ])
    ).toBeInstanceOf(URL);
  });

  it("accepts a direct subdomain of an approved domain", () => {
    expect(
      validateRemoteEndpoint("https://cool-agent.myorg.workers.dev/a2a", [
        "myorg.workers.dev"
      ])
    ).toBeInstanceOf(URL);
  });

  it("accepts a deeper subdomain of an approved domain", () => {
    expect(
      validateRemoteEndpoint("https://sub.cool-agent.myorg.workers.dev/a2a", [
        "myorg.workers.dev"
      ])
    ).toBeInstanceOf(URL);
  });

  it("accepts with multiple approved domains (first doesn't match, second does)", () => {
    expect(
      validateRemoteEndpoint("https://agent.acme.io/a2a", [
        "example.com",
        "acme.io"
      ])
    ).toBeInstanceOf(URL);
  });

  it("rejects a host not covered by any approved domain", () => {
    expect(() =>
      validateRemoteEndpoint("https://evil.example.com", ["agent.example.com"])
    ).toThrow(InvalidEndpointError);
  });

  it("does not treat an approved domain as a suffix match of unrelated hosts", () => {
    // "example.com" should not approve "notexample.com"
    expect(() =>
      validateRemoteEndpoint("https://notexample.com", ["example.com"])
    ).toThrow(InvalidEndpointError);
  });

  it("accepts account-level subdomains of shared-infra roots", () => {
    expect(
      validateRemoteEndpoint("https://myorg.workers.dev/a2a", [
        "myorg.workers.dev"
      ])
    ).toBeInstanceOf(URL);
    expect(
      validateRemoteEndpoint("https://cool-agent.myorg.workers.dev/a2a", [
        "myorg.workers.dev"
      ])
    ).toBeInstanceOf(URL);
  });
});

describe("validateRemoteEndpoint — SSRF belt-and-suspenders", () => {
  // Private/internal addresses are still blocked even if an operator somehow
  // adds them to the approved list (defense-in-depth).
  const internalEndpoints: Array<[string, string, string]> = [
    ["https://localhost/a2a", "localhost", "localhost"],
    ["https://127.0.0.1", "127.0.0.1", "loopback IPv4"],
    ["https://10.1.2.3", "10.1.2.3", "private 10/8"],
    ["https://172.16.5.6", "172.16.5.6", "private 172.16/12"],
    ["https://192.168.0.1", "192.168.0.1", "private 192.168/16"],
    ["https://169.254.169.254", "169.254.169.254", "link-local / metadata"],
    ["https://100.64.0.1", "100.64.0.1", "CGNAT"],
    ["https://foo.local", "foo.local", ".local suffix"],
    ["https://foo.internal", "foo.internal", ".internal suffix"]
  ];
  for (const [endpoint, approvedEntry, why] of internalEndpoints) {
    it(`blocks ${why} even when listed in approved domains`, () => {
      expect(() => validateRemoteEndpoint(endpoint, [approvedEntry])).toThrow(
        InvalidEndpointError
      );
    });
  }

  it("blocks all IPv6 literals regardless of approval", () => {
    for (const endpoint of [
      "https://[::1]",
      "https://[fd00::1]",
      "https://[fe80::1]",
      "https://[::ffff:127.0.0.1]",
      "https://[0:0:0:0:0:0:0:1]"
    ]) {
      // IPv6 literals can't be added to approved list as valid domains,
      // but verify they're blocked at the protocol/format level.
      expect(() => validateRemoteEndpoint(endpoint, ["::1"])).toThrow(
        InvalidEndpointError
      );
    }
  });

  it("blocks canonical forms of loopback (decimal, shorthand, hex)", () => {
    const allow = ["2130706433", "127.1", "0x7f.0.0.1"];
    expect(() => validateRemoteEndpoint("https://2130706433", allow)).toThrow(
      InvalidEndpointError
    );
    expect(() => validateRemoteEndpoint("https://127.1", allow)).toThrow(
      InvalidEndpointError
    );
    expect(() => validateRemoteEndpoint("https://0x7f.0.0.1", allow)).toThrow(
      InvalidEndpointError
    );
  });
});

describe("originOf", () => {
  it("returns scheme+host(+port) only", () => {
    expect(originOf("https://agent.example.com/a2a?x=1")).toBe(
      "https://agent.example.com"
    );
    expect(originOf("https://agent.example.com:8443/path")).toBe(
      "https://agent.example.com:8443"
    );
  });
});

describe("audienceFor", () => {
  it("is the exact endpoint, not its origin", () => {
    // The break with the old behaviour. An origin-only audience cannot tell two
    // agents on one host apart; this can.
    expect(audienceFor("https://agent.example.com/proactive/a2a")).toBe(
      "https://agent.example.com/proactive/a2a"
    );
  });

  it("gives sibling mounts on one origin different audiences", () => {
    // The whole point of the change — under `originOf` these were identical.
    expect(audienceFor("https://host.example.com/generic/a2a")).not.toBe(
      audienceFor("https://host.example.com/proactive/a2a")
    );
  });

  it("drops any query string or fragment on the registered endpoint", () => {
    // The agent derives its expected audience from origin + request path, so
    // anything after the path would make the two sides disagree.
    expect(audienceFor("https://agent.example.com/a2a?trace=1#frag")).toBe(
      "https://agent.example.com/a2a"
    );
  });

  it("keeps the port, which is part of the origin", () => {
    expect(audienceFor("https://agent.example.com:8443/a2a")).toBe(
      "https://agent.example.com:8443/a2a"
    );
  });

  it("normalizes a bare origin to its root path", () => {
    // `new URL("https://h").pathname` is "/", which is also what an agent
    // mounted at the root computes.
    expect(audienceFor("https://agent.example.com")).toBe(
      "https://agent.example.com/"
    );
  });
});
