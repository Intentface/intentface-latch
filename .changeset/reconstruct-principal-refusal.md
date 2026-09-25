---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
---

`reconstructPrincipal` can now refuse a stored identity by returning `null`, and
the runtime makes that refusal terminal instead of replaying the identity.

Until now the hook could only return a principal, so a user removed from their
tenant after creating a schedule kept firing it — as themselves, indefinitely.
Throwing did not stop it: a cron fire consumes its occurrence before rebuilding
the principal, so the schedule stayed live and refused again on every tick, and
a throw on resume aborted the rest of `sweep`'s loop.

- **Cron:** a refused fire is not run, and the schedule is disabled in the same
  write that consumes the occurrence. `runDue` (and `cron().due`) report it in a
  new `rejected` counter, separate from `errors`. The result type is exported as
  `RunDueResult`.
- **Resume:** a refused run ends `errored` (fenced write) without loading its
  history or resolving its agent as that identity, and `sweep` continues with
  the next run.
- A **throw** keeps its current meaning — a transient failure: counted in
  `errors`, the occurrence consumed, the schedule left live.

The hook now runs before the occurrence is consumed, inside the schedule's
claim lease, so keep it well under `durability.leaseTtlMs`. If the lease does
lapse, the fire is now skipped rather than duplicated: `completeSchedule` may
return `false` when its fence rejected the write (another node holds the
claim), and `runDue` then leaves the occurrence to that node. The drizzle
adapter reports it; adapters returning `void` are treated as applied, as
before. This also closes the older, narrower window between claim and consume.
`completeSchedule` also takes an optional `claim` (`{ leaseExpiresAt }`, the
value the claim stamped) so a re-claim by the SAME instance — two `runDue`
passes sharing an `instanceId` — fences out the earlier pass's late consume;
the drizzle adapter fences on it. Adapters that ignore it keep the owner-only
fence.

A refused resume also releases the run's lease, so the errored row cannot be
re-claimed by a later `resume()`.

Upgrading: existing hooks keep working unchanged. Tests that deep-equal
`runDue`'s result need `rejected: 0`.
