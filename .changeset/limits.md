---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
"@intentface/latch-server": minor
---

Limits — per org / user / agent budgets on turns, tokens and cost.
`createRuntime({ limits })` takes a `LatchLimits` seam: `limitsFor(principal,
agent, trigger)` names the counters a turn counts against and their caps
(fixed, epoch-aligned windows), and a `LimitStore` holds the counters. The
runtime refuses at admission with `LimitExceededError` (stable code
`limit_exceeded`, `retryAfterMs`; the HTTP handler maps it to 429 with
`Retry-After`), stops the tool loop once this turn's tokens reach the tightest
remaining token budget, and settles tokens + cost on finish — resumes and
subagent turns included. `runtime.cron()` prunes dead windows.
`@intentface/latch-drizzle` adds `latch_limit_counters` (both dialects) and
`createSqliteLimitStore` / `createPostgresLimitStore`.
