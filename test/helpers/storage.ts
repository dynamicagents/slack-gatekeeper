import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

// TEST_MIGRATIONS is injected by vitest.config.ts (readD1Migrations). It's a
// test-only binding, so cast rather than widen the generated production Env.
const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;

/**
 * Wipe D1 and Durable Object storage, then replay the schema, before every test
 * in the calling file.
 *
 * Call it once at the top of a spec, directly under the imports:
 *
 * ```ts
 * useStorageReset();
 * ```
 *
 * It is a **per-file declaration** rather than a global hook because the replay
 * is 22 migrations and costs roughly a third of a second per test, which a spec
 * that never reads or writes storage has no reason to pay. Declaring it in the
 * file is also what makes the difference legible: the reader sees the hook where
 * the tests that need it are, instead of inferring it from a list somewhere else.
 *
 * Put the call **above every other hook in the file**. Hooks run in registration
 * order within a suite, so a `beforeEach` registered first is the one that seeds
 * onto a clean slate rather than being wiped by it.
 *
 * When in doubt, call it. A spec that resets storage it never touches is slow;
 * one that touches storage without resetting is flaky, and it fails whichever
 * spec happens to run next.
 *
 * `scripts/check-storage-reset.mjs` (part of `npm run check`) fails the build on
 * a spec that reaches storage without this call.
 *
 * `through` stops the replay after that migration tag, for the one kind of spec
 * that wants an older schema: one that drives a migration over rows written
 * before it. Seed onto what the reset leaves, then call
 * {@link applyPendingMigrations} to run the rest.
 */
export function useStorageReset(opts: { through?: string } = {}): void {
  const upTo =
    opts.through === undefined ? migrations : migrationsThrough(opts.through);
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, upTo);
  });
}

/** The migrations up to and including `tag`, which must name one of them. */
function migrationsThrough(tag: string): D1Migration[] {
  const end = migrations.findIndex((m) => m.name === `${tag}.sql`);
  if (end < 0) throw new Error(`no migration named ${tag}`);
  return migrations.slice(0, end + 1);
}

/**
 * Apply every migration not yet applied — the ones a `through` reset left out.
 * `applyD1Migrations` skips what it has already recorded, so this runs exactly
 * the remainder, in order, each as its own batch, the way D1 does.
 */
export async function applyPendingMigrations(): Promise<void> {
  await applyD1Migrations(env.DB, migrations);
}
