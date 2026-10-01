---
"@intentface/latch-agent-builder": minor
"@intentface/latch-drizzle": minor
---

Candidates: named, unpublished configurations of an agent that everyone who can edit it shares — "haiku with shorter instructions", "new tools". Unlike a draft, which belongs to one person, a candidate belongs to the agent: `saveCandidate` / `getCandidate` / `listCandidates` / `closeCandidate` on the store, and `name@c_<id>` resolves one read-only, the way `name@7` pins a version, so it can be run (and measured) without going live. Closing one — discarded, or published with `publishedAs` — keeps it, so anything filed under it keeps its name and still resolves. New table `latch_agent_candidates` (SQLite and Postgres, created by `migrate`). `parseAgentRef` returns `at: "c_…"` for a candidate ref, and `isCandidateId` tells one apart.

A pinned resolve (`name@7`, a draft, a candidate) now reports the version that actually runs as `configVersion` — `7`, or none for a draft or candidate — instead of the live one, so run records and traces attribute pinned answers correctly.
