# @intentface/agents-sdk

Experimental. A tool-calling loop we own on top of the AI SDK, plus an
extension model where a feature is an extension rather than a change to the
runtime.

Private, version `0.0.0`, and deliberately **outside** the `@intentface/latch-*`
name pattern so the changeset `fixed` group does not drag it onto the published
version line. It depends on no latch package, so it can break freely. Nothing
in `apps/` imports it.

```bash
pnpm --filter @intentface/agents-sdk test
pnpm --filter @intentface/agents-sdk typecheck
```

## What it is testing

**Runs end, they do not pause.** A run that needs a human ends. The unanswered
tool call in the transcript *is* the suspended state, and resuming is a new run
over a longer message list. There is no `awaiting` status and there must not be
one.

This is the idea worth taking whatever happens to the rest. In
`packages/core/src/runtime.ts`, approval is mentioned 198 times — more than any
other concern — and most of it is bookkeeping for a paused state: an
`awaiting_input` run status, `PendingApprovalError`, declining undecided
approvals, and inferring the shape a turn left off in. None of that exists here.
It also shortens the lease question: a run never outlives its request, so a
lease only has to cover an active run rather than a human's lunch break.

`src/suspend.test.ts` proves the round trip, including a denial reaching the
model as `execution-denied` with the reason intact.

**The stored `UIMessage[]` is the only durable thing.** Everything else is
recomputed each step. Three moments change it: `before_agent_start` injects or
replaces, `step_end` appends, and a `tool_result` override *is* the stored
value. The rest are lenses that vanish after the step.

**Extensions return effects, not rewritten worlds.** `{ block }`, `{ append }`,
`{ replace }`. Each moment's powers are enumerable, which keeps `compose` small
and makes a merge rule statable per moment.

## The gate

`src/differential.test.ts` runs the same scripted model through this loop and
through `streamText({ stopWhen: isStepCount(5) })` and asserts identical UI
chunks — once with no extensions, and once with an extension listening to every
moment and returning nothing, so dispatch itself is proven inert.

That test is not optional. The SDK's continuation predicate is private and has
already changed shape inside v7: 7.0.2 computes `(A && B) || C` where 7.0.99
computes `B && (A || C)`, with no type change to catch it. Owning the loop means
owning that predicate, and this test is what turns a silent behaviour change
into a red build. Re-run it on every SDK bump.

## Differences from the prototype this came from

Three defects were found by running the prototype, and each has a test here.

1. **Failing open is not universal.** A throwing handler is reported and
   skipped, which is right for a weather-context extension and wrong for
   persistence: a database that is down has not "produced no effect", it has
   lost the step. Worse, a claim that throws left the run with no lease and the
   client's messages, so two workers could proceed at once. `Extension.critical`
   makes a handler fail the run instead.
2. **An injected message must not become the response anchor.** Appending it put
   it last, and `toUIMessageStream` merges the reply into a trailing assistant
   message, so the context part and the model's answer fused into one. Injection
   now lands before the final message.
3. **`instructions` must carry provider options.** The effect was `string`-only,
   which cannot express a prompt-cache breakpoint on the system prompt, since
   `Instructions` accepts `SystemModelMessage[]` with `providerOptions`. It now
   takes the full type.

Also here and not there: the loop is wired to the dispatcher, `StepContext`
carries a `runId`, the options we pass `ToolLoopAgent` in production are
forwarded to `streamText`, tool lookup is prototype-safe, and the continuation
predicate counts denied approvals the way the SDK does.

## Multi-tenancy

The principal's shape is declared once, by augmentation:

```ts
declare module "@intentface/agents-sdk" {
  interface Principal { orgId: string; userId: string }
}
```

After that `principal` is typed on `StepContext`, `StepInfo` and `agent_end`,
and nothing in any signature carries a generic. Latch threads `<P>` through 23
exported symbols, several of them twice, so every helper an application writes
inherits the noise; this buys the same safety for one `declare module`.

Pass it once to the loop. It reaches EVERY moment as a trailing `run` argument,
and it is merged into the context every tool reads, so an extension and a tool
cannot end up looking at different identities. That is what makes per-tenant
policy writable as an extension: which tools an org gets (`register_tools`),
what it may call (`tool_call`), what gets redacted (`tool_result`), and whose
run failed (`error`).

```ts
runAgentLoop({ model, tools, messages, principal, extensions })
```

One limit: the augmentation is PROGRAM-WIDE, not file-scoped, so an application
gets one principal shape.

### Reusable extensions must not read the principal

That limit has a consequence worth stating plainly. An extension published for
other people to use cannot read a principal's fields, because it has no idea
what shape the application declared. So it treats the principal as OPAQUE and
takes a key function instead:

```ts
sqlitePersistence(db, chatId, { owner: (p) => p.orgId })
```

Application-local extensions are free to read fields — they declared the shape.
It is only the reusable ones that need the seam. Latch draws the same line: `P`
is opaque to the framework and isolation comes from an `owner` function the
customer supplies to the adapter.

That function is not just typing hygiene, it is the isolation itself. Omit it
and a chat is addressable by id alone, so a guessed id reaches another tenant's
conversation. With it, claims, reads and listings are all fenced, and
`src/isolation.test.ts` asserts each one.

### Runs with no request

