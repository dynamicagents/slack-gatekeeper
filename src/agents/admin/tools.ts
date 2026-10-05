import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { VerifiedAgentCard } from "@/a2a/card-verify";
import {
  type AgentRow,
  type NotifyOn,
  getAgent,
  getAgentChannels,
  listAgentsForWorkspace,
  listChannelsForAgents,
  registerAgent,
  updateAgent,
  unregisterAgent,
  attachAgentChannel,
  detachAgentChannel
} from "@/db/models/agents";
import {
  ORG_WORKSPACE_ID,
  getWorkspace,
  getWorkspaceByAdminChannel,
  listWorkspaces,
  createWorkspace,
  setWorkspaceAdminChannel
} from "@/db/models/workspaces";
import { isDmChannel } from "@/router/resolve";
import {
  getAllowedRemoteAgentDomains,
  setAllowedRemoteAgentDomains,
  getPublicUrl,
  setAdminIconUrl,
  setAdminDisplayName
} from "@/db/models/workspace-configs";
// The gatekeeper default a create without a deadline is written with. Its
// companion figure — the 6-minute delivery grace, below which a deadline is in
// practice enforced at the grace mark — is prose in the descriptions below
// rather than an import: `DELIVERY_RETRY_GRACE_SECONDS` lives in
// `src/workflows/reaction.ts`, and importing it here would pull the
// `WorkflowEntrypoint` module into the admin tools.
import { DEFAULT_TASK_DEADLINE_SECONDS } from "@/config";
import { SHARED_INFRA_ROOTS } from "@/a2a/endpoint";
import { hasSlackBroadcast, sanitizeDisplayName } from "@/util/slack-text";
import {
  buildAvatarPrompt,
  buildAgentAvatarPrompt,
  type GeneratedImage
} from "./avatar";

/**
 * Admin tools — registry + workspace CRUD on D1. One flat, single-purpose tool
 * per action, grouped by domain prefix: `agents_*` (read/create/update/delete,
 * allow/revoke a channel, regenerate an avatar, plus org-only `agents_domains_*`),
 * `workspace_*` (read + org-only create/set_admin_channel), and `self_*` (the
 * admin's own avatar + display name). No discriminated `operation` — each tool
 * takes a flat schema the model can emit reliably.
 *
 * **The channel is the permission.** Whoever can post in a workspace's admin
 * channel may use every tool here, so nothing checks *who* is asking. What is
 * checked is *where*: an instance acts on its own workspace (`wsId`, from the
 * admin channel the turn came through), and the org-only tools
 * (`workspace_create`, `workspace_set_admin_channel`, `agents_domains_*`) exist
 * only on the org instance — `buildAdminTools` builds them there and nowhere
 * else, and each refuses again on any other.
 *
 * Tool *logic* is split from the AI-SDK wiring so it unit-tests without an LLM.
 */
export interface AdminToolDeps {
  /** The workspace this admin instance manages (admin:{wsId}). */
  wsId: number;
  /**
   * Validates a custom agent's endpoint (SSRF policy) and verifies its signed
   * AgentCard, returning the signing identity to pin. Injected so the pure
   * handlers stay offline-testable; production binds it to the live verifier.
   */
  verifyEndpoint: EndpointVerifier;
  /**
   * Generate an avatar image from a prompt (Workers AI). Injected side-effect
   * seam — present only in production. When this or {@link storeIcon} is absent,
   * avatar generation (`self_set_avatar` and `agents_regenerate_avatar`) returns
   * a "not available" error at runtime.
   */
  generateImage?: (prompt: string) => Promise<GeneratedImage>;
  /**
   * Persist a generated avatar in this workspace's avatar store; returns its
   * key. `name` is `"admin"` (the admin's own avatar) or a custom agent's name —
   * icons are pruned per agent.
   */
  storeIcon?: (
    img: GeneratedImage,
    name: string
  ) => Promise<{ key: string; contentType: string }>;
}

/** Verify a remote agent endpoint + signed card; resolves to pin and card-derived metadata. */
export type EndpointVerifier = (
  endpoint: string,
  tenantId: string
) => Promise<VerifiedAgentCard>;

/** A reserved/built-in agent name that registry CRUD must never touch. */
const RESERVED_NAMES = new Set(["admin", "onboarding"]);

type ToolResult = Record<string, unknown>;

