# TwentyOne — Roadmap

## Recently shipped (last two quarters)

- **Agent steps in workflows** — the ability to place an AI action inside a workflow with a
custom prompt. Their first genuinely agentic surface, as opposed to a chat box.
- **Page-context awareness in assistant chat** — the assistant now knows which record or
view the user is looking at.
- **Custom objects GA** — user-definable data models moved out of beta. Not an AI feature,
but it is the substrate the agent work depends on, since agents operate over these
objects.
- **Helm chart for self-hosted Kubernetes deployments.**

## This quarter (committed)

- **Agent step improvements** — better error messaging when a step fails, and the ability
to reference outputs from earlier workflow steps in an agent prompt.
- **Bulk operations via assistant chat** — letting the assistant act on a filtered set of
records rather than one at a time.
- **SSO/SAML hardening** for the paid tier.
- **Email integration rebuild** — the largest non-AI item this quarter and the one
consuming the most engineering time.

## Under discussion, not committed

- A first-party MCP server. There's an open issue with community support behind it and
internal agreement that it should exist, but it has not been scheduled and no one owns it.
- Some form of agent run visibility. Raised repeatedly in support escalations when a
workflow produces a wrong result and nobody can explain why. No design yet.

## Beyond this quarter

**Not discussed.** No roadmap horizon past the current quarter was shared. Annual planning,
longer-term product bets, and where they want the agent surface to be in a year did not
come up.

## Explicitly deferred

**Not discussed.** It was not established whether anything has been considered and
deliberately declined.
