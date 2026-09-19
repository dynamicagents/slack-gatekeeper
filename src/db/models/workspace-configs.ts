import { eq, sql, and } from "drizzle-orm";
import { getDb } from "../client";
import * as schema from "../schema";
import { ORG_WORKSPACE_ID } from "./workspaces";
import { sanitizeDisplayName } from "@/util/slack-text";

// ---------------------------------------------------------------------------
// Key namespaces
// ---------------------------------------------------------------------------

/**
 * Keys managed by the org admin agent at runtime (workspace 0).
 * Unlike {@link SystemConfigKeys}, these are exposed through admin tools and
 * intentionally mutable by the org admin.
 */
const OperatorConfigKeys = {
  /**
   * JSON array of approved domain patterns for remote (custom) A2A agents.
   * Each entry covers that domain and all its subdomains. Stored on workspace 0
   * and applies org-wide. An absent or empty array means no remote agents are
   * approved (deny-all). Managed via the `agents_domains_add` / `agents_domains_remove` admin tools.
   */
  REMOTE_AGENT_ALLOWED_DOMAINS: "remote_agent_allowed_domains",
  /**
   * Public URL of this workspace's admin-agent avatar, generated via Workers AI
   * and served from the per-workspace admin DO (`/icons/{wsId}/admin/{key}`).
   * Stored per workspace so each admin instance has its own avatar; read by the
   * router to override the shared `admin` registry row's iconUrl. Managed via the
   * `self_set_avatar` admin tool.
   */
  ADMIN_ICON_URL: "admin_icon_url",
  /**
   * Display name of this workspace's admin agent, set by the admin itself via the
   * `self_set_display_name` tool. Stored per workspace (the `admin` registry row is shared
   * across workspaces) and read by the router to override the row's displayName.
   * Write it only through {@link setAdminDisplayName}, which sanitizes it.
   */
  ADMIN_DISPLAY_NAME: "admin_display_name"
} as const;

/**
 * Keys written only by internal system code (reconcile, first-request discovery).
 * Not exposed through admin tools: writing one through {@link setConfig} is an
 * intentional operator override, not routine configuration. Keep custom keys out
 * of this namespace to avoid colliding with them.
 */
export const SystemConfigKeys = {
  /**
   * The Slack `team_id` this worker is anchored to. Written once by the first
   * successful reconcile (Trust-On-First-Use); never overwritten by reconcile
   * thereafter. Compared against every incoming `/slack/events` `team_id`.
   */
  SLACK_TEAM_ID: "slack_team_id",
  /**
   * The public origin (scheme + host) of this deployed worker. Auto-discovered
   * on the first inbound `/slack/events` request and cached in the module scope
   * for the isolate's lifetime. Written to D1 once per isolate cold-start so the
   * Message Workflow (which has no `Request` in scope) can read it for JWT signing.
   * Updates automatically when Cloudflare recycles isolates after a domain change.
   */
  PUBLIC_URL: "public_url"
} as const;

export type SystemConfigKey =
  (typeof SystemConfigKeys)[keyof typeof SystemConfigKeys];

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Upsert a config value for a workspace+key pair.
 * Calling this on a system key from outside internal code is intentional only
 * for deliberate operator overrides (e.g. resetting the team anchor after an
 * intentional workspace migration).
 */
export async function setConfig(
  workspaceId: number,
  key: string,
  value: string
): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.workspaceConfigs)
    .values({ workspaceId, key, value })
    .onConflictDoUpdate({
      target: [
        schema.workspaceConfigs.workspaceId,
        schema.workspaceConfigs.key
      ],
      set: { value, updatedAt: sql`(unixepoch())` }
    });
}

/**
 * Read a config value for a workspace+key pair.
 * Returns `null` when the row does not exist (absence = unset).
 */
export async function getConfig(
  workspaceId: number,
  key: string
): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ value: schema.workspaceConfigs.value })
    .from(schema.workspaceConfigs)
    .where(
      and(
        eq(schema.workspaceConfigs.workspaceId, workspaceId),
        eq(schema.workspaceConfigs.key, key)
      )
    )
    .limit(1);
  return rows[0]?.value ?? null;
}

/**
 * Remove a config entry entirely (absence = unset).
 * No-op if the row does not exist.
 */
export async function unsetConfig(
  workspaceId: number,
  key: string
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.workspaceConfigs)
    .where(
      and(
        eq(schema.workspaceConfigs.workspaceId, workspaceId),
        eq(schema.workspaceConfigs.key, key)
      )
    );
}

// ---------------------------------------------------------------------------
// System config helpers (org-level, workspace 0)
// ---------------------------------------------------------------------------

export async function getSlackTeamId(): Promise<string | null> {
  return getConfig(ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID);
}

export async function setSlackTeamId(teamId: string): Promise<void> {
  return setConfig(ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID, teamId);
}

export async function getPublicUrl(): Promise<string | null> {
  return getConfig(ORG_WORKSPACE_ID, SystemConfigKeys.PUBLIC_URL);
}

export async function setPublicUrl(url: string): Promise<void> {
  return setConfig(ORG_WORKSPACE_ID, SystemConfigKeys.PUBLIC_URL, url);
}

// ---------------------------------------------------------------------------
// Operator config helpers (org-level, workspace 0)
// ---------------------------------------------------------------------------

/**
 * Read the org-wide list of approved remote agent domains from workspace 0.
 * Returns an empty array if not configured (which means no remote agents are
 * approved — deny-all semantics enforced in `validateRemoteEndpoint`).
 */
export async function getAllowedRemoteAgentDomains(): Promise<string[]> {
  const raw = await getConfig(
    ORG_WORKSPACE_ID,
    OperatorConfigKeys.REMOTE_AGENT_ALLOWED_DOMAINS
  );
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function setAllowedRemoteAgentDomains(
  domains: string[]
): Promise<void> {
  return setConfig(
    ORG_WORKSPACE_ID,
    OperatorConfigKeys.REMOTE_AGENT_ALLOWED_DOMAINS,
    JSON.stringify(domains)
  );
}

/**
 * Read the admin avatar URL for a workspace (null = use the default bot icon).
 * Workspace-scoped: each admin instance has its own avatar.
 */
export async function getAdminIconUrl(
  workspaceId: number
): Promise<string | null> {
  return getConfig(workspaceId, OperatorConfigKeys.ADMIN_ICON_URL);
}

/** Set (upsert) the admin avatar URL for a workspace. */
export async function setAdminIconUrl(
  workspaceId: number,
  url: string
): Promise<void> {
  return setConfig(workspaceId, OperatorConfigKeys.ADMIN_ICON_URL, url);
}

/**
 * Read the admin display name for a workspace (null = use the registry row's
 * default). Workspace-scoped: each admin instance has its own name.
 */
export async function getAdminDisplayName(
  workspaceId: number
): Promise<string | null> {
  return getConfig(workspaceId, OperatorConfigKeys.ADMIN_DISPLAY_NAME);
}

/**
 * Set (upsert) the admin display name for a workspace. The **only** writer of
 * this key: it sanitizes the name (see {@link sanitizeDisplayName}) so a stored
 * name can never carry a Slack command sequence into a message. Writing the key
 * through the generic {@link setConfig} bypasses that and is not allowed.
 */
export async function setAdminDisplayName(
  workspaceId: number,
  displayName: string
): Promise<void> {
  return setConfig(
    workspaceId,
    OperatorConfigKeys.ADMIN_DISPLAY_NAME,
    sanitizeDisplayName(displayName)
  );
}