function shape(a: AgentRow, channels: string[]): ToolResult {
  return {
    name: a.name,
    kind: a.kind,
    displayName: a.displayName,
    iconUrl: a.iconUrl,
    enabled: a.enabled,
    notifyOn: a.notifyOn,
    taskDeadlineSeconds: a.taskDeadlineSeconds,
    a2aEndpoint: a.a2aEndpoint,
    tenantId: a.tenantId,
    workspaceId: a.workspaceId,
    channels
  };
}

/** Shape an agent row for the model (small, with its channel attachments). */
async function present(a: AgentRow): Promise<ToolResult> {
  return shape(a, await getAgentChannels(a.name));
}

/**
 * Reject a caller-chosen display name that carries a channel-wide mention, in
 * either spelling (`<!channel>` or a plain `@channel`). The model-layer writers
 * neutralize such a name unconditionally, which is what keeps card-derived names
 * safe; here — where a human picked the name through the admin — refusing beats
 * silently storing a name that reads differently than they asked for.
 */
function ensureNoBroadcastName(displayName?: string): ToolResult | null {
  if (displayName !== undefined && hasSlackBroadcast(displayName)) {
    return {
      error:
        "Display name cannot contain a channel-wide mention — @channel, @here, " +
        "@everyone, or their <!channel> / <!subteam^…> form. They would notify " +
        "everyone in the channel."
    };
  }
  return null;
}

/**
 * Reject a value that is not a deadline at all. A type sanity check, not a policy
 * on the range: how long an agent may take is the operator's business, so there is
 * no upper bound and nothing is clamped — a nonsense value comes back as a tool
 * result the model can read and retry, rather than a zod schema failure it cannot.
 */
function ensureValidDeadline(seconds?: number): ToolResult | null {
  if (seconds === undefined) return null;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return {
      error:
        "taskDeadlineSeconds must be a whole number of seconds greater than " +
        `zero. Omit it for the ${DEFAULT_TASK_DEADLINE_SECONDS / 60}-minute default.`
    };
  }
  return null;
}

/** Resolve a write target: must exist, belong to this workspace, and be a custom agent. */
async function requireWritableAgent(
  deps: AdminToolDeps,
  name: string
): Promise<AgentRow | { error: string }> {
  if (RESERVED_NAMES.has(name)) {
    return { error: `"${name}" is a built-in agent and cannot be modified.` };
  }
  const a = await getAgent(name);
  if (!a || a.workspaceId !== deps.wsId) {
    return { error: `No agent "${name}" in workspace ${deps.wsId}.` };
  }
  if (a.kind !== "remote") {
    return { error: `"${name}" is a built-in agent and cannot be modified.` };
  }
  return a;
}

