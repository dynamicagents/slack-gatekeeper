import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { clearJwksCache } from "@/a2a/card-verify";

// TEST_MIGRATIONS is injected by vitest.config.ts (readD1Migrations). It's a
// test-only binding, so cast rather than widen the generated production Env.
const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;

// Reset all storage and re-apply the schema before every test so each test
// starts from a clean slate.
//
// Module state is part of that slate. A test file shares one isolate across its
// cases, so the JWKS cache would otherwise carry one test's stubbed keys into
// the next — the same `jku` served by a fresh `vi.stubGlobal("fetch")` and a
// newly generated key pair each time. Clearing it here is what makes a cold
// isolate, which is what the production behaviour every case describes assumes.
beforeEach(async () => {
  await reset();
  clearJwksCache();
  await applyD1Migrations(env.DB, migrations);
});
