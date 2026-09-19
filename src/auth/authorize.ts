/**
 * A user's resolved permissions, built purely from the D1 registry
 * (slack_users flags + workspace_admins membership). Passed to agents over A2A;
 * `authorize()` checks requirements against it.
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
 * A permission requirement. `authorize()` uses OR-semantics across an array:
 * the user passes if they satisfy ANY requirement.
 */
export type PermissionRequirement =
  | { type: "IsPrimaryOwner" }
  | { type: "IsOrgAdmin" }
  | { type: "IsWorkspaceAdmin"; workspaceId: number };

function satisfies(ctx: UserAuthContext, req: PermissionRequirement): boolean {
  switch (req.type) {
    case "IsPrimaryOwner":
      return ctx.isPrimaryOwner;
    case "IsOrgAdmin":
      return ctx.isOrgAdmin || ctx.isPrimaryOwner;
    case "IsWorkspaceAdmin":
      return (
        ctx.isPrimaryOwner ||
        ctx.isOrgAdmin ||
        ctx.adminWorkspaces.includes(req.workspaceId)
      );
  }
}

/**
 * OR-semantics: the user is authorized if they satisfy ANY requirement. An
 * empty requirement list denies (no requirement is satisfied). Pure + synchronous.
 */
export function authorize(
  ctx: UserAuthContext,
  requirement: PermissionRequirement | PermissionRequirement[]
): boolean {
  const requirements = Array.isArray(requirement) ? requirement : [requirement];
  return requirements.some((req) => satisfies(ctx, req));
}
