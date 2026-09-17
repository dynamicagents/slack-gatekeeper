import { waitUntil } from "cloudflare:workers";
import { A2A_JWS_ALG } from "@dynamicagents/g2a-protocol";
import {
  AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AgentCard,
  canonicalizeAgentCard,
  verifyAgentCardSignature as createCardVerifier,
  type AgentCardSignature
} from "@a2a-js/sdk";
import { base64url, type JWK } from "jose";
import {
  audienceFor,
  originOf,
  selectJsonRpcInterface,
  validateRemoteEndpoint
} from "./endpoint";

/**
 * "A knows B is really B" — verify a remote agent's **signed AgentCard**
 * (A2A spec §8.4, RFC 7515) before trusting its endpoint.
 *
 * Combined with TLS + a pinned HTTPS endpoint, a valid card signature proves the
 * card was issued by whoever controls the provider's signing key. The verified
 * key identity (`kid` + `jku`) is pinned in the registry at registration
 * (Trust-On-First-Use), so a later substitution by a different signer is
 * rejected — the same pattern as the Slack `team_id` anchor.
 *
 * Signing contract: A2A v1.0 standardized this, so the canonicalization and JWS
 * verification are the SDK's (`canonicalizeAgentCard` / `verifyAgentCardSignature`)
 * rather than a gatekeeper-local scheme — a detached-payload flattened JWS over the
 * **JCS (RFC 8785)** canonicalization of the card's protobuf-JSON encoding with
 * `signatures` removed, and a protected header carrying `alg`, `kid` and `typ`.
 * What stays gatekeeper-specific is the trust policy layered on top: only `EdDSA`
 * signatures count, the `jku` is fetched through the SSRF allowlist, and the key
 * must be an Ed25519 OKP JWK.
 */

/** Thrown when a card cannot be fetched, is unsigned, or fails verification. */
export class AgentCardVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCardVerificationError";
  }
}

/** The pinned signing identity persisted with a custom agent row. */
export interface CardSigningPin {
  cardSigningJku: string;
  cardSigningKid: string;
}

/** Full result of verifying a remote agent endpoint — pin + card-derived metadata. */
export interface VerifiedAgentCard {
  pin: CardSigningPin;
  /** Display name sourced from `AgentCard.name`. */
  displayName: string;
  /**
   * The JSONRPC endpoint the card advertises — resolved, not guessed. Stored on
   * the agent row and used verbatim for both the POST target and the `aud`.
   */
  endpoint: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CARD_LENGTH = 256 * 1024;

/**
 * The exact byte string an AgentCard signature is computed over: the card's
 * protobuf-JSON encoding with `signatures` removed, canonicalized per JCS
 * (RFC 8785). Mirrors what {@link createCardVerifier} recomputes internally, so
 * a third-party agent can sign against this and verify here.
 */
export function canonicalCardPayload(card: AgentCard): string {
  const normalized = AgentCard.toJSON(AgentCard.fromJSON(card)) as Record<
    string,
    unknown
  >;
  delete normalized.signatures;
  return canonicalizeAgentCard(normalized as Omit<AgentCard, "signatures">);
}

/** The decoded JWS protected header of a card signature, or null if unreadable. */
function protectedHeaderOf(
  signature: AgentCardSignature
): Record<string, unknown> | null {
  try {
    const decoded = base64url.decode(signature.protected);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decoded));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read a response body as text, refusing to hold more than
 * {@link MAX_CARD_LENGTH} of it.
 *
 * Streamed rather than `await res.text()`, which buffers the *whole* body before
 * anything can measure it — so a hostile or broken endpoint could force a
 * multi-hundred-megabyte allocation and take the isolate down before the size
 * check it was supposedly subject to ever ran. Checking after buffering is not a
 * size limit; it is a report on how much was already allocated.
 *
 * Reading incrementally caps the allocation at roughly the limit plus one chunk,
 * since network chunks are transport-bounded (tens of KB), and cancelling the
 * reader stops the transfer instead of politely draining a body we have already
 * rejected.
 *
 * Bytes are concatenated before decoding, never decoded per chunk: a multi-byte
 * UTF-8 sequence can straddle a chunk boundary, and decoding the halves
 * separately corrupts it.
 */
async function readCappedText(
  res: Response,
  describe: string
): Promise<string> {
  const tooLarge = () =>
    new AgentCardVerificationError(
      `${describe} exceeds the ${MAX_CARD_LENGTH}-byte limit`
    );

  // An honest sender lets us refuse before transferring anything. Only an
  // optimization — a lying or absent header changes nothing, since the
  // streaming check below is what actually holds.
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CARD_LENGTH) throw tooLarge();

  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CARD_LENGTH) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/** GET JSON with an abort timeout and a hard size cap (SSRF/DoS hardening). */
