# Latch — Go-to-Market Thesis (INTERNAL)

> **Internal.** Not for clients or public/OSS distribution. The externally-safe framing lives in [`PHILOSOPHY.md`](./PHILOSOPHY.md).

## The thesis
We're a consultancy building AI features for SaaS companies. Building from scratch every time means (a) reinventing the same agent backend, and (b) getting pulled into the client's stack — PHP, Go, whatever — where we're slower and weaker. We're best at TypeScript.

Latch flips the conversation. Instead of "we'll build it from scratch in your backend," we lead with: **"we have a framework that brings ~80% of what you need out of the box — here's what you get vs. what you'd otherwise build."** We bring the tech and the expertise and customize it. Productized IP → shorter sales cycles, faster value, higher margin, and we work to our strength.

## The pitch (in order)
1. **Lead with standalone service, not embedding.** Latch runs as its own TS service their backend calls over an API. Their PHP/Go stack stays theirs; we deploy our strength as a sidecar. (Embed mode is the bonus for Node shops.) *This is the actual fix for "we keep ending up in their backend."*
2. **Build-vs-buy matrix as a real artifact.** A concrete list: out-of-the-box (persistence, durability, usage/cost, MCP, workspaces, scheduling, memory, …) vs. what they'd implement. Doubles as scoping for the paid custom 20%.
3. **Sell velocity + the 20%, not the 80%.** The boilerplate is why we start at the 5-yard line; the consulting wins the game. The hard, valuable work is their domain/data/UX/evals/integration.
4. **Zero-lock-in as a sales asset.** SaaS buyers fear vendor lock-in. "Self-hostable, ejectable, standard AI SDK underneath" is the answer — put it in the deck. The thing that makes Latch adoptable is the same thing that makes it ejectable.

## Risks / things to respect (challenges)
- **Don't let "80%" commoditize us.** Frame as velocity + de-risking, or buyers discount our value and assume the rest is trivial.
- **Cross-client maintenance burden.** A shared framework powering N production deployments is *ours* to maintain — bugs, security, and especially **AI SDK *beta* churn** hit all clients at once. Needs version discipline + a support story. This is part of what the eventual **hosted / open-core** path funds.
- **Validate the 80%, don't assume it.** Frameworks cost more than bespoke; payoff only if clients genuinely share that 80%. **Extract Latch from real engagements**, don't speculate features ahead of demand.
- **"Must live in our backend" clients.** Some refuse a second service (ops, data residency, latency, shared auth). Standalone won't help; embed only if Node. Fine if those aren't our best-fit clients — but know it going in.
- **Competition.** Buyers may compare to LangGraph/Mastra/Vercel/hosted platforms + a cheaper contractor. Differentiation = our expertise + customization + TS-native + we operate it + it's tuned to our delivery workflow.

## Why this also funds the future
The progressive tiers map to a pricing ladder, and the maintenance burden + managed-adapter opportunity is the natural lead-in to the hosted/open-core platform (see `PHILOSOPHY.md` → Future direction). Consulting funds and validates the IP; the platform monetizes it at scale. Same core, two business models.
