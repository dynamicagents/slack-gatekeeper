import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";

// TEST_MIGRATIONS is injected by vitest.config.ts (readD1Migrations). It's a
// test-only binding, so cast rather than widen the generated production Env.
const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;

/**
 * Spec files that touch neither D1 nor Durable Object storage, and so can skip
 * the reset + migration replay below.
 *
 * An **opt-out** list, so a new spec gets the full reset by default and only
 * ever loses it deliberately. Every entry has been run on its own with the reset
 * skipped and still passes; if one starts touching storage, its own assertions
 * are what fail, not a neighbour's.
 */
const NO_STORAGE_SPECS = new Set([
  "test/a2a/card-verify.spec.ts",
  "test/a2a/client.spec.ts",
  "test/a2a/endpoint.spec.ts",
  "test/a2a/hitl-contract.spec.ts",
  "test/a2a/hitl.spec.ts",
  "test/a2a/jwks-cache.spec.ts",
  "test/a2a/serve.spec.ts",
  "test/agents/admin/avatar.spec.ts",
  "test/agents/model-fallback-middleware.spec.ts",
  "test/agents/model.spec.ts",
  "test/agents/shared/messages.spec.ts",
  "test/agents/shared/open-call.spec.ts",
  "test/agents/shared/recall.spec.ts",
  "test/agents/shared/session.spec.ts",
  "test/agents/shared/turn-log.spec.ts",
  "test/auth/agent-inbound.spec.ts",
  "test/auth/agent-outbound.spec.ts",
  "test/auth/wire-contract.spec.ts",
  "test/router/parse.spec.ts",
  "test/util/text.spec.ts",
  "test/wrappers/slack.spec.ts"
]);

/**
 * Spec files whose module graph can reach `@/a2a/card-verify`, and so can leave
 * entries in its JWKS cache.
 *
 * Module state is part of a test's clean slate: a file shares one isolate across
 * its cases, so the cache would otherwise carry one test's stubbed keys into the
 * next — the same `jku` served by a fresh `vi.stubGlobal("fetch")` and a newly
 * generated key pair each time. Clearing it is what makes a cold isolate, which
 * is what the production behaviour every case describes assumes.
 *
 * The import is **dynamic and listed** rather than at module scope because a
 * setup file runs for every spec, and a static import made all 57 pay for
 * `card-verify`'s graph — `jose` and the A2A SDK — including the ones that never
 * mention a key. Every file here loads that graph anyway, so the import is free
 * where it happens and absent where it is not. A file that cannot reach the
 * cache has no cache entries to carry, so skipping the call is not a weaker
 * reset; adding a spec that does reach it means adding it here.
 */
const JWKS_SPECS = new Set([
  "test/a2a/card-verify.spec.ts",
  "test/a2a/dispatch.spec.ts",
  "test/a2a/jwks-cache.spec.ts",
  "test/a2a/notifications.spec.ts",
  "test/agents/admin/executor.spec.ts",
  "test/agents/admin/tools.spec.ts",
  "test/auth/agent-inbound.spec.ts",
  "test/auth/agent-outbound.spec.ts",
  "test/auth/wire-contract.spec.ts",
  "test/slack-interactivity-handler.spec.ts",
  "test/slack-webhook-handler.spec.ts",
  "test/workflows/message.spec.ts",
  "test/worker.spec.ts"
]);

/** `testPath` is absolute; the lists hold repo-relative tails. */
function listed(specs: Set<string>, testPath: string | undefined): boolean {
  if (!testPath) return false;
  const path = testPath.replaceAll("\\", "/");
  return [...specs].some((spec) => path.endsWith(spec));
}

// Reset all storage and re-apply the schema before every test so each test
// starts from a clean slate. An unrecognized path gets the full reset.
beforeEach(async () => {
  const testPath = expect.getState().testPath;
  if (listed(JWKS_SPECS, testPath)) {
    const { clearJwksCache } = await import("@/a2a/card-verify");
    clearJwksCache();
  }
  if (listed(NO_STORAGE_SPECS, testPath)) return;
  await reset();
  await applyD1Migrations(env.DB, migrations);
});