async function fetchJsonCapped(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new AgentCardVerificationError(
        `fetch ${url} returned HTTP ${res.status}`
      );
    }
    // Inside the try, so the abort timeout bounds the body read too — a sender
    // that trickles bytes forever is a hang, not just a slow response.
    const text = await readCappedText(res, `response from ${url}`);
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof AgentCardVerificationError) throw err;
    throw new AgentCardVerificationError(
      `failed to fetch ${url}: ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the public AgentCard from a remote endpoint's well-known path. */
export async function fetchAgentCard(
  endpoint: string,
  allowedDomains: string[] = []
): Promise<AgentCard> {
  validateRemoteEndpoint(endpoint, allowedDomains);
  const path = AGENT_CARD_PATH.startsWith("/")
    ? AGENT_CARD_PATH
    : `/${AGENT_CARD_PATH}`;
  const cardUrl = new URL(path, originOf(endpoint)).toString();
  const raw = await fetchJsonCapped(cardUrl);
  if (!raw || typeof raw !== "object") {
    throw new AgentCardVerificationError(`invalid AgentCard at ${cardUrl}`);
  }
  // Decode through the generated codec rather than casting: the wire form is
  // protobuf-JSON, so this is what normalizes enum names, oneof shapes, and
  // omitted proto defaults into the typed v1.0 card the rest of the code uses.
  let card: AgentCard;
  try {
    card = AgentCard.fromJSON(raw);
  } catch (err) {
    throw new AgentCardVerificationError(
      `invalid AgentCard at ${cardUrl}: ${(err as Error).message}`
    );
  }
  if (typeof card.name !== "string" || card.name.length === 0) {
    throw new AgentCardVerificationError(`invalid AgentCard at ${cardUrl}`);
  }
  return card;
}

/**
 * How long a fetched JWKS is reused, and how much longer than that it may still
 * be answered from while a replacement is fetched behind it.
 *
 * A remote agent's JWKS is close to static — a signing key rotates on a human
 * timescale — but the busiest thing the gatekeeper does with it is the opposite:
 * every push-notification callback on a task verifies against it, and a task
 * reports non-terminal status many times before it finishes. Uncached, that is a
 * full HTTPS round-trip to the remote's JWKS per POST, in front of work that has
 * not started yet.
 *
 * Five minutes is short enough that a revocation propagates while the admin who
 * performed it is still watching, and long enough that a burst of callbacks on
 * one task costs one fetch. The stale window is the availability half: a remote
 * whose JWKS endpoint is briefly down should not take its callbacks down with
 * it, and a key that verified a minute ago is not less valid because its server
 * stopped answering. Past an hour we stop guessing and let the fetch fail.
 *
 * Neither window can outlive a rotation, because a `kid` we have never seen
 * forces a refresh before it is allowed to fail — see {@link resolveSigningKey}.
 */
const JWKS_FRESH_MS = 5 * 60_000;
const JWKS_MAX_STALE_MS = 60 * 60_000;

/**
 * How many remotes' key sets the cache holds before it starts dropping the
 * least recently used.
 *
 * The `jku` is always on a domain the org approved, but its *path* is not: it
 * arrives in a card's protected header, so an approved-but-hostile provider
 * chooses it, and the number of distinct URLs is therefore not bounded by the
 * number of registered agents. Unbounded, each of those could hold up to
 * {@link MAX_CARD_LENGTH} of the isolate's memory for an hour. A bound turns
 * that back into what it was without a cache — a fetch — since evicting an
 * entry costs only the round-trip it saved.
 */
const JWKS_CACHE_MAX_ENTRIES = 64;

/** One remote's JWKS, with the moment it was fetched. */
interface CachedJwks {
  keys: JWK[];
  fetchedAt: number;
}

/**
 * Cached JWKS bodies, keyed by the `jku` they were fetched from.
 *
 * Module state, so its lifetime is the isolate's: nothing here survives a cold
 * start, and Cloudflare may run any number of isolates per colo. That is the
 * right shape for this — the cache is an optimization whose worst case is the
 * behaviour we had before it, never a source of truth. It is keyed by URL alone
 * and therefore shared across orgs, which is only safe because
 * {@link resolveSigningKey} re-runs the caller's own allowlist check before it
 * ever looks in here: one org's approved domain never becomes another's.
 */
const jwksCache = new Map<string, CachedJwks>();

/**
 * Fetches currently in progress, keyed the same way. A hundred callbacks
 * arriving together on a cold isolate is one fetch, not a hundred — the rest
 * await this promise. Without it the cache would still remove the steady-state
 * fetches while leaving the stampede that follows every cold start intact.
 */
const jwksInFlight = new Map<string, Promise<JWK[]>>();

/**
 * Bumped by {@link clearJwksCache} so a fetch that was already in flight cannot
 * write its result into a cache that was deliberately emptied after it started.
 */
let jwksEpoch = 0;

/**
 * Empty the JWKS cache. Exported for tests, which need each case to start from
 * a cold isolate; nothing in the Worker calls it.
 */
export function clearJwksCache(): void {
  jwksEpoch += 1;
  jwksCache.clear();
  jwksInFlight.clear();
}

/**
 * Move an entry to the tail of {@link jwksCache}, so the head stays the least
 * recently used one.
 *
 * The delete before the set is the whole mechanism: a `Map` iterates in
 * insertion order and overwriting a key in place keeps its *original* position,
 * so a URL used every minute for a day would still be evicted as if it had not
 * been touched since the first time.
 */
function touchJwks(jku: string, entry: CachedJwks): void {
  jwksCache.delete(jku);
  jwksCache.set(jku, entry);
}

/**
 * Store one fetched key set, evicting the least recently used once the cache is
 * at {@link JWKS_CACHE_MAX_ENTRIES}.
 */
function storeJwks(jku: string, keys: JWK[]): void {
  touchJwks(jku, { keys, fetchedAt: Date.now() });
  while (jwksCache.size > JWKS_CACHE_MAX_ENTRIES) {
    const oldest = jwksCache.keys().next();
    if (oldest.done) break;
    jwksCache.delete(oldest.value);
  }
}

/** Fetch a JWKS, coalescing concurrent callers onto one request. */
function loadJwks(jku: string): Promise<JWK[]> {
  const existing = jwksInFlight.get(jku);
  if (existing) return existing;

  const epoch = jwksEpoch;
  const request = (async () => {
    const body = (await fetchJsonCapped(jku)) as { keys?: JWK[] } | null;
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    if (epoch === jwksEpoch) storeJwks(jku, keys);
    return keys;
  })();

  jwksInFlight.set(jku, request);
  // A failed fetch is not cached, so the next caller retries; either way the
  // slot is freed. Attached with both handlers so the rejection is observed
  // here too — the caller awaiting `request` still sees it.
  const release = () => {
    if (jwksInFlight.get(jku) === request) jwksInFlight.delete(jku);
  };
  request.then(release, release);
  return request;
}

/**
 * The keys for a `jku`, and whether they came from the cache rather than from a
 * fetch this call waited on — which is what tells {@link resolveSigningKey}
 * whether a missing `kid` is worth re-checking at the source.
 */
async function jwksKeys(
  jku: string,
  opts: { refresh?: boolean } = {}
): Promise<{ keys: JWK[]; cached: boolean }> {
  const entry = opts.refresh ? undefined : jwksCache.get(jku);
  if (entry) {
    const age = Date.now() - entry.fetchedAt;
    if (age < JWKS_FRESH_MS) {
      // A hit is a *use*, and eviction is by use — so re-seat the entry at the
      // tail before answering from it, or the busiest `jku` in the isolate is
      // dropped on the schedule of the one time it was fetched. The entry
      // object is re-set unchanged: rewriting `fetchedAt` here would re-arm the
      // TTL on every read and make a hot entry immortal, which is the one thing
      // a key cache must never be.
      touchJwks(jku, entry);
      return { keys: entry.keys, cached: true };
    }
    if (age < JWKS_MAX_STALE_MS) {
      // Stale-while-revalidate: answer now from what we have and replace it
      // behind the response. Registered with `waitUntil` rather than left
      // detached — the runtime may cancel unregistered work once the response
      // is sent, which would leave a busy entry stale until the hour is up and
      // then block a callback on a fetch it had every chance to have made
      // already. Still not awaited, and a failure only means the stale entry
      // stands until it ages out.
      waitUntil(loadJwks(jku).catch(() => {}));
      return { keys: entry.keys, cached: true };
    }
  }
  return { keys: await loadJwks(jku), cached: false };
}

/**
 * Resolve the public key referenced by a JWS `jku` + `kid`. Exported so the
 * push-notification callback verifier can reuse the same SSRF-guarded fetch +
 * Ed25519 shape check against a remote's pinned JWKS.
 *
 * Served from {@link jwksCache} when it can be, but never at the cost of the
 * checks around it: the allowlist runs first on every call, and a `kid` the
 * cached set does not contain is re-checked at the source before it is refused.
 */
export async function resolveSigningKey(
  jku: string,
  kid: string,
  allowedDomains: string[]
): Promise<JWK> {
  // First, on every call, cache hit or not. The allowlist is what decides
  // whether this org may talk to this host at all, and a cached answer that
  // skipped it would be a way to read a JWKS from a domain the org never
  // approved — the cache is shared by URL, and approval is not.
  validateRemoteEndpoint(jku, allowedDomains);

  const first = await jwksKeys(jku);
  let key = first.keys.find((k) => k.kid === kid);

  // Key rotation is the one case where a cached answer is worse than none: the
  // remote signed with a key it published after we last looked, and waiting out
  // a TTL would reject every callback until then. An unknown `kid` is cheap and
  // self-limiting to re-check — it only happens when the set really changed, or
  // when a caller is asking for a key that was never there, which costs the one
  // fetch it would have cost with no cache at all.
  if (!key && first.cached) {
    const refreshed = await jwksKeys(jku, { refresh: true });
    key = refreshed.keys.find((k) => k.kid === kid);
  }

  if (!key) {
    throw new AgentCardVerificationError(
      `signing key '${kid}' not found in JWKS at ${jku}`
    );
  }
  if (key.kty !== "OKP" || key.crv !== "Ed25519") {
    throw new AgentCardVerificationError(
      `signing key '${kid}' is not an Ed25519 (OKP) key`
    );
  }
  return key;
}

/**
 * Verify a remote AgentCard's signature and return the pinned signing identity.
 * Throws {@link AgentCardVerificationError} if the card is unsigned or every
 * signature fails to verify.
 */
export async function verifyAgentCardSignature(
  card: AgentCard,
  opts: { allowedDomains?: string[] } = {}
): Promise<CardSigningPin> {
  const allowedDomains = opts.allowedDomains ?? [];
  const signatures = card.signatures ?? [];
  if (signatures.length === 0) {
    throw new AgentCardVerificationError("AgentCard is not signed");
  }

  // The SDK verifier accepts whatever `alg` the protected header names, so the
  // algorithm restriction is enforced by only ever handing it EdDSA entries.
  const eddsa = signatures.filter(
    (sig) => protectedHeaderOf(sig)?.alg === A2A_JWS_ALG
  );
  if (eddsa.length === 0) {
    throw new AgentCardVerificationError(
      `AgentCard has no ${A2A_JWS_ALG} signature to verify`
    );
  }

  // The verifier returns on the first signature that validates, so the last
  // identity its key lookup resolved is the one that verified — capture it
  // there, since the verifier itself reports only success or failure.
  let pin: CardSigningPin | undefined;
  const verify = createCardVerifier(async (kid, jku) => {
    if (!jku) throw new Error("protected header missing jku");
    const key = await resolveSigningKey(jku, kid, allowedDomains);
    pin = { cardSigningJku: jku, cardSigningKid: kid };
    return key;
  });

  try {
    await verify({ ...card, signatures: eddsa });
  } catch (err) {
    throw new AgentCardVerificationError(
      `AgentCard signature verification failed: ${(err as Error).message}`
    );
  }
  if (!pin) {
    throw new AgentCardVerificationError(
      "AgentCard signature verified without resolving a signing key"
    );
  }
  return pin;
}

/**
 * Fetch one tenant's AgentCard via `GetExtendedAgentCard` (A2A §3.1.11).
 *
 * The well-known path serves a **stub** describing the origin, because that URI
 * is per-authority (RFC 8615) and a host may serve many agents. A tenant's own
 * card — its name, skills and signature — is only reachable here, and the call
 * is authenticated: the agent verifies our gatekeeper JWT before answering, so the
 * token has to name the tenant being asked about.
 */
async function fetchExtendedAgentCard(
  endpoint: string,
  tenantId: string,
  authToken: string
): Promise<AgentCard> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // The request *and* the body read share one try, so the abort timeout covers
  // both. Clearing it after the fetch resolved would leave the read unbounded —
  // headers arrive promptly and the body then trickles forever.
  let text: string;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "GetExtendedAgentCard",
        params: { tenant: tenantId }
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new AgentCardVerificationError(
        `extended card request for tenant '${tenantId}' failed: HTTP ${res.status}`
      );
    }
    text = await readCappedText(
      res,
      `the extended card for tenant '${tenantId}'`
    );
  } catch (err) {
    if (err instanceof AgentCardVerificationError) throw err;
    throw new AgentCardVerificationError(
      `failed to fetch the extended card for tenant '${tenantId}': ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }

  let body: { result?: unknown; error?: { message?: string } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new AgentCardVerificationError(
      `extended card for tenant '${tenantId}' is not valid JSON`
    );
  }
  // JSON-RPC transports errors at HTTP 200, so this is the real failure path —
  // an unknown tenant or a refused token arrives here, not above.
  if (body.error) {
    throw new AgentCardVerificationError(
      `agent refused the extended card request for tenant '${tenantId}': ` +
        `${body.error.message ?? "unknown error"}`
    );
  }
  if (!body.result || typeof body.result !== "object") {
    throw new AgentCardVerificationError(
      `agent returned no card for tenant '${tenantId}'`
    );
  }
  try {
    return AgentCard.fromJSON(body.result);
  } catch (err) {
    throw new AgentCardVerificationError(
      `invalid extended card for tenant '${tenantId}': ${(err as Error).message}`
    );
  }
}

