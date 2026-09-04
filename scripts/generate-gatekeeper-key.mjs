/**
 * Generate an Ed25519 keypair for GATEKEEPER_JWT_PRIVATE_KEY.
 *
 * Usage:
 *   npm run keygen          # kid defaults to "gw-1"
 *   npm run keygen gw-2     # pass a different kid when rotating
 *
 * Output only — no files are written. Copy the printed line into `.env` (or
 * whichever wrangler environment you are targeting).
 */
import { generateKeyPair, exportJWK } from "jose";

const kid = process.argv[2] ?? "gw-1";

const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true
});

const priv = await exportJWK(privateKey);
const pub = await exportJWK(publicKey);

priv.kid = pub.kid = kid;
priv.alg = pub.alg = "EdDSA";
pub.use = "sig";

const privJson = JSON.stringify(priv);
const privLine = `GATEKEEPER_JWT_PRIVATE_KEY=${privJson}`;
const hr = "─".repeat(76);

console.log(`\nGenerated Ed25519 keypair  (kid: ${kid})\n`);

console.log(`── Local dev ${hr.slice(12)}`);
console.log("Add to .env:\n");
console.log(`${privLine}\n`);

console.log(`── Deployed env ${hr.slice(15)}`);
console.log("Push the whole file:\n");
console.log(`  npx wrangler deploy --secrets-file .env`);
console.log(
  `  npx wrangler deploy --secrets-file .env.staging --env staging\n`
);
console.log("Or set just this secret, pasting the JSON below when prompted:\n");
console.log(
  `  npx wrangler secret put GATEKEEPER_JWT_PRIVATE_KEY              # default env`
);
console.log(
  `  npx wrangler secret put GATEKEEPER_JWT_PRIVATE_KEY --env staging\n`
);
console.log(`${privJson}\n`);