/** The org-only tools refuse on any instance but the org's. */
function ensureOrgInstance(
  deps: AdminToolDeps,
  what: string
): ToolResult | null {
  if (deps.wsId !== ORG_WORKSPACE_ID) {
    return { error: `${what} is only available to the org admin.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure handlers (exported for tests) — return JSON-serializable results.
// ---------------------------------------------------------------------------

export async function agentsRead(
  deps: AdminToolDeps,
  args: { name?: string }
): Promise<ToolResult> {
  if (args.name) {
    const a = await getAgent(args.name);
    return {
      agents: a && a.workspaceId === deps.wsId ? [await present(a)] : []
    };
  }
  const rows = await listAgentsForWorkspace(deps.wsId);
  const channelRows = await listChannelsForAgents(rows.map((r) => r.name));
  const byAgent = new Map<string, string[]>();
  for (const { agentName, channelId } of channelRows) {
    const entry = byAgent.get(agentName);
    if (entry) entry.push(channelId);
    else byAgent.set(agentName, [channelId]);
  }
  return { agents: rows.map((a) => shape(a, byAgent.get(a.name) ?? [])) };
}

export type AgentsCreateArgs = {
  name: string;
  displayName?: string;
  a2aEndpoint: string;
  tenantId: string;
  notifyOn: NotifyOn;
  taskDeadlineSeconds?: number;
};

export async function agentsCreate(
  deps: AdminToolDeps,
  args: AgentsCreateArgs
): Promise<ToolResult> {
  const rejected = ensureNoBroadcastName(args.displayName);
  if (rejected) return rejected;
  const badDeadline = ensureValidDeadline(args.taskDeadlineSeconds);
  if (badDeadline) return badDeadline;

  if (RESERVED_NAMES.has(args.name))
    return { error: `"${args.name}" is a reserved built-in agent name.` };
  if (await getAgent(args.name))
    return { error: `An agent named "${args.name}" already exists.` };
  if (!args.tenantId.trim())
    return { error: "A tenant id is required to register a custom agent." };
  let verified: VerifiedAgentCard;
  try {
    verified = await deps.verifyEndpoint(args.a2aEndpoint, args.tenantId);
  } catch (err) {
    return {
      error: `Endpoint verification failed: ${(err as Error).message}`
    };
  }
  const row = await registerAgent({
    name: args.name,
    kind: "remote",
    displayName: args.displayName ?? verified.displayName,
    // No icon at registration — a custom agent's avatar is gatekeeper-hosted and set
    // later by the admin via `agents_regenerate_avatar` (never from the card).
    //
    // The *resolved* endpoint, not what was typed: only the origin of the input
    // was used, and the agent's own card named the path. Storing the input would
    // put a guess where dispatch and the `aud` both read from.
    a2aEndpoint: verified.endpoint,
    tenantId: args.tenantId.trim(),
    notifyOn: args.notifyOn,
    // Absent is not "no limit": pass the gatekeeper default explicitly so the
    // stored row always names the budget it will actually be held to.
    taskDeadlineSeconds:
      args.taskDeadlineSeconds ?? DEFAULT_TASK_DEADLINE_SECONDS,
    workspaceId: deps.wsId,
    cardSigningJku: verified.pin.cardSigningJku,
    cardSigningKid: verified.pin.cardSigningKid
  });
  return { ok: true, agent: await present(row) };
}

export type AgentsUpdateArgs = {
  name: string;
  displayName?: string;
  enabled?: boolean;
  a2aEndpoint?: string;
  tenantId?: string;
  notifyOn?: NotifyOn;
  taskDeadlineSeconds?: number;
};

export async function agentsUpdate(
  deps: AdminToolDeps,
  args: AgentsUpdateArgs
): Promise<ToolResult> {
  const rejected = ensureNoBroadcastName(args.displayName);
  if (rejected) return rejected;
  const badDeadline = ensureValidDeadline(args.taskDeadlineSeconds);
  if (badDeadline) return badDeadline;

  const target = await requireWritableAgent(deps, args.name);
  if ("error" in target) return target;
  // A re-pointed endpoint is re-verified and must keep the SAME pinned
  // signing identity (Trust-On-First-Use) — a different signer is rejected.
  // `displayName` is refreshed from the new card unless the caller explicitly
  // overrides it here. `iconUrl` is NOT touched — the avatar is gatekeeper-hosted
  // and admin-generated, so it survives endpoint changes.
  //
  // A changed *tenant* re-verifies for the same reason a changed endpoint does:
  // it re-points the agent at a different agent, and the new tenant has to
  // actually exist there. Skipping it would let a typo register cleanly and
  // fail on the next dispatch instead.
  let verified: VerifiedAgentCard | undefined;
  const tenantId = args.tenantId?.trim() ?? target.tenantId;
  // Re-verify whenever an endpoint was *supplied*, rather than when it differs
  // from the stored one. The stored value is resolved from the agent's card and
  // the argument is a raw URL whose path is ignored, so comparing them compares
  // two different things — passing the origin of an already-registered agent
  // would read as a change, and passing the resolved endpoint verbatim would
  // read as no change even if the card has since moved.
  if (args.a2aEndpoint !== undefined || tenantId !== target.tenantId) {
    if (!tenantId) {
      return { error: `A tenant id is required for "${args.name}".` };
    }
    try {
      // With no new URL, re-resolve against the origin already registered.
      verified = await deps.verifyEndpoint(
        args.a2aEndpoint ?? target.a2aEndpoint,
        tenantId
      );
    } catch (err) {
      return {
        error: `Endpoint verification failed: ${(err as Error).message}`
      };
    }
    if (
      target.cardSigningKid &&
      (verified.pin.cardSigningKid !== target.cardSigningKid ||
        verified.pin.cardSigningJku !== target.cardSigningJku)
    ) {
      return {
        error:
          `New endpoint for "${args.name}" is signed by a different key than the ` +
          `one pinned at registration. If the agent's signing identity changed ` +
          `intentionally, call agents_repin to pin the key the card now ` +
          `advertises — without unregistering the agent.`
      };
    }
  }
  await updateAgent(args.name, {
    displayName:
      args.displayName !== undefined ? args.displayName : verified?.displayName,
    enabled: args.enabled,
    // Only ever the endpoint re-verification resolved from the card. When
    // nothing was re-verified there is nothing to write, and writing the raw
    // argument would store a path the agent never advertised.
    a2aEndpoint: verified?.endpoint,
    tenantId: args.tenantId?.trim(),
    notifyOn: args.notifyOn,
    // Omitted leaves the stored budget alone — the same patch semantics as every
    // field here. Back to the default means naming the default.
    taskDeadlineSeconds: args.taskDeadlineSeconds,
    ...(verified
      ? {
          cardSigningJku: verified.pin.cardSigningJku,
          cardSigningKid: verified.pin.cardSigningKid
        }
      : {})
  });
  const updated = await getAgent(args.name);
  return {
    ok: true,
    agent: updated ? await present(updated) : null
  };
}

