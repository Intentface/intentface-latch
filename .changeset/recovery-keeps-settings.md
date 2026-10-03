---
"@intentface/latch-core": patch
"@intentface/latch-drizzle": patch
---

Crash recovery resumes a run the way it started, and `runAgent` always says why a turn failed.

- **Recovery keeps the turn's settings.** An unattended run (`runAgent`, cron, an autonomous delegation) records how it was asked to run on its row: `RunRecord.settings`, with `autoApprove`, `blockGated`, `memory` and `promptCaching`. `resume` / `sweep` now resume it the same way. Before, every recovered run resumed as an attended one. An unattended run then parked on a gate nobody would answer, memory off came back on, and an approval mode restored without its `blockGated` would have run a test run's gated tools for real; the two are saved and restored together. A run started on a per-turn **model override** is refused instead, settled `errored` with the model's id: the model object can't be stored, and finishing the run on the agent's own model would quietly change what answered. An attended chat turn records nothing and resumes as before.
- **`runAgent` reports every failure as `error`.** A turn that fails while it is set up, such as a tool source that won't open, used to throw from `runAgent` and leave its run `active`, holding the chat until the lease lapsed. It's now settled `errored`, its reserved limits are released, and the error is returned. A failure that ends the run with no error chunk in the stream, such as a critical extension's last `step_end`, is read back from the run row. Admission refusals still throw, as before.
- **drizzle:** `latch_runs.settings` (SQLite `TEXT`, Postgres `JSONB`), added by `migrate`.

**Upgrading:** a host with its own `StorageAdapter` should store `settings` from `createRun` / `claimRun` / `openTurn` and return it on the run. Without that, recovery resumes with an attended turn's defaults, as it did before.
