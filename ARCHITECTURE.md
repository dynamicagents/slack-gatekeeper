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
classes Cloudflare resolves `class_name` against, and routes these paths:

| Method + path                                                      | Handler                                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `GET /.well-known/jwks.json`                                       | The gatekeeper's Ed25519 **public** JWKS, for remote agents verifying its tokens                   |
| `POST /slack/events`                                               | Slack Events ingest — verify signature, classify, start a Workflow, ack                            |
| `POST /slack/interactivity`                                        | Slack Interactivity — button clicks, selects, and modal submissions from human-in-the-loop prompts |
| `POST /a2a/notifications`                                          | Every agent's push callback — remote and built-in — delivering its A2A Task                        |
| `GET /icons/{wsId}/{name}/{key}.{ext}`                             | Agent avatars, forwarded to that workspace's `AvatarStore` Durable Object                          |
| `/agents/a2a`, `/agents/jwks.json`, `/.well-known/agent-card.json` | The built-in agents' core A2A edge: JSON-RPC, card-signing JWKS, stub card                         |

The JWKS path and the notifications path are both imported from
`@dynamicagents/g2a-protocol`, so the agent side and this side spell them identically.

A `scheduled` handler runs on the nightly cron (`0 0 * * *`), starting the reconcile and
maintenance Workflows.

---

## Components

### Built-in agents (`@dynamicagents/core` tenants)

Two agents ship in this repo, built on [`@dynamicagents/core`](https://github.com/dynamicagents/core)
and its Think-based runtime — the same foundation a remote agent from
`dynamicagents/starter` stands on. Each is a core **tenant**: a task host that owns its
A2A tasks, a task workflow that runs each one, and a step agent the turn runs on
(`src/agents/<tenant>/`). What is the gatekeeper's own is the soul, the memory block
and the tools; the turn, `ask_user`, cancellation, retries, compaction and delivery are
core's.

| Tenant       | Instance key             | Scope                                                                                                           |
| ------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `admin`      | `admin:{wsId}`           | One per workspace. Registry and workspace CRUD through admin tools; anyone in the admin channel may use them.   |
| `onboarding` | `onboarding:{dmChannel}` | One per direct-message channel. A DM concierge — it routes people with words, and can ask for a directory sync. |

They are reached **the way a remote agent is**: dispatch mints the same gatekeeper
JWT and sends the same accept-first `SendMessage`, and the reply comes back as a
signed push to `/a2a/notifications`. Only two things differ. The endpoint is derived
from the public URL (`/agents/a2a`) rather than registered, and dispatch hands the
request to the mounted core edge (`src/agents/worker.ts`) in-process instead of
dialing it. The callback is verified against the built-ins' own `A2A_SIGNING_KEY`.
The mounted tenants accept only an identity the gatekeeper minted for a built-in, so a
remote agent registered against this origin cannot reach the admin's tools.

Avatars the admin generates live in a separate `AvatarStore` Durable Object, one per
workspace, served at `/icons/…`.

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

The gatekeeper's own Workflows are bound in `wrangler.jsonc` and live in `src/workflows/`:

| Workflow              | Started by                               | Does                                                                                                    |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `MessageWorkflow`     | a classified Slack message               | Resolves targets, records correlation rows, dispatches one A2A task per agent                           |
| `LifecycleWorkflow`   | membership / team-join events            | Keeps the D1 registry in step with Slack membership                                                     |
| `ReactionWorkflow`    | a trigger message's agents starting work | Owns the 🛑 reaction's removal and **each agent's own** processing deadline; cancels tasks that overrun |
| `CancelWorkflow`      | a 🛑 stop reaction                       | Cancels every non-terminal task that trigger message woke, then confirms                                |
| `ReconcileWorkflow`   | nightly cron                             | Convergence backstop — repairs registry drift against Slack reality                                     |
| `MaintenanceWorkflow` | nightly cron                             | Expires human-in-the-loop prompts past their TTL and sweeps resolved rows                               |

Each built-in tenant also runs its tasks as a core task workflow — `AdminWorkflow` and
`OnboardingWorkflow`, in `src/agents/` — started by its task host, not by the gatekeeper.

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

At the other end, one message wakes at most **99 agents** (`MAX_WOKEN_AGENTS`). The
`ReactionWorkflow` stops each woken agent at its own deadline by spending a leg of its
budget loop per distinct expiry, so the fan-out has to stay below that loop's 100-leg cap.
A channel wide enough to exceed it is clamped where the fan-out is decided: the first 99 by
name are woken, the rest are skipped, and the thread is told so.

---

## Data storage

Registry state lives in **D1** (`da-registry`, bound as `DB`), schema in `src/db/schema.ts`
and migrations in `migrations/` (drizzle-generated; `npm run db:generate`). Nine tables:

| Table               | Purpose                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspaces`        | Workspaces, each with an admin channel. Workspace `0` is the org scope.                                                                                            |
| `slack_users`       | Slack user profiles and permission flags                                                                                                                           |
| `slack_channels`    | Channel ids and names seen by the gatekeeper                                                                                                                       |
| `workspace_admins`  | Which users administer which workspace                                                                                                                             |
| `agents`            | The agent registry — kind (`local`/`remote`), tenant, endpoint, card signing pin, `notify_on`, `task_deadline_seconds` (per-agent reply budget, 1 hour by default) |
| `agent_channels`    | Which agents are allowed on which channels                                                                                                                         |
| `agent_tasks`       | Correlation rows tying an A2A task back to its Slack message                                                                                                       |
| `hitl_requests`     | Open human-in-the-loop prompts and their TTL                                                                                                                       |
| `workspace_configs` | Per-workspace key/value config (see `SystemConfigKeys` / `OperatorConfigKeys`)                                                                                     |

Per-agent conversation history and memory are **not** in D1 — a built-in's live in
its step agent's own SQLite storage, where core compacts history past a threshold
into a summary and keeps it searchable.

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
     ├──────────────▶ admin / onboarding core tenant   (in-process, same JWT; replies to /a2a/notifications)
     └──────────────▶ remote agent over HTTPS           (signed JWT; replies to /a2a/notifications)
     │
     ▼
Slack Web API  (reply posted back)
```

Deploy with `npx wrangler deploy`. Local development is `npx wrangler dev`; `npm run check`
runs types, format, lint and typecheck, and `npm test` runs the vitest suite against
workerd. `npm run cf` is a credential-redacting Cloudflare API proxy for inspecting the
deployed Worker — see `AGENTS.md`.