export type AgentsAllowChannelArgs = { name: string; channelId: string };

export async function agentsAllowChannel(
  deps: AdminToolDeps,
  args: AgentsAllowChannelArgs
): Promise<ToolResult> {
  const target = await requireWritableAgent(deps, args.name);
  if ("error" in target) return target;
  if (isDmChannel(args.channelId)) {
    return {
      error:
        "DM channels are reserved for the onboarding agent and cannot be assigned to custom agents."
    };
  }
  const adminWs = await getWorkspaceByAdminChannel(args.channelId);
  if (adminWs) {
    return { error: "Admin channels cannot be assigned to custom agents." };
  }
  await attachAgentChannel({
    agentName: args.name,
    channelId: args.channelId,
    workspaceId: deps.wsId
  });
  return { ok: true, agent: await present(target) };
}

export type AgentsRevokeChannelArgs = { name: string; channelId: string };

export async function agentsRevokeChannel(
  deps: AdminToolDeps,
  args: AgentsRevokeChannelArgs
): Promise<ToolResult> {
  const target = await requireWritableAgent(deps, args.name);
  if ("error" in target) return target;
  await detachAgentChannel(args.name, args.channelId);
  return { ok: true, agent: await present(target) };
}

export type AgentsRegenerateAvatarArgs = {
  name: string;
  instructions?: string;
};

export async function agentsRegenerateAvatar(
  deps: AdminToolDeps,
  args: AgentsRegenerateAvatarArgs
): Promise<ToolResult> {
  const target = await requireWritableAgent(deps, args.name);
  if ("error" in target) return target;
  const prompt = buildAgentAvatarPrompt({
    agentName: target.name,
    displayName: target.displayName,
    instructions: args.instructions
  });
  const result = await generateAndStoreIcon(deps, target.name, prompt);
  if ("error" in result) return result;
  await updateAgent(args.name, { iconUrl: result.iconUrl });
  const updated = await getAgent(args.name);
  return {
    ok: true,
    agent: updated ? await present(updated) : null,
    note: `Avatar generated for "${args.name}" — it appears on the agent's next reply.`
  };
}

export type AgentsDeleteArgs = { name: string };

/** Delete a custom agent and its channel mappings. */
export async function agentsDelete(
  deps: AdminToolDeps,
  args: AgentsDeleteArgs
): Promise<ToolResult> {
  const target = await requireWritableAgent(deps, args.name);
  if ("error" in target) return target;
  await unregisterAgent(args.name);
  return { ok: true, deleted: args.name };
}

export type AgentsRepinArgs = { name: string };

/**
 * Re-read a custom agent's AgentCard and pin the signing identity it now
 * advertises.
 *
 * The deliberate hole in Trust-On-First-Use. TOFU is what makes a validly-signed
 * token from *any other* key a rejection rather than a login, so every other path
 * treats a changed signer as an attack: `agentsUpdate` refuses outright, and
 * callback verification fails with "callback token key does not match the agent's
 * pinned signing key". But an operator who rotates their own agent's key is not
 * an attacker, and without this their only recourse is deleting the agent and
 * registering it again — which drops its channel mappings and its avatar to fix
 * a single column.
 *
 * Nothing but the pin moves: the card is re-read at the endpoint and tenant
 * already on the row, so this cannot re-point an agent somewhere else. A card
 * that still names the pinned key is a no-op, and says so.
 */
