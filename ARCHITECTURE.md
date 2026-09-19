# Architecture

## Overview

**slack-gatekeeper** is the entry point for all Slack traffic in an agent network. A
Slack event arrives at a stateless Worker, which verifies it, classifies it, and starts
a durable Workflow. The Workflow resolves which agents the event woke, dispatches an A2A
task to each, and posts their replies back to Slack. Agents never talk to Slack
themselves, and Slack never reaches an agent directly — that crossing is what gives the
gatekeeper its name.

Everything an agent turn does happens asynchronously inside a Workflow. The `fetch`
handler only verifies, classifies, and acks, because Slack's ack budget is 3 seconds and
a model call is not.

---

## Request entry points

`src/server.ts` is the Worker entry module. It exports the Workflow and Durable Object
classes Cloudflare resolves `class_name` against, and routes five paths:

| Method + path                          | Handler                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /.well-known/jwks.json`           | The gatekeeper's Ed25519 **public** JWKS, for remote agents verifying its tokens                   |
| `POST /slack/events`                   | Slack Events ingest — verify signature, classify, start a Workflow, ack                            |
| `POST /slack/interactivity`            | Slack Interactivity — button clicks, selects, and modal submissions from human-in-the-loop prompts |
| `POST /a2a/notifications`              | A remote agent's push callback, delivering its terminal A2A Task                                   |
| `GET /icons/{wsId}/{name}/{key}.{ext}` | Agent avatars, forwarded to the owning `admin:{wsId}` Durable Object                               |

The JWKS path and the notifications path are both imported from
`@dynamicagents/g2a-protocol`, so the agent side and this side spell them identically.

A `scheduled` handler runs on the nightly cron (`0 0 * * *`), starting the reconcile and
maintenance Workflows.

---

## Components

### In-repo agents (Durable Objects)

Two agent classes ship in this repo, each a Durable Object extending the Agents SDK
`Agent` (`src/agents/base.ts`). Each DO **is its own A2A server**: it answers card
discovery and JSON-RPC through the SDK's `DefaultRequestHandler`, and the gatekeeper
reaches it in-process via `stub.fetch` rather than over the network, so neither needs a
public HTTP route.

| Class             | Instance key               | Scope                                                                                                                   |
| ----------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AdminAgent`      | `admin:{wsId}`             | One per workspace. Registry and workspace CRUD through admin tools; owns the workspace's admin avatar and display name. |
| `OnboardingAgent` | `onboarding:{slackUserId}` | One per user. Read-only DM concierge — it routes people with words rather than acting for them.                         |

A DO gives each instance durable conversation history (`sessions`), a writable memory
block (`this.sql`), and a durable A2A task store — a turn parked on a human-in-the-loop
prompt has to survive eviction, because the human may answer days later.

### Remote (custom) agents

Any other registered agent runs outside this codebase and is reached over HTTP at its
registered `a2aEndpoint`. Registration verifies the agent's **signed AgentCard** and pins
its signing identity (`src/a2a/card-verify.ts`), and the endpoint is checked against an
org-wide domain allowlist plus SSRF policy (`src/a2a/endpoint.ts`). Dispatch mints a
short-lived EdDSA JWT naming the calling agent instance, which the remote verifies against
the public JWKS above.

Because a remote's generation can be long, it does not reply on the dispatch response: it
POSTs its terminal Task to `/a2a/notifications`, authenticated by its pinned card key plus
a per-task token.

---

## Workflows

Six Workflows are bound in `wrangler.jsonc`; all live in `src/workflows/`.

| Workflow              | Started by                               | Does                                                                                   |
| --------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `MessageWorkflow`     | a classified Slack message               | Resolves targets, records correlation rows, dispatches one A2A task per agent          |
| `LifecycleWorkflow`   | membership / team-join events            | Keeps the D1 registry in step with Slack membership                                    |
| `ReactionWorkflow`    | a trigger message's agents starting work | Owns the 🛑 reaction's removal and the processing deadline; cancels tasks that overrun |
| `CancelWorkflow`      | a 🛑 stop reaction                       | Cancels every non-terminal task that trigger message woke, then confirms               |
| `ReconcileWorkflow`   | nightly cron                             | Convergence backstop — repairs registry drift against Slack reality                    |
| `MaintenanceWorkflow` | nightly cron                             | Expires human-in-the-loop prompts past their TTL and sweeps resolved rows              |

---

## Message routing

Routing is resolved in `src/router/` against the D1 registry, not hardcoded by channel
type. The gatekeeper does not decide who replies — it fans the turn out to every agent the
event woke, and each agent classifies internally whether to respond.

Each agent carries its own `notify_on` setting, and `agent_channels` says which channels
it is allowed on:

- An agent on the channel whose `notify_on` is `channel_messages` → always woken.
- An agent on the channel whose `notify_on` is `mention` → woken only when named, by
  machine or display name (`src/router/parse.ts`; a name can be escaped with a backslash,
  backticks, or double quotes to write it without waking it).
- A workspace's **admin channel** → that workspace's `admin` built-in.
- A **DM** (Slack channel id starting with `D`) → the `onboarding` built-in; a DM is an
  implicit mention.

When nothing applies, the resolver returns an empty list and the gatekeeper stays silent.

---

## Data storage

Registry state lives in **D1** (`da-registry`, bound as `DB`), schema in `src/db/schema.ts`
and migrations in `migrations/` (drizzle-generated; `npm run db:generate`). Nine tables:

| Table               | Purpose                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `workspaces`        | Workspaces, each with an admin channel. Workspace `0` is the org scope.                       |
| `slack_users`       | Slack user profiles and permission flags                                                      |
| `slack_channels`    | Channel ids and names seen by the gatekeeper                                                  |
| `workspace_admins`  | Which users administer which workspace                                                        |
| `agents`            | The agent registry — kind (`local`/`remote`), tenant, endpoint, card signing pin, `notify_on` |
| `agent_channels`    | Which agents are allowed on which channels                                                    |
| `agent_tasks`       | Correlation rows tying an A2A task back to its Slack message                                  |
| `hitl_requests`     | Open human-in-the-loop prompts and their TTL                                                  |
| `workspace_configs` | Per-workspace key/value config (see `SystemConfigKeys` / `OperatorConfigKeys`)                |

Per-agent conversation history and memory are **not** in D1 — they live in each agent
DO's own SQLite storage. Archived history is embedded into **Vectorize** (`agent-recall`)
for recall across compaction boundaries.

---

## Deployment

```
Slack workspace
     │  POST /slack/events   (signature-verified, acked in <3s)
     ▼
Cloudflare Worker  (src/server.ts — stateless fetch handler)
     │  starts
     ▼
Workflow  (durable, retries per step)
     │  dispatchToAgent
     ├──────────────▶ AdminAgent / OnboardingAgent DO   (in-process stub.fetch)
     └──────────────▶ remote agent over HTTPS           (signed JWT; replies to /a2a/notifications)
     │
     ▼
Slack Web API  (reply posted back)
```

Deploy with `npx wrangler deploy`. Local development is `npx wrangler dev`; `npm run check`
runs types, format, lint and typecheck, and `npm test` runs the vitest suite against
workerd. `npm run cf` is a credential-redacting Cloudflare API proxy for inspecting the
deployed Worker — see `AGENTS.md`.
