import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "path";
// The realm-neutral slice: this file runs in Node, and the `/testing` barrel
// pulls in `cloudflare:test`, which fails at load here.
import { TEST_AGENT_PRIVATE_JWK } from "@dynamicagents/core/testing/fixtures";

// Test defaults for required secrets. Real env vars (CI/shell) take precedence via ??=.
process.env.SLACK_BOT_TOKEN ??= "xoxb-test-token";
process.env.SLACK_SIGNING_SECRET ??= "test-signing-secret";
process.env.GATEKEEPER_JWT_PRIVATE_KEY ??= JSON.stringify({
  crv: "Ed25519",
  d: "1xgbYpMkLQ7HSsmNt-fKKJq2UFstxDxuzpZ_30tl7bs",
  x: "HozhHMwqLW4u9YAyv3UBLj3tcQrLi9lUA335i3xdFE8",
  kty: "OKP",
  kid: "gw-test-1",
  alg: "EdDSA",
  use: "sig"
});

// The built-in tenants' signing key (core's `A2A_SIGNING_KEY`).
process.env.A2A_SIGNING_KEY ??= JSON.stringify(TEST_AGENT_PRIVATE_JWK);

// Every origin a spec pins as `public_url`. Core's edge accepts a gatekeeper
// token only from these, and `wrangler.jsonc` names the production one.
const TEST_GATEKEEPER_ORIGINS = JSON.stringify([
  "https://example.com",
  "https://gw.example.com",
  "https://gatekeeper.test"
]);

// Read the drizzle-generated migrations on the Node side and hand them to the
// pool as a binding; test/helpers/storage.ts applies them to the test D1, in the
// specs that declare `useStorageReset()`.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src")
    }
  },
  test: {
    setupFiles: ["./test/setup.ts"]
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The gatekeeper's own Worker plus its built-in step agents on a
      // scripted model — Workers AI has no local mode. See test/worker.ts.
      main: "./test/worker.ts",
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          GATEKEEPER_ORIGINS: TEST_GATEKEEPER_ORIGINS
        },
        // The step-agent bindings, pointed at the scripted classes. The real
        // hosts and workflows reach them by these binding names, so nothing
        // else changes.
        durableObjects: {
          AdminStepAgent: { className: "TestAdminStepAgent", useSQLite: true },
          OnboardingStepAgent: {
            className: "TestOnboardingStepAgent",
            useSQLite: true
          }
        }
      }
    })
  ]
});