export async function agentsRepin(
  deps: AdminToolDeps,
  args: AgentsRepinArgs
): Promise<ToolResult> {
  const target = await requireWritableAgent(deps, args.name);
  if ("error" in target) return target;

  let verified: VerifiedAgentCard;
  try {
    verified = await deps.verifyEndpoint(target.a2aEndpoint, target.tenantId);
  } catch (err) {
    return {
      error: `Endpoint verification failed: ${(err as Error).message}`
    };
  }

  const { cardSigningJku: jku, cardSigningKid: kid } = verified.pin;
  if (jku === target.cardSigningJku && kid === target.cardSigningKid) {
    return {
      ok: true,
      changed: false,
      note:
        `"${args.name}" is already pinned to the key its card advertises ` +
        `(kid \`${kid}\`). Nothing to change.`
    };
  }

  await updateAgent(args.name, { cardSigningJku: jku, cardSigningKid: kid });
  return {
    ok: true,
    changed: true,
    previous: { jku: target.cardSigningJku, kid: target.cardSigningKid },
    pinned: { jku, kid },
    note: `Re-pinned agent "${args.name}" to signing key "${kid}".`
  };
}

export async function workspaceRead(
  deps: AdminToolDeps,
  args: { id?: number }
): Promise<ToolResult> {
  const isOrg = deps.wsId === ORG_WORKSPACE_ID;
  if (args.id !== undefined) {
    if (!isOrg && args.id !== deps.wsId)
      return { error: `This admin can only read workspace ${deps.wsId}.` };
    const ws = await getWorkspace(args.id);
    return { workspaces: ws ? [ws] : [] };
  }
  if (isOrg) return { workspaces: await listWorkspaces() };
  const ws = await getWorkspace(deps.wsId);
  return { workspaces: ws ? [ws] : [] };
}

export type WorkspaceCreateArgs = { name: string };

export async function workspaceCreate(
  deps: AdminToolDeps,
  args: WorkspaceCreateArgs
): Promise<ToolResult> {
  const denied = ensureOrgInstance(deps, "Workspace management");
  if (denied) return denied;

  const ws = await createWorkspace({ name: args.name });
  return { ok: true, workspace: ws };
}

export type WorkspaceSetAdminChannelArgs = { id: number; channelId: string };

async function workspaceSetAdminChannel(
  deps: AdminToolDeps,
  args: WorkspaceSetAdminChannelArgs
): Promise<ToolResult> {
  const denied = ensureOrgInstance(deps, "Workspace management");
  if (denied) return denied;

  if (!(await getWorkspace(args.id)))
    return { error: `Workspace ${args.id} not found.` };
  await setWorkspaceAdminChannel(args.id, args.channelId);
  return { ok: true, workspace: await getWorkspace(args.id) };
}

// ---------------------------------------------------------------------------
// agents_domains — org-only allow-list of domains for remote (custom) agents.
// ---------------------------------------------------------------------------

/**
 * Normalize a caller-supplied domain: strip any scheme/path/port, require a
 * multi-label host, and reject shared-infra roots. Shared by the add/remove
 * tools (list needs none of it).
 */
function normalizeAgentDomain(
  raw: string
): { domain: string } | { error: string } {
  const rawDomain = raw.trim().toLowerCase();

  // Strip any scheme/path/port the caller may have included.
  let domain: string;
  try {
    domain = rawDomain.includes("://")
      ? new URL(rawDomain).hostname
      : new URL(`https://${rawDomain}`).hostname;
  } catch {
    return { error: `'${raw}' is not a valid domain.` };
  }

  if (!domain || !domain.includes(".")) {
    return {
      error: `'${raw}' must be a multi-label domain (e.g. 'agents.example.com').`
    };
  }

  if (SHARED_INFRA_ROOTS.has(domain)) {
    return {
      error:
        `'${domain}' is a shared infrastructure root domain — any third-party ` +
        `can deploy under it and forge agent identities in A2A key verification. ` +
        `Add a specific account-level subdomain you control instead ` +
        `(e.g. 'myorg.${domain}').`
    };
  }

  return { domain };
}

export async function agentsDomainsList(
  deps: AdminToolDeps
): Promise<ToolResult> {
  const denied = ensureOrgInstance(deps, "Remote agent domain management");
  if (denied) return denied;

  return {
    approvedDomains: await getAllowedRemoteAgentDomains(),
    note:
      "Each entry covers that domain and all its subdomains. " +
      "An empty list means no custom (remote) agents are approved."
  };
}

