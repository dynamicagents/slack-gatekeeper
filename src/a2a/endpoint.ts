import { A2A_PROTOCOL_VERSION, type AgentCard } from "@a2a-js/sdk";
import type { AgentInterface } from "@a2a-js/sdk";

/** The only transport this gatekeeper speaks. Compared case-insensitively. */
const JSONRPC_BINDING = "JSONRPC";

/**
 * SSRF-safe validation for remote (custom) A2A endpoints. The gatekeeper dials
 * these URLs from inside Cloudflare, so an unvalidated endpoint is a
 * server-side request forgery vector: an attacker who can register an agent
 * could point it at internal addresses, cloud-metadata endpoints, or loopback.
 *
 * Policy (A2A spec §13.2 / §14.1.1):
 *  - HTTPS only.
 *  - Reject loopback / private / link-local / CGNAT / metadata IPv4 literals
 *    (shorthand/decimal/octal/hex forms are normalized by `new URL()` first).
 *  - Reject all IPv6 literals (see `isIPv6Literal`).
 *  - Reject bare single-label hosts and known-internal suffixes
 *    (`localhost`, `.local`, `.internal`, `.localhost`).
 *  - Reject bare shared-infrastructure root domains (`workers.dev`, etc.) even
 *    if present in the org's approved-domains list — any third-party can deploy
 *    under these domains and would pass A2A key verification. Account-level
 *    subdomains (e.g. `myorg.workers.dev`) are allowed.
 *  - Required explicit org-approved domain list (org admin-managed). Each entry
 *    covers that domain and all its subdomains (subdomain-aware matching). An
 *    empty list means no remote agents are approved — deny all.
 *
 * Residual risk: DNS rebinding. Workers cannot cheaply pre-resolve a hostname to
 * inspect the address it will actually connect to, so a public name that
 * resolves to a private address at request time is not caught here. The
 * approved-domains list is the mitigation when that risk is unacceptable.
 */

/** Thrown when an endpoint URL is rejected by the SSRF policy. */
export class InvalidEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEndpointError";
  }
}

/** Hostname suffixes that always resolve to internal/loopback targets. */
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost"];

/**
 * Bare root domains of shared infrastructure platforms where any user can
 * deploy code. Trusting these as A2A endpoint domains is dangerous because
 * A2A verifies keys by fetching from the endpoint domain — a third-party
 * deploying under the same root could forge agent identities.
 *
 * Account-level subdomains (e.g. `myorg.workers.dev`) are fine because
 * the account owner controls all subdomains under their namespace.
 *
 * Exported so the admin tool can reuse this set for add-time validation.
 */
export const SHARED_INFRA_ROOTS = new Set([
  "workers.dev",
  "pages.dev",
  "vercel.app",
  "netlify.app",
  "github.io",
  "glitch.me",
  "repl.co",
  "railway.app",
  "render.com"
]);

/** Exact hostnames that are always internal. */
const BLOCKED_HOSTS = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/** Parse a dotted-quad IPv4 literal into its four octets, or null. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1, 5).map((n) => Number(n));
  if (octets.some((o) => o > 255)) return null;
  return octets as [number, number, number, number];
}

/** Private / loopback / link-local / CGNAT / reserved IPv4 ranges. */
function isBlockedIPv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (+ metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/3)
  return false;
}

/**
 * Reject every IPv6 literal. After WHATWG URL parsing, `url.hostname` for an
 * IPv6 host is the *bracketed*, fully-compressed form (`[::1]`, `[fe80::1]`),
 * and IPv4-mapped addresses are hex-folded (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`).
 * Correctly classifying every special-use IPv6 range after that canonicalization
 * is error-prone, and a remote A2A endpoint never legitimately needs a bare IPv6
 * literal — a DNS hostname that happens to resolve over IPv6 is still allowed.
 * So we deny IPv6 literals outright rather than risk a parsing gap.
 */
function isIPv6Literal(host: string): boolean {
  return host.startsWith("[") || host.includes(":");
}

/** True if the host must never be dialed (internal/private/reserved). */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (isIPv6Literal(h)) return true;
  if (BLOCKED_HOSTS.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;

  // WHATWG `new URL()` has already canonicalized shorthand/decimal/octal/hex
  // IPv4 forms (e.g. `2130706433`, `127.1`, `0x7f.0.0.1`) to dotted-quad, so a
  // single decimal check on the canonical hostname catches all of them.
  const v4 = parseIPv4(h);
  if (v4) return isBlockedIPv4(v4);

  // Reject bare single-label hosts (no dot) — they only resolve on internal
  // search domains. IP literals are handled above, so this is hostnames only.
  if (!h.includes(".")) return true;
  return false;
}

