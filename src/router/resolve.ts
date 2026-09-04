import type { AgentRow } from "@/db/models/agents";
import { getAgent, getAgentsForChannel } from "@/db/models/agents";
import { getWorkspaceByAdminChannel } from "@/db/models/workspaces";
import { getSlackChannelName } from "@/db/models/channels";
import { findAllAgentNameMentions } from "./parse";

/** A resolved agent target plus the cleaned prompt and workspace scope. */
export interface ResolvedTarget {
  kind: "agent";
  agent: AgentRow;
  /** Workspace scope for the agent. */
  workspaceId: number | null;
  /** Original user text. */
  text: string;
  /** Display name of the channel, resolved once for the whole fan-out. */
  channelName: string | null;
}

export interface ResolveInput {
  channelId: string;
  text: string;
}

/** Slack DM channel ids start with `D` (`C` = channel, `G` = group). */
export function isDmChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

/**
 * Resolve which agents should receive a Slack message. The Gatekeeper no longer
 * decides who replies — it fans the turn out to every agent woken by the event
 * and each agent classifies internally whether to respond.
 *
 * Selection:
 *   - `channel_messages` agents on the channel → always.
 *   - `mention` agents on the channel → only when named (machine or display name).
 *   - Admin channels → `admin` built-in (always; it's a channel_messages agent).
 *   - DMs            → `onboarding` built-in (always; a DM is an implicit mention).
 * Returns an empty list when nothing applies — the caller stays silent.
 */
export async function resolveTargets(
  input: ResolveInput
): Promise<ResolvedTarget[]> {
  const text = input.text;
  const channelEntries = await getAgentsForChannel(input.channelId);
  const ws = await getWorkspaceByAdminChannel(input.channelId);
  const isDm = isDmChannel(input.channelId);
  const channelName = await getSlackChannelName(input.channelId);

  const byName = new Map<string, ResolvedTarget>();
  const add = (agent: AgentRow, workspaceId: number | null) => {
    if (!byName.has(agent.name))
      byName.set(agent.name, {
        kind: "agent",
        agent,
        workspaceId,
        text,
        channelName
      });
  };

  // Channel agents: proactive always; mention-only when named (machine or display).
  const mentionNames = channelEntries.flatMap((e) => {
    const names = [e.agent.name];
    if (e.agent.displayName) names.push(e.agent.displayName);
    return names;
  });
  const mentioned = new Set(
    findAllAgentNameMentions(text, mentionNames).map((n) => n.toLowerCase())
  );
  for (const entry of channelEntries) {
    if (entry.agent.notifyOn === "channel_messages") {
      add(entry.agent, entry.workspaceId);
      continue;
    }

    if (
      mentioned.has(entry.agent.name) ||
      (entry.agent.displayName != null &&
        mentioned.has(entry.agent.displayName.toLowerCase()))
    ) {
      add(entry.agent, entry.workspaceId);
    }
  }

  // Admin channel → admin built-in (proactive co-worker). Its workspace-specific
  // avatar and display name are NOT layered on here: the admin is a single shared
  // registry row and how it renders is resolved at delivery time from the
  // workspace it posts into (see `agentRenderIdentity`). Overriding the row here
  // too would be a second source of truth for the same thing.
  if (ws) {
    const admin = await getAgent("admin");
    if (admin?.enabled) add(admin, ws.id);
  }
  // DM → onboarding built-in (DM is an implicit mention).
  if (isDm) {
    const onboarding = await getAgent("onboarding");
    if (onboarding?.enabled) add(onboarding, null);
  }

  return [...byName.values()];
}
