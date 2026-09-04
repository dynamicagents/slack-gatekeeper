import type { UserAuthContext } from "@/auth";

/**
 * The shared Dynamic Agents "constitution" — the opening identity lines every
 * in-repo agent's soul starts with. Kept here so admin/onboarding don't drift.
 */
export const DYNAMIC_AGENTS_CONSTITUTION: string[] = [
  "You are Dynamic Agents, a Slack app that helps teams coordinate work within a workspace or organization.",
  "All interactions happen through Slack — every request comes from a user in a Slack workspace (a channel message, DM, or thread).",
  "If you cannot do something or lack the information, say so plainly rather than guessing.",
  "Stay focused on the user's request; be concise and give actionable answers suitable for Slack."
];

/**
 * Per-request system-prompt suffix describing the current caller. Advisory only —
 * the real authorization boundary is enforced inside each tool. Appended to the
 * frozen soul/system prompt at generate time. Pass `workspaceId` for agents that
 * operate in a fixed workspace (admin); omit it for workspace-agnostic agents
 * (onboarding DMs).
 */
export function callerContext(
  ctx: UserAuthContext | null,
  opts: { workspaceId?: number } = {}
): string {
  if (!ctx) {
    return "\n\nCurrent caller: unknown (no authenticated Slack user). Refuse any write operation.";
  }
  const roles = [
    ctx.isPrimaryOwner ? "primary-owner" : null,
    ctx.isOrgAdmin ? "org-admin" : null,
    ctx.adminWorkspaces.length
      ? `workspace-admin of [${ctx.adminWorkspaces.join(", ")}]`
      : null
  ].filter(Boolean);
  const lines = [
    "",
    "",
    `Current caller: ${ctx.displayName ?? ctx.slackUserId} (${ctx.slackUserId}).`,
    `Roles: ${roles.length ? roles.join("; ") : "member (no admin rights)"}.`
  ];
  if (opts.workspaceId !== undefined) {
    lines.push(`Active workspace context: ${opts.workspaceId}.`);
  }
  return lines.join("\n");
}