export interface VerifyRemoteAgentArgs {
  /**
   * Any URL on the agent's host. Only its **origin** is used: the card lives at
   * a well-known URI, which RFC 8615 defines per-authority, and the card is what
   * names the real endpoint. So an admin can paste an origin, an endpoint or a
   * card URL and all three work.
   */
  url: string;
  /** Which agent at that host is being registered. */
  tenantId: string;
  allowedDomains?: string[];
  /**
   * Mint the gatekeeper JWT authorizing the extended-card call. Injected rather
   * than imported so these handlers stay offline-testable, the same seam
   * `AdminToolDeps.verifyEndpoint` uses.
   */
  authToken: (audience: string, tenant: string) => Promise<string>;
}

/**
 * One-shot verifier used at agent registration.
 *
 * Two cards, one key:
 *
 *  1. The **stub** at the well-known path establishes who this origin is, and
 *     its signature resolves the `jku`/`kid` pinned Trust-On-First-Use. It also
 *     names the real endpoint, which is why nothing here assumes a path.
 *  2. The **tenant's** card, fetched through `GetExtendedAgentCard`, is what
 *     the agent row is actually about — its `displayName` comes from here.
 *
 * The second is verified against the *same* pin: one origin, one signing key,
 * so a tenant card signed by anything else is a different provider answering.
 *
 * Its declared tenant is checked too. Without that a typo'd tenant id would
 * register cleanly — the stub verifies no matter which tenant was asked for —
 * and only surface as a 401 on the first real dispatch, long after the admin
 * who could fix it has moved on.
 *
 * The resolved endpoint is returned to be stored, and is the single value
 * dispatch POSTs to and derives its `aud` from. Resolving it here rather than
 * per-send is what stops the two from drifting: the audience is only correct if
 * it names the URL the request actually goes to.
 */