A cron fire, a resume, or a channel event hours later has no session to read
identity from, and extensions are built per request, so anything captured from
one is long gone. The persistence extension records the principal on the chat
row and `loadPrincipal(db, chatId)` reads it back:

```ts
const principal = loadPrincipal(db, chatId);
if (!principal) return;                       // never ran; refuse rather than invent one
await runAgentLoop({ model, tools, messages, principal, extensions });
```

Revalidate before using it. It was written when the chat last ran, and roles or
membership may have moved since, which is why a principal must carry durable
identifiers only. Latch does the same thing one level up: `createSchedule`
stores the identity blob for fire-time and `ReconstructPrincipal` rebuilds it.

The trigger itself is not an extension. Something outside the loop has to fire
on a cadence — an interval in a long-running process, or a platform cron hitting
a route — and then call the loop like any other host.

## Handing tools a principal

`toolContext` is one object every tool reads as `options.context` inside
`execute`, which is how a tool gets a principal, a database handle or a secret
resolver without a module global. The fan-out happens after `register_tools`,
so a tool an extension added is covered too.

It exists because the SDK's own `toolsContext` is keyed BY TOOL NAME — it looks
up `toolsContext[toolName]` — so one flat object there gives every tool
`undefined`, with no type error and nothing in the logs. Pass `toolsContext`
directly only when tools genuinely need different context; it merges over the
shared one per tool.

Note that this covers TOOLS. Extensions are ours, so the SDK knows nothing
about them, and context is per-call and never persisted — a resumed or
scheduled run has no request to build one from. Tenancy that must survive those
paths belongs on the loop as a type parameter, not in this option.

## Streaming whole steps

```ts
runAgentLoop({ model, tools, messages, stream: "steps" })
```

`"deltas"` (the default) forwards every chunk as it arrives. `"steps"` holds a
step until it completes, then sends its chunks together with each text part
coalesced into one.

It costs responsiveness and buys two things: a reader sees finished thoughts
rather than a sentence assembling itself, which suits a log or a digest; and it
is the only mode where `render` can act on text, because a masking rule needs a
finished paragraph rather than the fragment it arrived in. Storage is unchanged
either way — the view is a lens, so a hidden part is still in the transcript.

## Known gaps

- **A gated tool cannot stream.** The veto is async and must resolve before
  `execute` runs, so progress chunks collapse on that path. With no `tool_call`
  listener the streaming-safe path is used instead, and `src/loop.test.ts`
  asserts progress survives there.
- **`tool_result` redacts the output, not the input.** A secret passed as a tool
  argument stays in the transcript. Asserted in `src/loop.test.ts` so it cannot
  change silently.
- **Text deltas cannot be redacted in the default mode.** `render` works on
  whole parts, and a rule cannot match a secret arriving four characters at a
  time. `stream: "steps"` fixes it by holding each step and coalescing its text
  before the view rules run, at the cost of live typing. Outside that mode,
  treat `render` as presentation and never as a security boundary; mask secrets
  in `tool_result`, where the override is what gets stored.
- **Steering starts a new assistant message.** Appending a user message mid-run
  changes the anchor, which is correct but means "one run, one assistant
  message" holds only until someone steers.
- **Usage fixtures are nested, not flat.** The provider emits
  `inputTokens: { total, cacheRead, … }` and the SDK flattens it into
  `inputTokens` plus `inputTokenDetails`. A flat mock fixture parses fine and
  silently reports zero tokens, which is a quiet way for a cost test to pass
  while measuring nothing. `cost.test.ts` has the correct shape.

## What ships with it

`sqlite` (a subpath export) is persistence, the lease and fencing as one
transactional extension marked `critical`. `costTracking` prices each step,
carries the cache split, and refuses to start a step that would break a ceiling
— the check runs before the model call, because a limit you only notice after
overrunning it is a report rather than a limit. On its own it measures one run;
`sqliteSpend` gives it a durable tally so a ceiling spans turns, keyed by chat,
user or org and bucketed by day or month.

Layered ceilings need nothing extra — two instances with different keys:

```ts
extensions: [
  costTracking({ name: "cost:org",  pricing, limit: 100, ...sqliteSpend(db, p.orgId,  "month") }),
  costTracking({ name: "cost:user", pricing, limit: 5,   ...sqliteSpend(db, p.userId, "day")   }),
]
```

The tighter one stops the run, both tallies stay accurate, and a second user in
the same org keeps their own allowance until the org ceiling is reached. `compaction` inserts a summary at a
boundary and narrows the MODEL's view to that point onward, while storage and
the reader keep every original turn — a summary is a reading aid for the model,
not a reason for a person to lose what they said. It never places the boundary
past an unanswered tool call, since that call is a suspended run's resume
point, and it registers `/compact` for doing it on demand. `truncateToolOutput` cuts an oversized tool
result and tells the model it was cut, since otherwise it reasons about a
partial answer as though it were whole. `reconcile` is the merge a persistence
extension needs so a client's approval decisions and browser tool outputs are
not discarded as duplicates.

## Next

The honest acceptance test is the existing smoke suite in `apps/example` —
durability, resume, approval, subagent-approval. Those encode behaviour that
exists nowhere else in writing. If this loop passes them unchanged, the
hard-won part transferred.