export async function agentsDomainsAdd(
  deps: AdminToolDeps,
  args: { domain: string }
): Promise<ToolResult> {
  const denied = ensureOrgInstance(deps, "Remote agent domain management");
  if (denied) return denied;

  const normalized = normalizeAgentDomain(args.domain);
  if ("error" in normalized) return normalized;
  const { domain } = normalized;

  const current = await getAllowedRemoteAgentDomains();
  if (current.includes(domain)) {
    return {
      ok: true,
      approvedDomains: current,
      note: `'${domain}' was already approved.`
    };
  }
  const updated = [...current, domain];
  await setAllowedRemoteAgentDomains(updated);
  return {
    ok: true,
    approvedDomains: updated,
    note:
      `'${domain}' and all its subdomains are now approved for remote agents. ` +
      `Only add domains your organization fully controls.`
  };
}

export async function agentsDomainsRemove(
  deps: AdminToolDeps,
  args: { domain: string }
): Promise<ToolResult> {
  const denied = ensureOrgInstance(deps, "Remote agent domain management");
  if (denied) return denied;

  const normalized = normalizeAgentDomain(args.domain);
  if ("error" in normalized) return normalized;
  const { domain } = normalized;

  const current = await getAllowedRemoteAgentDomains();
  if (!current.includes(domain)) {
    return {
      ok: true,
      approvedDomains: current,
      note: `'${domain}' was not in the approved list.`
    };
  }
  const updated = current.filter((d) => d !== domain);
  await setAllowedRemoteAgentDomains(updated);
  return { ok: true, approvedDomains: updated };
}

// ---------------------------------------------------------------------------
// Avatar generation — shared by the admin self-avatar and custom-agent avatars.
// ---------------------------------------------------------------------------

/**
 * Generate an avatar image and persist it in the workspace's avatar store under
 * `name`, returning its public gatekeeper URL (`/icons/{wsId}/{name}/{key}.jpg`,
 * served by that store).
 * Guards the image seams and the public-URL precondition. Shared by the admin's own
 * avatar (`name === "admin"`) and custom-agent avatars (`name === agent name`).
 */
async function generateAndStoreIcon(
  deps: AdminToolDeps,
  name: string,
  prompt: string
): Promise<{ iconUrl: string } | { error: string }> {
  if (!deps.generateImage || !deps.storeIcon)
    return { error: "Avatar generation is not available in this environment." };

  const publicUrl = await getPublicUrl();
  if (!publicUrl)
    return {
      error:
        "The gatekeeper's public URL isn't known yet (it's discovered after the " +
        "first Slack event). Try again shortly."
    };

  let stored: { key: string; contentType: string };
  try {
    const img = await deps.generateImage(prompt);
    stored = await deps.storeIcon(img, name);
  } catch (err) {
    return { error: `Avatar generation failed: ${(err as Error).message}` };
  }

  if (stored.contentType !== "image/jpeg")
    throw new Error(`Unexpected avatar content type: ${stored.contentType}`);
  return {
    iconUrl: `${publicUrl}/icons/${deps.wsId}/${name}/${stored.key}.jpg`
  };
}

// ---------------------------------------------------------------------------
// self_* — the admin agent mutates its OWN identity (avatar, display name).
// ---------------------------------------------------------------------------

export type SelfSetAvatarArgs = { instructions?: string };

export async function selfSetAvatar(
  deps: AdminToolDeps,
  args: SelfSetAvatarArgs
): Promise<ToolResult> {
  const ws = await getWorkspace(deps.wsId);
  const workspaceName = ws?.name ?? `workspace ${deps.wsId}`;
  const prompt = buildAvatarPrompt({
    workspaceName,
    instructions: args.instructions
  });
  const result = await generateAndStoreIcon(deps, "admin", prompt);
  if ("error" in result) return result;
  await setAdminIconUrl(deps.wsId, result.iconUrl);
  return {
    ok: true,
    iconUrl: result.iconUrl,
    note: "Avatar regenerated — it appears on the admin agent's next reply."
  };
}

export type SelfSetDisplayNameArgs = { displayName: string };

export async function selfSetDisplayName(
  deps: AdminToolDeps,
  args: SelfSetDisplayNameArgs
): Promise<ToolResult> {
  const rejected = ensureNoBroadcastName(args.displayName);
  if (rejected) return rejected;

  const displayName = sanitizeDisplayName(args.displayName);
  if (!displayName) return { error: "Display name cannot be empty." };
  await setAdminDisplayName(deps.wsId, displayName);
  return {
    ok: true,
    displayName,
    note: "Display name updated — it appears on the admin agent's next reply."
  };
}

// ---------------------------------------------------------------------------

