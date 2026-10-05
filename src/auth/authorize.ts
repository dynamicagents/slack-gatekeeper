import { getSlackUser } from "@/db/models/users";
import { getAdminWorkspaces } from "@/db/models/workspace-admins";

/**
 * A user's resolved standing, built purely from the D1 registry (slack_users
 * flags + workspace_admins membership). It decides nothing: channel access is
 * the permission. It names the author of a `<turn>`, and scopes what the
 * onboarding concierge reports to a person as theirs.
 */
export interface UserAuthContext {
  slackUserId: string;
  displayName: string | null;
  isPrimaryOwner: boolean;
  isOrgAdmin: boolean;
  /** Workspace ids this user administers (derived from workspace_admins). */
  adminWorkspaces: number[];
}

/**
 * Build a user's auth context purely from the D1 registry (slack_users flags +
 * workspace_admins membership) — no Slack call on the hot path. An unknown user
 * yields a zero-permission context. This is the only I/O in this module.
 */
export async function buildUserAuthContext(
  slackUserId: string
): Promise<UserAuthContext> {
  const [user, adminWorkspaces] = await Promise.all([
    getSlackUser(slackUserId),
    getAdminWorkspaces(slackUserId)
  ]);
  return {
    slackUserId,
    displayName: user?.displayName ?? null,
    isPrimaryOwner: user?.isPrimaryOwner ?? false,
    isOrgAdmin: user?.isOrgAdmin ?? false,
    adminWorkspaces
  };
}
