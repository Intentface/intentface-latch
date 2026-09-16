---
"@intentface/latch-agent-builder": minor
"@intentface/latch-drizzle": minor
"@intentface/latch-core": minor
"@intentface/latch-langfuse": minor
---

Agent records are now versioned, so editing a prompt no longer destroys the one
that was running.

`upsert` publishes: it writes the live record and appends a version, unless the
content is unchanged — history stays a list of real changes rather than of save
events. Rolling back is `activateVersion`, which moves a pointer and appends
nothing, so flipping between two configurations can't inflate history. Each
version carries its author, the fields that differ from its predecessor, and an
optional note. A separate activation log records who made which version live and
when, which the version list alone can't say once rollback stopped appending.

Drafts are stored per editor, not per agent: `owner` is an isolation boundary a
whole org shares, so a single draft per agent would let two admins silently
overwrite each other's half-written prompt. A draft never affects a running
agent, and carries the version it started from so a stale publish is detectable.

The whole record is snapshotted, not just the instructions. A version is
therefore always a configuration that actually ran together — restoring a prompt
alone could produce a combination that never existed, such as one referencing a
tool removed two edits ago.

Runs and traces now record which version produced them (`agent_version` on the
run, an `agent-version:<n>` Langfuse tag), so a past answer stays attributable to
an exact configuration and scores can be compared across versions.

Migrating backfills every existing agent as v1. Without it the first publish
after upgrading would create v1 from the NEW content and the prompt that had been
running would be lost — the exact failure this feature exists to prevent.
