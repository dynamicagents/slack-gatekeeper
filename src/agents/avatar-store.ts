import { DurableObject } from "cloudflare:workers";

/** An avatar stored in this object's key-value storage. */
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
/** Avatars are immutable per content-hash key; cache for a year (new image = new URL). */
const ICON_CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, immutable";
/** Forwarded path `/icons/{wsId}/{name}/{key}.{ext}` — capture name + key. */
const ICON_PATH = /^\/icons\/\d+\/([a-z0-9_-]+)\/([^/]+?)(?:\.\w+)?$/;

/**
 * The avatars the admin agent generates, one instance per workspace
 * (`admin:{wsId}`), served back over `/icons/…` so Slack can fetch an agent's
 * `iconUrl`.
 *
 * This is the class the admin agent used to be, renamed by a wrangler migration
 * so its storage — and with it every avatar URL already recorded in D1 — came
 * along. Keep the instance names and the key layout as they are: changing
 * either orphans those URLs.
 */
export class AvatarStore extends DurableObject<Env> {
  /**
   * Persist an avatar under `name`, keyed by its content hash, prune that
   * agent's index to the last {@link ICON_KEEP}, and return the key. A
   * regenerated image gets a new key and so a new URL.
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

  /** Serve `/icons/{wsId}/{name}/{key}`; anything else is not here. */
  async fetch(request: Request): Promise<Response> {
    const match = new URL(request.url).pathname.match(ICON_PATH);
    if (request.method !== "GET" || !match) {
      return new Response("not found", { status: 404 });
    }
    const icon = await this.getIcon(match[1], match[2]);
    if (!icon) return new Response("not found", { status: 404 });
    return new Response(icon.data, {
      headers: {
        "content-type": icon.contentType,
        "cache-control": ICON_CACHE_CONTROL
      }
    });
  }
}

/** The avatar store of one workspace's admin. */
export function avatarStoreFor(env: Env, wsId: number) {
  return env.AvatarStore.get(env.AvatarStore.idFromName(`admin:${wsId}`));
}
