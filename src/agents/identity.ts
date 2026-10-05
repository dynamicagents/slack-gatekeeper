import type {
  GatekeeperIdentity,
  RemoteIdentity
} from "@dynamicagents/g2a-protocol";

/**
 * The identity the gatekeeper mints for a built-in tenant, and the one place its
 * format is written.
 *
 * Core names every object a task touches — the task host, the step agent — by
 * the verified `identity.key`, so the key *is* the grain of a built-in's memory:
 * the admin keeps one per workspace and onboarding one per direct-message
 * channel. Both are named by a channel because a cancel or an answered
 * question knows the channel and nothing about the person. Changing a shape
 * below re-keys that tenant and its history starts empty.
 *
 * `kind: "local"` is what separates a built-in's token from a remote agent's.
 * The mounted tenants accept nothing else (see `./worker.ts`), so a remote row
 * pointed at this gatekeeper's own endpoint cannot reach the admin's tools.
 */
export const BUILTIN_KIND = "local";

/** The tenants this Worker hosts. */
export type BuiltinTenant = "admin" | "onboarding";

export function adminIdentity(wsId: number): RemoteIdentity {
  return {
    key: `admin:${wsId}`,
    name: "admin",
    kind: BUILTIN_KIND,
    workspaceId: wsId
  };
}

export function onboardingIdentity(
  dmChannelId: string,
  workspaceId: number
): RemoteIdentity {
  return {
    key: `onboarding:${dmChannelId}`,
    name: "onboarding",
    kind: BUILTIN_KIND,
    workspaceId
  };
}

const ADMIN_KEY = /^admin:(\d+)$/;
const ONBOARDING_KEY = /^onboarding:(D[A-Z0-9]+)$/;

/** The workspace an admin key names, or null for anything else. */
export function adminWorkspaceOf(key: string | undefined): number | null {
  const m = key ? ADMIN_KEY.exec(key) : null;
  return m ? Number(m[1]) : null;
}

/** The direct-message channel an onboarding key names, or null for anything else. */
export function onboardingChannelOf(key: string | undefined): string | null {
  const m = key ? ONBOARDING_KEY.exec(key) : null;
  return m ? m[1] : null;
}

/** Whether a verified identity is one the gatekeeper minted for `tenant`. */
export function isBuiltinIdentity(
  tenant: BuiltinTenant,
  identity: GatekeeperIdentity
): boolean {
  if (identity.kind !== BUILTIN_KIND) return false;
  return tenant === "admin"
    ? adminWorkspaceOf(identity.key) !== null
    : onboardingChannelOf(identity.key) !== null;
}