export async function verifyRemoteAgentEndpoint(
  args: VerifyRemoteAgentArgs
): Promise<VerifiedAgentCard> {
  const { url, tenantId } = args;
  const allowedDomains = args.allowedDomains ?? [];

  const stub = await fetchAgentCard(url, allowedDomains);
  const pin = await verifyAgentCardSignature(stub, { allowedDomains });

  // Where the agent says to call it, rather than where an admin guessed.
  const endpoint = selectJsonRpcInterface(stub).url;

  // The card decides where we POST, so it must not be able to point us at a
  // host it never authenticated. We pinned *this* origin's signing key; an
  // interface elsewhere would mean dispatching to somewhere the signature says
  // nothing about, and re-pointing an approved agent at an internal address is
  // exactly the SSRF shape `validateRemoteEndpoint` exists to stop.
  if (originOf(endpoint) !== originOf(url)) {
    throw new AgentCardVerificationError(
      `agent card at ${originOf(url)} advertises its endpoint on a different ` +
        `origin (${originOf(endpoint)}); one origin serves one signing identity`
    );
  }
  // Belt and braces: the origin matched a card we fetched, but the resolved URL
  // is what will be dialed, so it passes the same policy on its own terms.
  validateRemoteEndpoint(endpoint, allowedDomains);

  const token = await args.authToken(audienceFor(endpoint), tenantId);
  const card = await fetchExtendedAgentCard(endpoint, tenantId, token);

  const tenantPin = await verifyAgentCardSignature(card, { allowedDomains });
  if (
    tenantPin.cardSigningJku !== pin.cardSigningJku ||
    tenantPin.cardSigningKid !== pin.cardSigningKid
  ) {
    throw new AgentCardVerificationError(
      `the card for tenant '${tenantId}' is signed by a different key than the ` +
        `origin's own card — one origin serves one signing identity`
    );
  }

  const declared = selectJsonRpcInterface(card).tenant ?? "";
  if (declared !== tenantId) {
    throw new AgentCardVerificationError(
      `the agent returned a card declaring tenant '${declared || "<none>"}' ` +
        `for a request naming '${tenantId}'`
    );
  }

  return { pin, displayName: card.name, endpoint };
}
