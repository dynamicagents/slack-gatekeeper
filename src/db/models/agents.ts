import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../client";
import * as schema from "../schema";
import { getWorkspaceByAdminChannel } from "./workspaces";
import { getAdminDisplayName, getAdminIconUrl } from "./workspace-configs";
import { sanitizeDisplayName } from "@/util/display-name";

export type AgentRow = typeof schema.agents.$inferSelect;
/** Where an agent runs: `local` in-process, `remote` over HTTP. */
export type AgentKind = AgentRow["kind"];
/**
 * The tenants hosted in-repo as Durable Objects.
 *
 * Declared rather than derived from {@link AgentKind}, which no longer names
 * individual built-ins, and deliberately a closed union: it is what makes the
 * local callback guard and `A2AAgent.builtinTenant()` compiler-checked. Widening
 * this to `string` would turn both into unchecked comparisons.
 */
export type BuiltinTenant = "admin" | "onboarding";
export type NotifyOn = AgentRow["notifyOn"];

export interface RegisterAgentInput {
  name: string;
  kind: AgentKind;
  displayName?: string | null;
  /** Required: custom agents are remote and addressed by this HTTP endpoint. */
  a2aEndpoint: string;
  /**
   * Required (no default): which agent to address at that endpoint.
   *
   * One origin serves several agents over a single A2A endpoint, so the
   * endpoint alone does not identify one. Non-empty for every kind — built-ins
   * carry their own (`admin`, `onboarding`) rather than a placeholder.
   */
  tenantId: string;
  /** Required (no default): when the agent is woken — mention vs every message. */
  notifyOn: NotifyOn;
  workspaceId: number;
  /** Pinned AgentCard signing identity (custom agents; verified at registration). */
  cardSigningJku?: string | null;
  cardSigningKid?: string | null;
  /** Gatekeeper-hosted, admin-generated avatar URL (never sourced from the AgentCard). */
  iconUrl?: string | null;
}

/** Patch for `updateAgent` — only provided fields are written. */
export interface UpdateAgentPatch {
  displayName?: string | null;
  iconUrl?: string | null;
  a2aEndpoint?: string;
  tenantId?: string;
  enabled?: boolean;
  notifyOn?: NotifyOn;
  cardSigningJku?: string | null;
  cardSigningKid?: string | null;
}

export interface AgentChannelEntry {
  agent: AgentRow;
  /** Workspace scope from the agent_channels row (not agents.workspace_id). */
  workspaceId: number | null;
}

/**
 * Insert a new agent row. Caller is responsible for uniqueness checks.
 *
 * `displayName` is sanitized here, at the write, so no unsafe name can enter the
 * table in the first place — see {@link sanitizeDisplayName}. This is the last
 * writer in the path, and the admin tools reject a *human-chosen* name outright
 * rather than silently rewriting it; sanitizing here covers the names the gatekeeper
 * does not control (a remote agent's own A2A card).
 */
export async function registerAgent(
  input: RegisterAgentInput
): Promise<AgentRow> {
  const db = getDb();
  const rows = await db
    .insert(schema.agents)
    .values({
      name: input.name.trim().toLowerCase(),
      kind: input.kind,
      displayName: sanitizeDisplayName(input.displayName ?? "") || null,
      iconUrl: input.iconUrl?.trim() || null,
      a2aEndpoint: input.a2aEndpoint,
      tenantId: input.tenantId,
      notifyOn: input.notifyOn,
      workspaceId: input.workspaceId,
      cardSigningJku: input.cardSigningJku ?? null,
      cardSigningKid: input.cardSigningKid ?? null
    })
    .returning();
  return rows[0];
}

/** Attach an agent to a channel (idempotent). */
export async function attachAgentChannel(input: {
  agentName: string;
  channelId: string;
  workspaceId: number | null;
}): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.agentChannels)
    .values({
      agentName: input.agentName,
      channelId: input.channelId,
      workspaceId: input.workspaceId
    })
    .onConflictDoNothing();
}

export async function getAgent(name: string): Promise<AgentRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  return rows[0] ?? null;
}

/** How an agent presents in Slack: `chat.postMessage`'s `username` + `icon_url`. */
export interface AgentRenderIdentity {
  /** Never null — the display name, falling back to the machine name. */
  displayName: string;
  /** Null = Slack renders the default bot icon. */
  iconUrl: string | null;
}

/**
 * Resolve how `agent` should render when posting into `channelId`.
 *
 * For every agent this is just its registry row — except the admin. `agents.name`
 * is the primary key, so the admin is ONE row backing one Durable Object instance
 * per workspace; its avatar and display name are therefore per-workspace values in
 * `workspace_configs` (written by the `self_set_avatar` / `self_set_display_name` tools), not row fields. Reading
 * the row directly renders every workspace's admin as the seeded "Admin Agent"
 * with no avatar, so every path that posts as an agent must go through here.
 */
export async function agentRenderIdentity(
  agent: AgentRow,
  channelId: string
): Promise<AgentRenderIdentity> {
  // Names are safe by construction here: every writer sanitizes (registerAgent,
  // updateAgent, setAdminDisplayName), so nothing needs defanging at render.
  const row: AgentRenderIdentity = {
    displayName: agent.displayName ?? agent.name,
    iconUrl: agent.iconUrl ?? null
  };
  if (agent.tenantId !== "admin") return row;

  // The admin only ever posts in its own workspace's admin channel, which is what
  // put it on this turn in the first place (see router/resolve.ts).
  const ws = await getWorkspaceByAdminChannel(channelId);
  if (!ws) return row;
  const [displayName, iconUrl] = await Promise.all([
    getAdminDisplayName(ws.id),
    getAdminIconUrl(ws.id)
  ]);
  return {
    displayName: displayName || row.displayName,
    iconUrl: iconUrl || row.iconUrl
  };
}