/**
 * Validate a remote A2A endpoint against the SSRF policy and org-approved
 * domain list. Returns the parsed `URL` on success; throws
 * {@link InvalidEndpointError} otherwise.
 *
 * Matching is subdomain-aware: an entry `myorg.workers.dev` in
 * `allowedDomains` approves `myorg.workers.dev` itself and any host ending
 * with `.myorg.workers.dev` (e.g. `cool-agent.myorg.workers.dev`).
 *
 * An empty `allowedDomains` means no remote agents are approved — deny all.
 */
export function validateRemoteEndpoint(
  endpoint: string,
  allowedDomains: string[] = []
): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidEndpointError(`not a valid URL: ${endpoint}`);
  }

  if (url.protocol !== "https:") {
    throw new InvalidEndpointError(
      `endpoint must use https (got ${url.protocol})`
    );
  }

  const host = url.hostname.toLowerCase();

  // Shared-infra root domains are permanently blocked regardless of the
  // approved-domains list — any third-party can deploy under these roots.
  if (SHARED_INFRA_ROOTS.has(host)) {
    throw new InvalidEndpointError(
      `'${host}' is a shared infrastructure root domain — any third-party ` +
        `can deploy under it and forge agent identities in A2A key verification. ` +
        `Add a specific account-level subdomain you control instead ` +
        `(e.g. 'myorg.${host}').`
    );
  }

  if (allowedDomains.length === 0) {
    throw new InvalidEndpointError(
      `No remote agent domains are approved by your organization. ` +
        `The org admin must add at least one approved domain via the admin agent ` +
        `before custom agents can be registered or dispatched to.`
    );
  }

  const approved = allowedDomains.some(
    (d) => host === d || host.endsWith(`.${d}`)
  );
  if (!approved) {
    throw new InvalidEndpointError(
      `Host '${host}' is not covered by any of your organization's approved ` +
        `remote agent domains. Ask your org admin to add an approved domain via ` +
        `the admin agent. Only domains your organization fully controls ` +
        `(including all subdomains) should be approved.`
    );
  }

  // Belt-and-suspenders: still block internal addresses even when the host
  // matches an approved domain (guards against approved domains that somehow
  // resolve to private IPs, e.g. misconfigured split-horizon DNS).
  if (isBlockedHost(host)) {
    throw new InvalidEndpointError(`endpoint host is not allowed: ${host}`);
  }

  return url;
}

/** The scheme+host origin of an endpoint. */
export function originOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * The `aud` a dispatch token carries: the agent's **exact endpoint**, which is
 * the URL its own card advertises as its JSONRPC interface.
 *
 * From `@dynamicagents/g2a-protocol`, because it is one half of a two-sided rule.
 * The receiving side derives its expected audience from the same place — it
 * composes its card's interface URL with `endpointUrl` and verifies that same
 * string — and the package pins `audienceFor(endpointUrl(o, p)) === endpointUrl(o, p)`
 * for every path, so both ends agree by construction rather than by two
 * implementations happening to match.
 *
 * `verifyRemoteAgentEndpoint` resolves the endpoint from the card at
 * registration and stores it, so the value is never guessed and no path
 * convention exists to be wrong about — an agent serving on `/api/v2/agent`
 * works exactly as one on `/a2a`.
 *
 * Re-exported here so the rest of the gatekeeper keeps importing it from the
 * module that owns endpoint policy.
 */
export { audienceFor } from "@dynamicagents/g2a-protocol";

/**
 * The card's JSONRPC interface — where to POST, and what the audience is built
 * from.
 *
 * `supportedInterfaces` is an ordered *preference* list that may advertise gRPC
 * or HTTP+JSON ahead of JSONRPC (A2A §8.3.1), and this gatekeeper speaks only
 * JSONRPC, so taking `supportedInterfaces[0]` reads the wrong entry against any
 * agent that prefers another transport. Matching on `protocolBinding` is what
 * the SDK's own client does when it selects a transport.
 *
 * The version check keeps a v0.3-only agent from registering cleanly and then
 * failing on its first dispatch: the SDK would route it through the legacy
 * transport, which this gatekeeper does not enable.
 */
export function selectJsonRpcInterface(card: AgentCard): AgentInterface {
  const selected = (card.supportedInterfaces ?? []).find(
    // Open-form string in the proto, and the SDK matches it case-insensitively.
    (i) => i.protocolBinding?.toUpperCase() === JSONRPC_BINDING
  );
  if (!selected) {
    const advertised =
      (card.supportedInterfaces ?? [])
        .map((i) => i.protocolBinding)
        .join(", ") || "none";
    throw new InvalidEndpointError(
      `agent card advertises no ${JSONRPC_BINDING} interface (has: ${advertised})`
    );
  }
  if (selected.protocolVersion !== A2A_PROTOCOL_VERSION) {
    throw new InvalidEndpointError(
      `agent card advertises A2A ${selected.protocolVersion} on its ` +
        `${JSONRPC_BINDING} interface; this gatekeeper speaks ${A2A_PROTOCOL_VERSION}`
    );
  }
  return selected;
}
