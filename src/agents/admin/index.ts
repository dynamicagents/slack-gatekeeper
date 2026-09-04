import type { AgentCard } from "@a2a-js/sdk";
import type { AgentExecutor } from "@a2a-js/sdk/server";
import { buildAgentCard } from "@/a2a/card";
import { HITL_REQUEST_TTL_SECONDS } from "@/config";
import { A2AAgent } from "../base";
import { AdminAgentExecutor } from "./executor";
import type { GatedAction } from "./approvals";

/** An avatar stored in this DO's key-value storage, served by `fetch`. */
interface StoredIcon {
  contentType: string;
  data: Uint8Array<ArrayBuffer>;
}

/** Keep the current + previous avatar so in-flight cached URLs don't 404. */
const ICON_KEEP = 2;

/**
 * Storage keys, namespaced by the owning agent's `name` (a stable, URL-safe
 * slug — the admin is just `"admin"`). Every agent gets its own byte blobs and
 * prune index, so an agent's avatars can never evict another's.
 */
function iconKey(name: string, hash: string): string {
  return `icon:${name}:${hash}`;
}
function iconIndexKey(name: string): string {
  return `icon:${name}:index`;
}
/** A destructive action parked behind a HITL approval, keyed by its `requestId`. */
interface PendingActionEntry {
  action: GatedAction;
  /** Epoch ms — used to prune entries whose prompt was cancelled and never resumed. */
  createdAt: number;
}
const PENDING_ACTION_PREFIX = "hitl:pending:";
function pendingActionKey(requestId: string): string {
  return `${PENDING_ACTION_PREFIX}${requestId}`;
}

/** Avatars are immutable per content-hash key; cache for a year (new image = new URL). */
const ICON_CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, immutable";
/** Forwarded path `/icons/{wsId}/{name}/{key}.{ext}` — capture name + key. */
const ICON_PATH = /^\/icons\/\d+\/([a-z0-9_-]+)\/([^/]+?)(?:\.\w+)?$/;

/**
 * Admin agent (registry + workspace management). One Durable Object instance per
 * workspace (`admin:{wsId}`), each with isolated Sessions + memory. Runs a
 * Workers-AI tool loop over registry/workspace CRUD tools gated by the caller's
 * auth context (carried on `message.metadata`).
 *
 * It also hosts avatars: the `self_set_avatar` (own avatar) and
 * `agents_regenerate_avatar` (custom-agent avatars) tools generate an image via Workers AI
 * and persist it here via {@link putIcon}, keyed per owner; `fetch` serves it back so
 * Slack (and any A2A consumer) can fetch the agent's `iconUrl` over HTTP.
 */
export class AdminAgent extends A2AAgent {
  protected card(): AgentCard {
    return buildAgentCard({
      name: "Admin Agent",
      description:
        "Dynamic Agents admin agent — manages the agent registry and workspaces.",
      pushNotifications: true
    });
  }

  protected builtinTenant(): "admin" {
    return "admin";
  }

  protected executor(): AgentExecutor {
    return new AdminAgentExecutor(this, {
      storeIcon: (img, name) => this.putIcon(img.data, img.contentType, name),
      storePendingAction: (requestId, action) =>
        this.putPendingAction(requestId, action),
      takePendingAction: (requestId) => this.takePendingAction(requestId)
    });
  }

  /**
   * Persist a destructive action behind its approval prompt, keyed by the HITL
   * `requestId`, so the resumed turn can carry it out once approved. Also prunes
   * entries older than the HITL TTL, so a 🛑-cancelled prompt (which never
   * resumes to consume its entry) can't accumulate in storage.
   */
  async putPendingAction(
    requestId: string,
    action: GatedAction
  ): Promise<void> {
    await this.ctx.storage.put<PendingActionEntry>(
      pendingActionKey(requestId),
      {
        action,
        createdAt: Date.now()
      }
    );
    await this.prunePendingActions();
  }

  /** Read-and-delete a pending action so it runs at most once. */
  async takePendingAction(requestId: string): Promise<GatedAction | null> {
    const key = pendingActionKey(requestId);
    const entry = await this.ctx.storage.get<PendingActionEntry>(key);
    if (!entry) return null;
    await this.ctx.storage.delete(key);
    return entry.action;
  }

  private async prunePendingActions(): Promise<void> {
    const cutoff = Date.now() - HITL_REQUEST_TTL_SECONDS * 1000;
    const entries = await this.ctx.storage.list<PendingActionEntry>({
      prefix: PENDING_ACTION_PREFIX
    });
    for (const [key, entry] of entries) {
      if (entry.createdAt < cutoff) await this.ctx.storage.delete(key);
    }
  }

  /**
   * Persist an avatar in DO storage under `name`, keyed by its content hash,
   * prune that agent's index to the last {@link ICON_KEEP}, and return the key.
   * The hash key makes the served URL effectively immutable (a regenerated image
   * gets a new key ⇒ new URL). `name` is `"admin"` for the admin's own avatar or
   * a custom agent's name — bytes, index, and pruning are all scoped to `name`,
   * so one agent's avatars can never evict another's.
   */
  async putIcon(
    data: Uint8Array<ArrayBuffer>,
    contentType: string,
    name: string
  ): Promise<{ key: string; contentType: string }> {
    const digest = await crypto.subtle.digest("SHA-256", data);
    const key = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    const icon: StoredIcon = { contentType, data };
    await this.ctx.storage.put(iconKey(name, key), icon);

    const indexKey = iconIndexKey(name);
    const index = (await this.ctx.storage.get<string[]>(indexKey)) ?? [];
    const next = [...index.filter((k) => k !== key), key];
    while (next.length > ICON_KEEP) {
      const stale = next.shift();
      if (stale) await this.ctx.storage.delete(iconKey(name, stale));
    }
    await this.ctx.storage.put(indexKey, next);

    return { key, contentType };
  }

  /** Read an agent's avatar by its content-hash key (null when unknown/pruned). */
  async getIcon(name: string, key: string): Promise<StoredIcon | null> {
    const icon = await this.ctx.storage.get<StoredIcon>(iconKey(name, key));
    return icon ?? null;
  }

  /**
   * Serve `/icons/{wsId}/{name}/{key}` from storage; everything else is the A2A
   * protocol (card discovery + JSON-RPC) handled by the base class.
   */
  async fetch(request: Request): Promise<Response> {
    const match = new URL(request.url).pathname.match(ICON_PATH);
    if (request.method === "GET" && match) {
      const icon = await this.getIcon(match[1], match[2]);
      if (!icon) return new Response("not found", { status: 404 });
      return new Response(icon.data, {
        headers: {
          "content-type": icon.contentType,
          "cache-control": ICON_CACHE_CONTROL
        }
      });
    }
    return super.fetch(request);
  }
}
