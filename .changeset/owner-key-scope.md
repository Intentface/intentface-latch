---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
---

**Owner keys on id-only storage calls.** The calls the runtime makes by id (`appendMessages`, `updateRun`, `getRun`, `heartbeatRun`, `reclaimRun`, `completeSchedule`, `noteScheduleFire`) now take an optional last argument, `OwnerScope`: the owner key the adapter put on the record, handed back (`Runtime.getRun` passes `{ principal }` instead, having no record yet). An adapter can check it, and refuse another owner's key with `OwnerKeyMismatchError`, or route by it, so an adapter with one schema or database per tenant needs no global index of ids. Adapters that ignore it keep working.

- `RunRecord.ownerKey`: a run's chat's owner key, stamped when it opens. The runtime passes it on every call about that run, crash recovery included.
- `decodeOwnerKey(key)` reads the segments of a key made by `encodeOwnerKey`.
- `createRuntime({ onOwnerKeyMismatch })` hears about a mismatch. Recovery and schedules never retry one: they leave that run or schedule alone and report it, also in `cron()`'s `errors`.
- `sweep()` now returns `errors`, one line per run whose recovery failed, and `cron()` includes them. `resume()` also accepts the run record, which carries its key.
- **Conformance kit:** new checks for chat id conflicts, `listChats` kinds, `listRuns` scoping and schedules (racing claims, stale completions by holder and by claim, bumps, fired one-shots, deleting mid-fire, delayed fire stamps). Owner-key checks run when the target sets `checksOwnerKey: true`.
- **latch-drizzle:**
  - Runs store `owner_key`. `migrate` adds the column and fills it for active runs; finished runs fall back to their chat's owner.
  - The adapters check owner keys.
  - `recordUsage` files usage under its run's owner, as the storage contract says, instead of deriving it again from the principal it's called with.
