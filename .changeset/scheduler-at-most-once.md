---
"@intentface/latch-core": patch
"@intentface/latch-drizzle": patch
---

Scheduled occurrences are now consumed before firing, and durability failures are no longer silent.

**`runDue` advances `nextRunAt` immediately after the claim, before the fire.** Previously the
advance sat in a `finally` after the turn, while the claim lease (stamped once, never renewed,
30s default TTL) was the only thing keeping the row from being claimed again — so any scheduled
turn longer than the TTL left its own occurrence re-claimable for the rest of the turn. A second
node, a deploy overlap, the `POST cron/run` backstop, or even the same instance's next tick would
then fire the same occurrence again, each time as a full paid turn. Worse, interleaved claimers
fence-rejected each other's advances, so the row could stay due across many fires.

Occurrences are now **at-most-once**: a process that dies mid-fire does not retry the occurrence —
the run row survives and `sweep()` resumes the turn, so recovery never means a second paid attempt.
If the advance itself fails, the fire is skipped (previously the failure was swallowed and the
schedule would re-fire on every tick).

**A thrown run-heartbeat write is no longer swallowed.** It is logged, and once consecutive
failures span a full lease TTL the turn aborts — previously a run whose beats were all failing
kept streaming at full token cost while the reaper reclaimed it and a second worker resumed the
same turn. Step checkpoints (`onStepEnd`) also stop once the turn has aborted, so a zombie can no
longer interleave messages into a chat its replacement is replaying into.

Docs corrected to match: the claim lease alone was described as making occurrences "exactly-once
across nodes" — it never did, and the drizzle schedule smoke now pins both halves of the real
contract.

No storage interface changes; existing adapters work unchanged.
