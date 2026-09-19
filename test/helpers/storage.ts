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
 * is 21 migrations and costs roughly a third of a second per test, which a spec
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
 */
export function useStorageReset(): void {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, migrations);
  });
}
