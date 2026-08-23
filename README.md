# looping-gateway

> A Cloudflare Workers template for building Slack-anchored multi-agent systems — receive Slack messages, route them to the right AI agent, and loop responses back.

A production-ready starting point for teams who want to expose AI agents through Slack without managing infrastructure. Built on [Cloudflare Workers](https://developers.cloudflare.com/workers/) and the [Agents SDK](https://developers.cloudflare.com/agents/), with persistent state via Durable Objects and AI powered by [Workers AI](https://developers.cloudflare.com/workers-ai/) (no external API key required).

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full breakdown of the agent design, routing rules, and the planned A2A communication layer.

---

## Getting started

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- Node.js >= 24
- A Slack workspace where you can install apps

### 1. Use this template

Click **Use this template** at the top of this repo on GitHub, then clone your new repo locally.

### 2. Install dependencies

```bash
npm install
```

### 3. Authenticate with Cloudflare

```bash
npx wrangler login
```

### 4. Create your Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.

Then configure:

- **Event Subscriptions** → Enable (you will set the URL after deploy)
- **Subscribe to bot events:** `app_mention`, `message.im`, `reaction_added`
- **OAuth & Permissions → Bot Token Scopes:** At least `chat:write`, `app_mentions:read`, `im:history`, `channels:history`, `reactions:read`, `reactions:write`
- **Install App** → install to your workspace → copy the **Bot User OAuth Token**
- **Basic Information** → copy the **Signing Secret**

### 5. Set secrets

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
```

For local development with `wrangler dev`, copy the example env file and fill in your Slack values:

```bash
cp .dev.vars.example .dev.vars
```

`wrangler dev` loads variables from `.dev.vars` locally. Keep this file uncommitted.

### 6. Generate gateway identity key

```bash
npm run keygen
```

This prints a private JWK and ready-to-paste `wrangler secret put` commands.
Set the printed key as `GATEWAY_JWT_PRIVATE_KEY` in `.dev.vars` for local dev,
or via `wrangler secret put` for deployed environments.

### 7. Deploy

```bash
npx wrangler deploy
```

Your worker URL will be: `https://looping-gateway.<your-subdomain>.workers.dev`

### 8. Finish Slack configuration

In your Slack App settings, go to **Event Subscriptions → Request URL** and paste:

```
https://looping-gateway.<your-subdomain>.workers.dev/slack/events
```

Save the changes. Slack will verify the URL automatically.

Your gateway is live. Mention the bot in a channel (`@your-bot`) or send it a DM.

---

## Run locally / Development

`npx wrangler dev` starts the local server on port 8787, but Slack cannot send events to `localhost`. You need a public tunnel.

Before starting, make sure your local env file exists and secrets of your Dev Slack App are added:

```bash
cp .dev.vars.example .dev.vars
```

### Option A — Built-in tunnel (quickest)

`wrangler dev` has a built-in tunnel: once the dev server is running, press **`t`** in the terminal. It starts a temporary `trycloudflare.com` URL and prints it.

```
[b] open a browser  [d] open devtools  [t] start tunnel  [c] clear console  [x] to exit

⬣ Sharing via Cloudflare Tunnel: https://video-spots-novels-supplemental.trycloudflare.com/
```

**Limitation:** the URL is random and changes every time you start a new tunnel session. Each time it changes you'll need to go back to your Slack app settings and update the **Event Subscriptions → Request URL**. Fine for occasional testing; annoying for active development.

### Option B — Named tunnel with a fixed URL (recommended for longer dev)

You first need a domain managed by Cloudflare. Once you have one, create a named tunnel and give it a stable subdomain (e.g. `some-random-string.yourdomain.com`). Set the Slack URL once and never touch it again.

**One-time setup:**

```bash
npx wrangler tunnel create looping-gateway-dev
npx wrangler tunnel route dns looping-gateway-dev some-random-string.yourdomain.com
```

**Daily dev** (single command — tunnel starts alongside the dev server):

```bash
npx wrangler dev --tunnel --tunnel-name looping-gateway-dev
```

> **Prerequisite:** your domain must be added to your Cloudflare account (free).

Use `https://some-random-string.yourdomain.com/slack/events` as your Slack Request URL. It stays valid across restarts.

---

## Project structure

```
src/
  server.ts       # Gateway: Slack webhook handling, AI handler, scheduling

wrangler.jsonc    # Worker name, Durable Object bindings, AI binding
package.json      # Dependencies and scripts
ARCHITECTURE.md   # Agent design, routing, and future A2A layer
```

## What's included

- **Slack webhook handler** — URL verification + event routing
- **AI responses** — Powered by Workers AI (no external API key required)
- **Task scheduling** — One-time, delayed, and cron-based reminders posted back to Slack
- **Durable Object persistence** — SQLite-backed state via the Agents SDK
- **CI** — GitHub Actions sanity check (format + lint + TypeScript) on every push

---

## Building an agent for this gateway

Use **[Looping-AI/looping-starter](https://github.com/Looping-AI/looping-starter)** — a working, deployable agent on Cloudflare Workers.

It ships the whole zero-trust A2A edge (gateway-JWT verification, AgentCard signing, JSON-RPC routing, the push-notification callback) via [`@loopingai/core`](https://github.com/Looping-AI/looping-core), so what you write is your agent's identity, its capabilities, and its config. `npm run agent:new <tenant>` scaffolds one.

Register it with this gateway using its **endpoint** and its **tenant id** — several agents share one endpoint and are told apart by the tenant claim in the token this gateway mints. See [`test/auth/wire-contract.spec.ts`](test/auth/wire-contract.spec.ts) for the exact contract the two sides share.

---

## Workspace invariant — one Worker, one Slack workspace

A deployed instance of this gateway is **permanently bound to a single Slack workspace** (team ID). On the first `reconcile()` run, the bot's workspace is pinned as a write-once anchor in D1. Every subsequent reconcile, and every inbound Slack event, asserts this anchor. A mismatch causes an immediate abort — no registry writes occur.

This is intentional. Every channel ID, user ID, primary-owner flag, and auth assumption stored in D1 and Vectorize is workspace-specific. Swapping the bot token to a different workspace while reusing the same Worker state would silently corrupt all of that data.

### Migrating to a new workspace

There is no in-place migration path. The only safe approach is:

1. **Export your current config** — ask the admin agent to list all workspace and agent configurations (channels, roles, agent IDs, etc.).
2. **Deploy a brand-new Worker** for the new workspace (`npx wrangler deploy` on a fresh clone, with new secrets).
3. **Re-create your configuration** on the new Worker — paste the exported config into the admin agent on the new workspace and let it recreate the entries.
4. **Delete the old Worker** if no longer needed. Note that some bindings are independent global primitives and must be deleted separately: **D1 databases**, **Vectorize indexes**, and **KV namespaces**. Secrets and Durable Objects are deleted automatically with the Worker.

---

## Contributing

PRs are welcome. To contribute:

1. Fork this repo (or use it as a template: **Settings → Template repository**)
2. Create a branch: `git checkout -b my-feature`
3. Make your changes and run `npm run check` to verify
4. Open a pull request

---

## Feedback

Found a bug, have a question, or want to suggest a feature? [Open an issue](https://github.com/Looping-AI/looping-gateway/issues) — all feedback is welcome.

---

## License

[GPL-3.0](LICENSE)

Hi Tiago, back in action and ready to build!
Glad to be back — let's keep shipping!
Onwards — let's build something great together!
