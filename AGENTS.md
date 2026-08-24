# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command               | Purpose                                   |
| --------------------- | ----------------------------------------- |
| `npx wrangler dev`    | Local development                         |
| `npx wrangler deploy` | Deploy to Cloudflare                      |
| `npm run types`       | Generate TypeScript types (runtime + Env) |
| `npm run check`       | Format, lint, typecheck + verify types    |

## Debugging production (`npm run cf`)

`scripts/cf.mjs` is a thin Cloudflare API proxy for inspecting the deployed
Worker. It reads credentials from `.cf.env` (gitignored; copy `.cf.env.example`
and fill in an account-scoped API token + account id) so the token never lands
in shell history or an agent's context — the script holds it in memory and
redacts it from all output.

| Command                                                   | Purpose                                          |
| --------------------------------------------------------- | ------------------------------------------------ |
| `npm run cf -- verify`                                    | Check the API token                              |
| `npm run cf -- logs --worker looping-gateway --since 1h`  | Historical Worker logs (Observability), digest   |
| `npm run cf -- logs --level error --grep MessageWorkflow` | Filter logs by level / message substring         |
| `npm run cf -- wf`                                        | List Workflow definitions                        |
| `npm run cf -- wf message-workflow [instanceId]`          | Workflow instances / one instance's steps        |
| `npm run cf -- ai [logId]`                                | AI Gateway call digest / one call's prompt+reply |
| `npm run cf -- [METHOD] <path> [-q k=v] [-d @file]`       | Raw passthrough (account-relative unless `/…`)   |

Run `npm run cf -- help` for the full flag list.

## TypeScript Types

Follow Cloudflare's generated-types flow (https://developers.cloudflare.com/workers/languages/typescript/#generate-types):

- `wrangler types` generates `worker-configuration.d.ts` — **both** runtime globals (`D1Database`, `Ai`, `Workflow`, …) and the `Env` interface — matched to our `compatibility_date`/`compatibility_flags`. This file is committed to git.
- Do **not** add or reference `@cloudflare/workers-types`. Runtime types come from `wrangler types`, not the npm package (which is only for shared libraries). `tsconfig` points at `worker-configuration.d.ts`, not the package.
- After changing bindings or compat settings in `wrangler.jsonc`, run `npm run types` and commit the regenerated `worker-configuration.d.ts`.
- `npm run check` (pre-commit + CI) runs `wrangler types --check` first and fails if the committed types are stale — so never hand-edit the generated file.

## Updating Packages

Bump `package.json` to the latest versions, then `npm install` to refresh the lockfile.

- **TypeScript** stays pinned — a compiler bump is its own PR, not a dependency sweep.
- **`slackify-markdown`** stays a GitHub reference (`github:Looping-AI/slackify-markdown#…`); it is not npm-versioned, so bump the tag deliberately, never as part of a sweep.

For every **non-patch** bump, read the package's changelog before running anything:

- **Breaking changes and deprecations** that reach our code — a deprecated call we still make gets fixed in the same PR.
- **New best-practice patterns** — a new entrypoint, helper, or exported type that replaces something we hand-roll.
- **Refactor opportunities.** Small and clearly beneficial → apply it here. Larger than the bump → note it in the PR description and leave the code alone.

Skip changelog reading for **wrangler** and **eslint** — both are high-frequency, low-signal for us; their breakage surfaces in `npm run check` instead.

Then verify, in order:

| Command         | Why                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run types` | Regenerates `worker-configuration.d.ts` — a wrangler bump ships a new workerd, so runtime types drift even when nothing else changed. Commit the result. |
| `npm run check` | `wrangler types --check` + prettier + eslint + both `tsc` projects                                                                                       |
| `npm test`      | Full vitest run against the Workers runtime                                                                                                              |

`npm run types` must come first: `npm run check` fails on stale committed types, and running it before regenerating just reports drift the bump itself caused.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Code Conventions

### `src/db/models/`

Order exported functions in CRUD sequence: **Create → Read → Update → Delete**.
Upserts count as Create. Helpers that delegate to a core CRUD function follow their
own thematic grouping but the core operations must appear in CRUD order first.

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
