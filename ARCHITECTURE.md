# Architecture

## Overview

**slack-gatekeeper** is the entry point for all Slack traffic in your agent network. When a message arrives, the gatekeeper determines which agent owns it based on the source channel, invokes that agent, and posts the response back to Slack. This routing loop is what gives the gatekeeper its name.

Today the gatekeeper is a single Cloudflare Durable Object that handles everything. The architecture below describes both the current implementation and the intended design as additional agents are introduced.

---

## Current state

A single `SlackAgent` Durable Object:

- Receives Slack events via the `/slack/events` HTTP endpoint
- Responds to `@mentions` in any channel and to direct messages (DMs)
- Schedules and fires reminders using the Agents SDK scheduler
- Persists state in SQLite (via the Durable Object's built-in storage)

---

## Components

### SlackAgent — the gatekeeper

**Status: current**

The `SlackAgent` is a [Cloudflare Durable Object](https://developers.cloudflare.com/durable-objects/) built on the [Agents SDK](https://developers.cloudflare.com/agents/). A single instance (keyed by `"default"`) handles all inbound Slack events for the workspace.

Responsibilities:

- Parse and verify incoming Slack webhook payloads
- Route messages to the appropriate handler by channel or conversation type
- Maintain conversation context and scheduler state
- Post AI-generated responses back via the Slack API

### OrgAdmin Agent

**Status: planned**

Handles messages in the designated `#org_admin` Slack channel only. This is a restricted entry point for organizational management: registering A2A agents, managing channel mappings, and configuring gatekeeper behaviour. Regular users do not interact with this agent directly.

### Onboarding Agent

**Status: planned**

Handles all direct messages (DMs) sent to the Slack app. This is the first point of contact for new users — it introduces the agent network, guides users through what the agents can do, and answers setup questions.

### A2A Agents

**Status: planned**

Any message posted in a channel that is not `#org_admin` and not a DM is considered to be addressed to an external **Agent-to-Agent (A2A)** agent. The gatekeeper resolves which registered agent owns that channel using [A2A name routing](#a2a-name-routing) and forwards the message to it. The response is posted back at channel level by default, and only goes into a thread when the incoming Slack event carries a real thread_ts different from the message ts.

This design lets teams deploy domain-specific agents independently and register them with the gatekeeper to make them accessible through Slack — without touching this codebase.

---

## Message Routing

| Slack source         | Handled by                              |
| -------------------- | --------------------------------------- |
| `#org_admin` channel | OrgAdmin Agent                          |
| Direct message (DM)  | Onboarding Agent                        |
| Any other channel    | A2A routing → registered external agent |

The routing logic lives in the gatekeeper's message handler and consults the agent registry to resolve the correct A2A target.

---

## Data Storage

**Status: planned**

The Durable Object's SQLite backend (already provisioned) will store:

| Table      | Purpose                                          |
| ---------- | ------------------------------------------------ |
| `channels` | Registered channels and their A2A agent mappings |
| `users`    | Slack user profiles seen by the gatekeeper       |
| `messages` | Per-thread message history for context           |

---

## A2A Name Routing

**Status: planned — to be detailed in a separate document**

External agents register themselves with the gatekeeper (via the OrgAdmin Agent) by providing:

- The Slack channel they own
- A unique agent name users can mention in that channel
- A communication endpoint (Cloudflare Service Binding, HTTP URL, or equivalent)

When a message arrives in a registered channel, the gatekeeper uses the mentioned agent name when one is present; otherwise it defaults to the single agent configured for that channel. If multiple agents are available and no name is mentioned, the gatekeeper asks the user to address one by name. Once resolved, the gatekeeper looks up the endpoint, forwards the message payload, and posts the response back to Slack. Registered agents are fully independent workers — they do not need access to this codebase to operate.

---

## Deployment

```
Slack workspace
     │  webhook  POST /slack/events
     ▼
Cloudflare Worker (stateless fetch handler)
     │  routes to
     ▼
SlackAgent Durable Object (stateful, SQLite)
     │  AI via Workers AI binding
     │  Slack API via Bot Token
     ▼
Slack workspace  (response posted back)
```

A single `npm run deploy` ships both the Worker and the Durable Object to Cloudflare's global network.