export async function listAgents(): Promise<AgentRow[]> {
  const db = getDb();
  return db.select().from(schema.agents);
}

/** Enabled agents configured for a channel, used for context default routing. */
export async function getAgentsForChannel(
  channelId: string
): Promise<AgentChannelEntry[]> {
  const db = getDb();
  const rows = await db
    .select({
      agent: schema.agents,
      workspaceId: schema.agentChannels.workspaceId
    })
    .from(schema.agentChannels)
    .innerJoin(
      schema.agents,
      eq(schema.agentChannels.agentName, schema.agents.name)
    )
    .where(
      and(
        eq(schema.agentChannels.channelId, channelId),
        eq(schema.agents.enabled, true)
      )
    );
  return rows;
}

/** Check if a specific agent is configured and enabled for a channel. */
export async function getAgentInChannel(
  channelId: string,
  agentName: string
): Promise<AgentChannelEntry | null> {
  const db = getDb();
  const rows = await db
    .select({
      agent: schema.agents,
      workspaceId: schema.agentChannels.workspaceId
    })
    .from(schema.agentChannels)
    .innerJoin(
      schema.agents,
      eq(schema.agentChannels.agentName, schema.agents.name)
    )
    .where(
      and(
        eq(schema.agentChannels.channelId, channelId),
        eq(schema.agentChannels.agentName, agentName),
        eq(schema.agents.enabled, true)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** All agents scoped to a workspace (registry CRUD listing for one admin instance). */
export async function listAgentsForWorkspace(
  workspaceId: number
): Promise<AgentRow[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId));
}

/** Channel ids this agent is attached to (via agent_channels). */
export async function getAgentChannels(agentName: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ channelId: schema.agentChannels.channelId })
    .from(schema.agentChannels)
    .where(eq(schema.agentChannels.agentName, agentName));
  return rows.map((r) => r.channelId);
}

/** Channel ids for a set of agents in one query (avoids N+1 in list paths). */
export async function listChannelsForAgents(
  agentNames: string[]
): Promise<{ agentName: string; channelId: string }[]> {
  const db = getDb();
  if (agentNames.length === 0) return [];
  return db
    .select({
      agentName: schema.agentChannels.agentName,
      channelId: schema.agentChannels.channelId
    })
    .from(schema.agentChannels)
    .where(inArray(schema.agentChannels.agentName, agentNames));
}

/**
 * Update mutable fields of an agent. Only provided patch fields are written.
 * `displayName` is sanitized on the way in for the same reason as in
 * {@link registerAgent}.
 */
export async function updateAgent(
  name: string,
  patch: UpdateAgentPatch
): Promise<AgentRow | null> {
  const db = getDb();
  const rows = await db
    .update(schema.agents)
    .set({
      ...(patch.displayName !== undefined
        ? { displayName: sanitizeDisplayName(patch.displayName ?? "") || null }
        : {}),
      ...(patch.iconUrl !== undefined
        ? { iconUrl: patch.iconUrl?.trim() || null }
        : {}),
      ...(patch.a2aEndpoint !== undefined
        ? { a2aEndpoint: patch.a2aEndpoint }
        : {}),
      ...(patch.tenantId !== undefined ? { tenantId: patch.tenantId } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.notifyOn !== undefined ? { notifyOn: patch.notifyOn } : {}),
      ...(patch.cardSigningJku !== undefined
        ? { cardSigningJku: patch.cardSigningJku }
        : {}),
      ...(patch.cardSigningKid !== undefined
        ? { cardSigningKid: patch.cardSigningKid }
        : {}),
      updatedAt: sql`(unixepoch())`
    })
    .where(eq(schema.agents.name, name))
    .returning();
  return rows[0] ?? null;
}

/**
 * Delete an agent and everything that references it. `agents.name` is the FK
 * parent of `agent_channels`, `agent_tasks` and `hitl_requests`, all declared
 * `ON DELETE no action` — and D1 *does* enforce foreign keys, so every child
 * has to go first or the parent delete is rejected outright.
 *
 * One `batch` so it is all-or-nothing: run as separate statements, a rejected
 * parent delete leaves the agent registered but stripped of its channels —
 * present in the registry and unreachable from Slack.
 */
export async function unregisterAgent(name: string): Promise<void> {
  const db = getDb();
  await db.batch([
    db
      .delete(schema.agentChannels)
      .where(eq(schema.agentChannels.agentName, name)),
    db.delete(schema.agentTasks).where(eq(schema.agentTasks.agentName, name)),
    db
      .delete(schema.hitlRequests)
      .where(eq(schema.hitlRequests.agentName, name)),
    db.delete(schema.agents).where(eq(schema.agents.name, name))
  ]);
}

/** Detach an agent from a channel. */
export async function detachAgentChannel(
  agentName: string,
  channelId: string
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.agentChannels)
    .where(
      and(
        eq(schema.agentChannels.agentName, agentName),
        eq(schema.agentChannels.channelId, channelId)
      )
    );
}
