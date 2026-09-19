import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "path";

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
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations
        }
      }
    })
  ]
});