/**
 * Build the admin tool set for one instance. The `workspace_*` and
 * `agents_domains_*` tools are org-only (built only on `admin:0`).
 */
export function buildAdminTools(deps: AdminToolDeps): ToolSet {
  const tools: ToolSet = {
    agents_read: tool({
      description:
        "List or look up agents in this workspace. Omit `name` to list all.",
      inputSchema: z.object({
        name: z.string().optional().describe("Exact agent name to look up")
      }),
      execute: (args) => agentsRead(deps, args)
    }),
    agents_create: tool({
      description:
        "Register a new custom agent in this workspace. Verifies the A2A " +
        "endpoint and pins its signing identity. A custom agent has no avatar " +
        "until you generate one with agents_regenerate_avatar.",
      inputSchema: z.object({
        name: z
          .string()
          .regex(
            /^[a-z0-9_-]+$/,
            "Agent name must be a lowercase slug (a-z, 0-9, _ or -)"
          )
          .describe("Unique agent name"),
        displayName: z.string().optional(),
        a2aEndpoint: z
          .string()
          .describe(
            "Any URL on the agent's host (required) — an origin, an endpoint, " +
              "or a card URL all work. Only the host is used: the agent's own " +
              "published card names the real endpoint, so paste whatever the " +
              "agent's developer gave you without worrying about the path."
          ),
        tenantId: z
          .string()
          .min(1)
          .describe(
            "Which agent at that endpoint (required). One endpoint can serve " +
              "several agents, so the URL alone does not identify one — the " +
              "agent's operator gives you this id (e.g. `generic`). It is sent " +
              "on every request and verified against the agent's card at " +
              "registration."
          ),
        notifyOn: z
          .enum(["mention", "channel_messages"])
          .describe(
            "When the agent is woken (required): `mention` = only on a name mention; `channel_messages` = every channel message"
          ),
        taskDeadlineSeconds: z
          .number()
          .optional()
          .describe(
            "How long this agent gets to finish one turn before the gatekeeper " +
              "stops the task, in seconds. Omit for the 1 hour default. Any " +
              "positive whole number; there is no upper limit, but anything " +
              "under 360 is in practice enforced at about 6 minutes."
          )
      }),
      execute: (args) => agentsCreate(deps, args)
    }),
    agents_update: tool({
      description:
        "Change a custom agent's fields (display name, enabled, endpoint, " +
        "notifyOn, taskDeadlineSeconds). Built-in admin/onboarding agents " +
        "cannot be modified.",
      inputSchema: z.object({
        name: z.string(),
        displayName: z.string().optional(),
        enabled: z
          .boolean()
          .optional()
          .describe(
            "Set false to disable — disabled agents receive no messages and won't be routed to"
          ),
        a2aEndpoint: z
          .string()
          .optional()
          .describe(
            "Re-point the agent at a host. Any URL on it; the path is ignored " +
              "and the card is re-read, so supplying this always re-verifies."
          ),
        tenantId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Change which agent at the endpoint this row addresses. Re-verifies " +
              "against the agent's card, same as changing the endpoint does."
          ),
        notifyOn: z
          .enum(["mention", "channel_messages"])
          .optional()
          .describe(
            "Change when the agent is woken: mention vs channel_messages"
          ),
        taskDeadlineSeconds: z
          .number()
          .optional()
          .describe(
            "Change how long this agent gets to finish one turn before the " +
              "gatekeeper stops the task, in seconds. Omit to leave it " +
              "unchanged; pass 3600 to put it back to the 1 hour default. Any " +
              "positive whole number; there is no upper limit, but anything " +
              "under 360 is in practice enforced at about 6 minutes. The new " +
              "value applies to the agent's next turns: a turn already running " +
              "keeps the limit it started with."
          )
      }),
      execute: (args) => agentsUpdate(deps, args)
    }),
    agents_allow_channel: tool({
      description:
        "Make a custom agent routable in a channel (one channel per call).",
      inputSchema: z.object({
        name: z.string(),
        channelId: z
          .string()
          .describe("A channel id to make this agent routable in")
      }),
      execute: (args) => agentsAllowChannel(deps, args)
    }),
    agents_revoke_channel: tool({
      description:
        "Stop routing a custom agent in a channel (one channel per call).",
      inputSchema: z.object({
        name: z.string(),
        channelId: z
          .string()
          .describe("A channel id to stop routing this agent in")
      }),
      execute: (args) => agentsRevokeChannel(deps, args)
    }),
    agents_regenerate_avatar: tool({
      description:
        "AI-generate a new avatar for a custom agent (optionally with art direction).",
      inputSchema: z.object({
        name: z.string(),
        instructions: z
          .string()
          .optional()
          .describe(
            "Optional art direction for the avatar: style, colors, motifs, mood"
          )
      }),
      execute: (args) => agentsRegenerateAvatar(deps, args)
    }),
    agents_delete: tool({
      description:
        "Delete a custom agent and its channel mappings. Irreversible: the " +
        "agent, its channels and its pending tasks are removed for good.",
      inputSchema: z.object({ name: z.string() }),
      execute: (args) => agentsDelete(deps, args)
    }),
    agents_repin: tool({
      description:
        "Re-read a custom agent's AgentCard and pin the signing key it now " +
        "advertises. Use when an agent's callbacks fail with \"callback token " +
        "key does not match the agent's pinned signing key\" because its " +
        "operator rotated the key. Nothing but the pin changes — the endpoint, " +
        "tenant, channels and avatar are untouched.",
      inputSchema: z.object({ name: z.string() }),
      execute: (args) => agentsRepin(deps, args)
    }),
    workspace_read: tool({
      description:
        "Read workspace(s). Omit `id` to list (org admin) or get your own.",
      inputSchema: z.object({ id: z.coerce.number().int().optional() }),
      execute: (args) => workspaceRead(deps, args)
    }),
    // Self-service identity — the admin changes its OWN Slack presence. Built for
    // every admin instance. `self_set_avatar` needs the image seams (guarded at
    // runtime); `self_set_display_name` does not, so both are always registered.
    self_set_avatar: tool({
      description:
        "Change your own avatar (the admin agent's Slack presence). " +
        "AI-generates a new avatar from this workspace's name plus any art " +
        "direction. Takes effect on your next reply.",
      inputSchema: z.object({
        instructions: z
          .string()
          .optional()
          .describe(
            "Optional art direction for the avatar: style, colors, motifs, mood"
          )
      }),
      execute: (args) => selfSetAvatar(deps, args)
    }),
    self_set_display_name: tool({
      description:
        "Change your own display name (the admin agent's Slack presence). " +
        "Takes effect on your next reply.",
      inputSchema: z.object({
        displayName: z.string().describe("The admin agent's new display name")
      }),
      execute: (args) => selfSetDisplayName(deps, args)
    })
  };

  if (deps.wsId === ORG_WORKSPACE_ID) {
    tools.workspace_create = tool({
      description: "Org-admin only: create a workspace.",
      inputSchema: z.object({ name: z.string() }),
      execute: (args) => workspaceCreate(deps, args)
    });

    tools.workspace_set_admin_channel = tool({
      description: "Org-admin only: set a workspace's admin channel.",
      inputSchema: z.object({
        id: z.coerce.number().int(),
        channelId: z.string()
      }),
      execute: (args) => workspaceSetAdminChannel(deps, args)
    });

    // Shared safety note appended to each agents_domains_* description.
    const domainsHelp =
      "Each approved domain covers that domain and all its subdomains (e.g. " +
      "approving 'myorg.workers.dev' allows any agent hosted under it). Only add " +
      "domains your organization fully controls: A2A trusts the endpoint domain " +
      "for cryptographic key verification, so any subdomain of an approved entry " +
      "can host a verified agent. Shared platform roots (workers.dev, etc.) are " +
      "permanently blocked regardless. An empty list disables all remote agents.";

    tools.agents_domains_list = tool({
      description: `Org-admin only: list approved domains for remote (custom) A2A agents. ${domainsHelp}`,
      inputSchema: z.object({}),
      execute: () => agentsDomainsList(deps)
    });

    tools.agents_domains_add = tool({
      description: `Org-admin only: approve a domain for remote (custom) A2A agents. ${domainsHelp}`,
      inputSchema: z.object({
        domain: z
          .string()
          .describe("Domain to approve (covers all its subdomains)")
      }),
      execute: (args) => agentsDomainsAdd(deps, args)
    });

    tools.agents_domains_remove = tool({
      description: `Org-admin only: remove a domain from the remote-agent approved list. ${domainsHelp}`,
      inputSchema: z.object({
        domain: z.string().describe("Domain to remove from the approved list")
      }),
      execute: (args) => agentsDomainsRemove(deps, args)
    });
  }

  return tools;
}
