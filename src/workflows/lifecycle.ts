import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { LifecycleWorkflowParams } from "@/slack/types";
import { upsertSlackUser } from "@/db/models/users";
import { getWorkspaceByAdminChannel } from "@/db/models/workspaces";
import {
  addWorkspaceAdmin,
  removeWorkspaceAdmin
} from "@/db/models/workspace-admins";
import { getBotUserId } from "@/wrappers/slack";

// ---------------------------------------------------------------------------
// Pure per-event handlers — exported for unit testing (mirrors classifyEvent).
// Every write is idempotent: Workflow steps retry and Slack redelivers events.
// ---------------------------------------------------------------------------

/** team_join → register the new user (flags stay default; reconcile owns them). */
export async function handleTeamJoin(
  params: LifecycleWorkflowParams
): Promise<void> {
  if (!params.userId) return;
  await upsertSlackUser({
    slackUserId: params.userId,
    displayName: params.displayName ?? null
  });
}

/** Joining a workspace's admin channel ⇒ admin of that workspace. */
export async function handleMemberJoined(
  params: LifecycleWorkflowParams,
  botUserId: string | null
): Promise<void> {
  if (!params.channelId || !params.userId) return;
  if (botUserId && params.userId === botUserId) return; // bot's own join
  const ws = await getWorkspaceByAdminChannel(params.channelId);
  if (!ws) return; // not an admin channel — no-op (allowlist is Phase 4)
  await addWorkspaceAdmin(ws.id, params.userId, "membership");
}

/** Leaving a workspace's admin channel ⇒ losing that workspace's admin rights. */
export async function handleMemberLeft(
  params: LifecycleWorkflowParams,
  botUserId: string | null
): Promise<void> {
  if (!params.channelId || !params.userId) return;
  if (botUserId && params.userId === botUserId) return;
  const ws = await getWorkspaceByAdminChannel(params.channelId);
  if (!ws) return;
  await removeWorkspaceAdmin(ws.id, params.userId);
}

// ---------------------------------------------------------------------------
// Workflow — thin dispatcher of idempotent steps over the handlers above.
// ---------------------------------------------------------------------------

/**
 * Durable, retriable handler for non-agent lifecycle events. The gatekeeper
 * triggers one instance per Slack `event_id`. Writes the D1 registry
 * (users/workspaces/admins); reconcile (cron) is the convergence backstop.
 */
export class LifecycleWorkflow extends WorkflowEntrypoint<
  Env,
  LifecycleWorkflowParams
> {
  async run(event: WorkflowEvent<LifecycleWorkflowParams>, step: WorkflowStep) {
    const { type, subtype } = event.payload;

    // Wrap the whole run so a failing step surfaces with detail. Without this,
    // a step whose retries are exhausted bubbles up as Cloudflare's opaque
    // "workflow" exception log (just the workflow name, no cause). The Slack
    // calls inside the steps (getBotUserId) and the D1 writes throw on transient
    // errors that are otherwise invisible. We log the real cause, then rethrow
    // to preserve retry/backoff.
    try {
      switch (type) {
        case "team_join":
          await step.do("team-join", () => handleTeamJoin(event.payload));
          return;

        case "member_joined_channel":
          await step.do("member-joined", async () => {
            const botUserId = await getBotUserId();
            await handleMemberJoined(event.payload, botUserId);
          });
          return;

        case "member_left_channel":
          await step.do("member-left", async () => {
            const botUserId = await getBotUserId();
            await handleMemberLeft(event.payload, botUserId);
          });
          return;

        default:
          // message_changed / message_deleted edits — no registry impact yet.
          // TODO(phase-6): feed the channel-history raw buffer + Vectorize index.
          await step.do("noop-message-edit", async () => {
            console.log("LifecycleWorkflow: no-op lifecycle event", {
              instanceId: event.instanceId,
              type,
              subtype
            });
          });
          return;
      }
    } catch (err) {
      console.error("[lifecycle] workflow run failed", {
        instanceId: event.instanceId,
        type,
        subtype,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      throw err;
    }
  }
}
