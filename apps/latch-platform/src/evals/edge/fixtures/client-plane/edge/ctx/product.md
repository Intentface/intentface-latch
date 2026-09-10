# TwentyOne — Product

## What it is

TwentyOne is an open-source CRM, positioned as the open alternative to Salesforce and
HubSpot for revenue teams that want to own their data and extend the system themselves.
Available as a managed cloud offering and as a self-hosted deployment. The self-hosted
edition is the same codebase; a paid tier gates SSO/SAML, audit logging, and support SLAs.

## Who it's for

Mid-market revenue teams (roughly 20–200 seats) at technically-minded companies —
especially ones already running self-hosted internal tooling. A meaningful share of
adoption comes from engineering-led evaluation rather than from a sales motion: teams find
the repo, self-host it, then convert to cloud when they tire of running it.

## The building blocks

The product is built around four extensible primitives, and this is how the team talks
about it internally and in the docs:

- **Objects** — custom data models, user-definable
- **Views** — table, kanban, and record layouts over those objects
- **Workflows** — multi-step automations
- **Agents** — AI actions that can be placed inside a workflow

Agents being a first-class primitive alongside the other three is deliberate and recent.

## AI and agentic features live today

- **Assistant chat.** A conversational surface with access to workspace data and awareness
of the page the user is on. Users query records, ask for summaries, and draft content
in natural language. It can read and write records within the user's own permissions.
- **Agent steps in workflows.** An agent can be dropped into a workflow as a step and given
a custom prompt — categorise this lead, enrich this company record, draft a follow-up.
It performs multi-step work within the bounds of that one workflow run.
- **Workflow triggers.** Workflows fire on record change, on a schedule, or via inbound
webhook. So agent steps do run unattended.
- **Permissions.** AI features inherit the existing role-based access control. An agent
step acts with the permissions of the workflow's owner.

What is *not* there today: no user-facing agent builder (agents are configured as workflow
steps, not composed independently), no run history or trace view for agent steps, no
per-agent permission scoping distinct from RBAC, no usage metering for AI, and no
first-party MCP server — several community-built ones exist and are reasonably popular,
and there is an open issue requesting an official one.

## Integration surface

Public GraphQL and REST APIs, both documented and used by customers. An `AGENTS.md` in the
repo root gives external coding agents guidance on working with the codebase. OAuth for
third-party app connections.

## Scale and traction

**Not discussed.** No usage numbers, seat counts, revenue, or adoption metrics for the AI
features were shared. It is not known how many customers use assistant chat or agent
workflow steps, or how often.
