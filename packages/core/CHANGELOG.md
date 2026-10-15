# @intentface/latch-core

## 0.21.0

### Minor Changes

- c69e6cd: Vault master key rotation, and secrets tied to their owner.
  
  - `createVault({ masterKey: { id, key }, previousKeys: [{ id, key }] })`: name each master key, and keep old ones readable while rotating. A plain string key still works, with the id `default`.
  - `vault.rotate({ batchSize? })` (on `RotatableVault`, what `createVault` now returns; `Vault` is unchanged, so wrappers around one keep compiling) moves every secret onto the current key by re-wrapping its data key (values aren't re-encrypted). Safe to run again or stop part-way; a secret saved again while it runs is left as saved. Returns `{ checked, rewrapped, remaining, errors }`; at `remaining: 0` the old keys can go.
  - New secrets record their key id in `wrappedDek` (`v2:<keyId>:<binding>:…`, no schema change) and are bound to their owner key and name, so a record copied into another owner's row no longer decrypts. Secrets saved before stay readable after upgrading, and `rotate()` binds them. Older versions can't read secrets saved by this one: after upgrading, don't roll back to 0.20 or earlier, and expect an instance still on the old version mid-deploy to fail on secrets saved in that window.
  - A master key can live in a key service: pass a `VaultKeyProvider` (`{ id, wrap, unwrap }`) that calls AWS KMS, Google Cloud KMS, HashiCorp Vault or your HSM. It gets each secret's data key and an encryption context naming the secret and its owner; the key never reaches your app. `rotate()` moves secrets onto it from a key held here.
  - `SecretStore` gains optional `ownerKeyOf`, `scan` and `replaceWrap`; the Postgres and SQLite secret stores implement them. Without `scan` and `replaceWrap`, `rotate()` throws `UnsupportedOperationError`.
  - `deriveMasterKey(passphrase, { salt, cost })` takes scrypt's N. The default stays `2 ** 14` so existing keys don't change; use `2 ** 17` for new deployments.

### Patch Changes

- @intentface/latch-net@0.21.0

## 0.20.0

### Minor Changes

- 58a56e2: **Deleting data.** Removing a person's data on request, or a customer who leaves, no longer means SQL behind Latch's back.
  
  - `runtime.deleteChat({ principal, chatId })` deletes a chat with its messages and runs, and the subagent threads it spawned. Its usage rows stay: the ledger records what was spent. It refuses while an answer is running (`ChatBusyError`). The handler serves it as `DELETE chats/:id` (`404` when the chat isn't the caller's, `409` while busy, `501` when storage can't delete).
  - `runtime.purgeOwner(segments, { also })` deletes everything stored for an owner path: `[orgId]` for an organization and everyone in it, `[orgId, userId]` for one person.
    - It runs every store until done and returns counts per store.
    - **Usage is kept by default**, re-filed one level up (`[orgId, userId]` → `[orgId]`) with its run id cleared, so billing totals stay right. Choose with `usage: "refile" | "keep" | "delete"` and `refileTo`. A one-segment path (a whole tenant) has nothing above it, so it needs `usage: "delete"` or `"keep"`.
    - It checks first that every store can purge, and refuses (`UnsupportedOperationError`) before deleting anything if one can't.
  - **New optional `purgeOwner`** on `StorageAdapter`, `SecretStore`, `AgentBuilderStore` and `MemoryJobStore`. It works in passes (`{ removed, done }`), is idempotent, and matches by prefix with a plain comparison, never SQL `LIKE`. `isUnderOwner(key, segments)` states the rule.
  - **New optional `deleteChats(principal, ids)`** on `StorageAdapter`: all or nothing, refusing with `ChatBusyError` if any of the chats has an answer running.
  - **latch-drizzle implements all of them.**
    - Run and message inserts look their chat up, so nothing can land for a deleted chat as an orphan. On Postgres the lookup waits for a deletion of that chat to commit, which serializes deleting a chat with a run starting in it.
    - A purge fences live runs before their chat goes.
    - The agent store also removes the drafts a person is writing in an organization's agents.
  - **Conformance kit:**
    - `deleteChats`: scoped, complete, all or nothing around a live run, and a deleted chat can't be written to.
    - `purgeOwner`: works in passes, idempotent, another owner untouched, a live run fenced out.
  
  **Fix:** an answer that failed partway never wrote its spend to the usage ledger, or onto its run, though it counted against limits. It now does both, so a bill from the ledger includes failed answers.

### Patch Changes

- @intentface/latch-net@0.20.0

## 0.19.0

### Minor Changes

- 302f5c0: **Owner keys on id-only storage calls.** The calls the runtime makes by id (`appendMessages`, `updateRun`, `getRun`, `heartbeatRun`, `reclaimRun`, `completeSchedule`, `noteScheduleFire`) now take an optional last argument, `OwnerScope`: the owner key the adapter put on the record, handed back (`Runtime.getRun` passes `{ principal }` instead, having no record yet). An adapter can check it, and refuse another owner's key with `OwnerKeyMismatchError`, or route by it, so an adapter with one schema or database per tenant needs no global index of ids. Adapters that ignore it keep working.
  
  - `RunRecord.ownerKey`: a run's chat's owner key, stamped when it opens. The runtime passes it on every call about that run, crash recovery included.
  - `decodeOwnerKey(key)` reads the segments of a key made by `encodeOwnerKey`.
  - `createRuntime({ onOwnerKeyMismatch })` hears about a mismatch. Recovery and schedules never retry one: they leave that run or schedule alone and report it, also in `cron()`'s `errors`.
  - `sweep()` now returns `errors`, one line per run whose recovery failed, and `cron()` includes them. `resume()` also accepts the run record, which carries its key.
  - **Conformance kit:** new checks for chat id conflicts, `listChats` kinds, `listRuns` scoping and schedules (racing claims, stale completions by holder and by claim, bumps, fired one-shots, deleting mid-fire, delayed fire stamps). Owner-key checks run when the target sets `checksOwnerKey: true`.
  - **latch-drizzle:**
    - Runs store `owner_key`. `migrate` adds the column and fills it for active runs; finished runs fall back to their chat's owner.
    - The adapters check owner keys.
    - `recordUsage` files usage under its run's owner, as the storage contract says, instead of deriving it again from the principal it's called with.

### Patch Changes

- @intentface/latch-net@0.19.0

## 0.18.0

### Minor Changes

- 666085c: A storage `owner` that returns a missing or empty segment now throws, instead of filing the row under the string `"undefined"`. Before, `owner: (p) => [p.orgId, p.userId]` put every principal without a `userId` into one shared `orgId/undefined` bucket, so their chats, secrets or agents mixed without an error. If you see the new error, decide what those principals should see. Return `[p.orgId]` only when a principal without a `userId` is *meant* to share the organization's data (a team chat, an org-wide secret); for personal data, throw in `owner` (or refuse them in your login) instead. A missing `userId` is not a reason to grant org-level access.
  
  The checked encoder is exported as `encodeOwnerKey(segments)` from `@intentface/latch-core`, for your own adapters and owner-scoped tables.
- 7339995: A `runSchedule` hook that throws, or returns something other than `true`, `false` or `{ handled }` (say `undefined`, from a hook that forgot to return), now ends that occurrence as an error (`runDue`'s `errors`) and nothing else runs. Before, a throw fell through to the default run in a new chat, so a hook that had already run the agent and then failed (on delivery, say) paid for the same occurrence twice. To decline, return `false` before doing any work, as before; once delivered, return `true` even if a later step fails.

### Patch Changes

- @intentface/latch-net@0.18.0

## 0.17.1

### Patch Changes

- a132539: Memory is now marked **experimental**: the `memory` options on `createRuntime` and `defineAgent`, the `@intentface/latch-memory` package and its docs. The only production store today is a Loredex workspace, and the interface still carries Loredex conventions, so the design may change in any release. Nothing changes in behaviour.
- 0bee5fd: The doc comments on `createRuntime`'s options, the runtime's methods, `defineAgent`, `defineContext` and usage limits now explain each option for someone using it: what it does, what happens without it, and its default. They show in your editor and in the new generated reference on the docs site.
  
  The inputs of `runAgent`, `applyApproval`, `applyToolResult` and `schedule` are now exported as named types (`RunAgentInput`, `RunAgentResult`, `ApplyApprovalInput`, `ApplyToolResultInput`, `ScheduleInput`), for typing your own wrappers. Nothing else changes.
- @intentface/latch-net@0.17.1

## 0.17.0

### Minor Changes

- e16480d: **Params: what a chat is about.** An agent can declare `params` with a schema (Zod, Valibot, any Standard Schema): `defineAgent(fn, { params: z.object({ ticketId: z.string() }) })`. The chat's first message passes them (`handleChat({ …, params })`, also `runAgent` and `schedule`). They're validated, saved on the chat, and given to the agent function and to tools (`context.params`) on every turn: later messages, the continuation after an approval, crash recovery, and schedule fires. Later messages don't send them again; the same params again are fine, different ones are refused (`ParamsFixedError`, 409). An agent without a schema refuses params (`InvalidParamsError`, 400).
  
  **`context` is a plain function**: `createRuntime({ context: async ({ principal }) => ({ … }) })`, and it's optional. `defineContext({ build })` still works but is deprecated, as are `turnContext` and `request`, which are missing when an answer continues.
  
  **`agent` is optional for a continuing chat**: `handleChat` uses the agent the chat was started with.
  
  **Storage:** chats and schedules get a `params` column (`migrate` / `migratePostgres` add it). A custom adapter should store `params` on `createChat` and `createSchedule` and return it; the conformance kit now checks chats.
- 39c2910: **`data-context`: what the user is looking at, on their message.** A client can attach one `{ type: "data-context", data: { … } }` part to a user message, for example the open file, the selection or a model pick:
  
  - **The model** reads it as text in that message, after what the user wrote. The default wording is a `[Context]` block of `key: value` lines; `createRuntime({ messageContext: { toModel } })` changes it, and an agent can override it in its `defineAgent` meta (return `undefined` to leave it out).
  - **Agent functions and tools** get the latest one as data: `messageContext`.
  - **Chat UIs** don't render data parts, so the user doesn't see it.
  
  It's saved with its message. A continuation of the answer (after an approval, or a crash) therefore sees the same values, and the instructions stay the same between messages, so prompt caching keeps working: no more per-message state in the system prompt.
  
  `messageContext.schema` checks it when a message arrives (a mismatch is refused, 400). Without a schema it's free-form JSON, at most 32 KB, one per message, and never the only part of a message. Like params, it describes; it never authorizes.
- 744431b: New `ToolContext<Principal, Ctx>` type: what a tool receives as `options.context` during a run. That's whatever your `defineContext` `build` returned, plus `principal`, `run` (`id`, `chatId`, `agent`), `writer` and `runtime`, which Latch adds for every tool. Use it instead of declaring those fields by hand:
  
  ```ts
  execute: async ({ orderId }, { context }) => {
    const { orders, principal } = context as ToolContext<Principal, Ctx>;
    return orders.refund(orderId, principal.userId);
  },
  ```

### Patch Changes

- @intentface/latch-net@0.17.0

## 0.16.0

### Minor Changes

- a8e7b0d: Safer file handling, ahead of the attachment store (#179).
  
  - **Downloading file URLs for the model is bounded, and refused where it can't be checked.** When a model can't fetch a file part's URL itself, the server downloads it. On Node this still uses the AI SDK's download, which checks the URL, every redirect and the address actually connected to. Latch now caps each file at 50 MB (the SDK allowed 2 GiB) and 60 seconds, redirects and body included. On runtimes where the SDK can only check the URL text (Bun, Deno, edge, workerd), Latch refuses such downloads instead of risking a request to a private address. Send the file inline there, or use a model that fetches URLs itself. URLs the model fetches itself are unaffected. This applies to chat turns and to compaction.
  - **Files sent inline are capped.** A user message's inline files (`data:` URLs, in any letter case, how `useChat` sends attachments by default) may total at most `maxInlineFileBytes` (a new runtime option, default 20 MB). A message over that is refused with `InvalidMessageError` (HTTP 400) before anything is stored. Files sent by URL are not counted.
  
  **Upgrading:** if your users send more than 20 MB of files inline in one message, raise `maxInlineFileBytes`. On Bun, Deno or edge runtimes, file URLs a model can't fetch itself now fail instead of being downloaded unchecked.

### Patch Changes

- d655b0c: Stock `useChat` clients work fully with the chat route.
  
  - **Attachments and message ids survive `useChat`'s default body.** With the default transport (`{ messages }`), the server used to rebuild the newest message as text only, under a new id: images and files never reached the model and disappeared from the chat. The newest message now goes to `handleChat` as sent, which keeps its id and its files (and `useChat`'s approval answers).
  - **The last question can be regenerated or edited.** `regenerate()` resends the last question unchanged; `sendMessage({ messageId })` resends it edited. Either way, what it replaces (the answers after it, and an edit's earlier wording) is hidden from the user and the model but stays stored, and the agent answers again. The edited question keeps its id, so it can be edited again. Since 0.15.0 both were refused with 400. Crash recovery and approvals never continue a hidden answer, a refused turn (a limit, a busy chat) hides nothing, and memory extraction skips hidden messages.
  - **An earlier question is refused with 409 `rewind_not_supported`** (`RewindNotSupportedError`) instead of a generic 400. Changing it in place would hide everything after it, including what the agent did since. Fork the chat at that question instead.
  - **User message parts are rebuilt from their known fields:** text keeps `text`; a file keeps `mediaType`, `url`, `filename` and a `providerReference` (from the SDK's `uploadFile`). Other fields are dropped, such as `providerMetadata`, which would become options on the model call. A text or file part missing its required fields is refused.
- @intentface/latch-net@0.16.0

## 0.15.0

### Minor Changes

- d4356e3: `useChat`'s own approval flow works with Latch. After `addToolApprovalResponse`, with `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`, `useChat` sends the paused assistant message back to the chat route; `handleChat` now reads only the decisions from it and continues the run exactly as `applyApproval` does, streaming the answer into the same message. Nothing else in the client's copy is stored or used: a tool runs with the input the agent asked for. Several cards in one step work the same way, and answers sent twice are ignored. `applyApproval` and the approvals route still take decisions from anywhere else (Slack, another device).

### Patch Changes

- d77af82: `handleChat` accepts only a new user message. The message must have the `user` role and contain only text and file parts, and its id can't already be in the chat, except when resending the chat's last message after a dropped response. Latch now sets the message's `visibility` itself and keeps only `createdAt` and `voice` from the client's metadata. Anything else is refused with `InvalidMessageError` (code `invalid_message`), which the HTTP server answers with 400. Approval decisions still go through `applyApproval`.
  
  **Upgrading:** update promptly. If your client sends anything other than text and files in a user message, it now gets a 400.
- @intentface/latch-net@0.15.0

## 0.14.0

### Minor Changes

- ab7a88e: A run that lost its lease can no longer write into the conversation, lease times come from the database's clock, and storage adapters get a conformance suite.
  
  - **Fenced message writes.** `appendMessages(chatId, messages, fence?)` takes the turn's lease (`RunFence`: `{ runId, owner, fencingToken }`). A durable turn passes it on every step checkpoint and on its final message, and the write lands only while the run still holds that lease, checked in the same statement as the write. Before, only the run row was fenced: a worker that had lost its run (a long pause, a network blip) could keep writing messages into a chat another node was now running, for up to one lease TTL. A refused write persists nothing and returns `false`; the turn then stops as if its heartbeat had failed.
  - **One clock for leases.** The drizzle adapters set, renew and compare every lease time with the database's clock (`clock_timestamp()` on Postgres, `julianday('now')` on SQLite) instead of each app server's `Date.now()`. Clock skew between servers can no longer make one node reap a run another is still renewing. `reapExpiredRuns(now?)`: `now` is now optional and the runtime omits it; pass it only to simulate time in tests.
  - **`@intentface/latch-core/testing`.** `registerStorageConformance({ describe, it }, name, open)` checks an adapter against the guarantees the runtime relies on: tenant scoping, message ordering and upserts, one active run per chat, racing claims and reclaims, heartbeats, the reaper, and fenced message writes. Runner-agnostic (Vitest, Jest, `node:test`). The drizzle SQLite and Postgres adapters now run it in CI.
  
  **Upgrading:** nothing to do with the drizzle adapters. A host with its own `StorageAdapter` should honour `fence` in `appendMessages` (check the run's `leaseOwner` and `fencingToken` atomically with the write, return `false` when refused) and use one shared clock for lease times; an adapter that ignores `fence` keeps working as before. `reapExpiredRuns` may now be called without `now`. Run the conformance suite to check.

### Patch Changes

- @intentface/latch-net@0.14.0

## 0.13.3

### Patch Changes

- 4fe9ecd: Crash recovery resumes a run the way it started, and `runAgent` always says why a turn failed.
  
  - **Recovery keeps the turn's settings.** An unattended run (`runAgent`, cron, an autonomous delegation) records how it was asked to run on its row: `RunRecord.settings`, with `autoApprove`, `blockGated`, `memory` and `promptCaching`. `resume` / `sweep` now resume it the same way. Before, every recovered run resumed as an attended one. An unattended run then parked on a gate nobody would answer, memory off came back on, and an approval mode restored without its `blockGated` would have run a test run's gated tools for real; the two are saved and restored together. A run started on a per-turn **model override** is refused instead, settled `errored` with the model's id: the model object can't be stored, and finishing the run on the agent's own model would quietly change what answered. An attended chat turn records nothing. Recovery also resumes on the **agent version** the run started on (`RunRecord.agentVersion`, pinned as `name@7`), so a publish between the crash and the recovery doesn't change what finishes the turn. If a store can't resolve that pin, recovery falls back to the current version, as before.
  - **`runAgent` reports every failure as `error`.** A turn that fails while it is set up, such as a tool source that won't open, used to throw from `runAgent` and leave its run `active`, holding the chat until the lease lapsed. It's now settled `errored`, its reserved limits are released, and the error is returned. If settling fails too, the error says so. A failure that ends the run with no error chunk in the stream, such as a critical extension's last `step_end`, is read back from the run row. Admission refusals still throw, as before.
  - **drizzle:** `latch_runs.settings` (SQLite `TEXT`, Postgres `JSONB`), added by `migrate`.
  
  **Upgrading:** a host with its own `StorageAdapter` should store `settings` from `createRun` / `claimRun` / `openTurn` and return it on the run. Without that, recovery resumes with an attended turn's defaults, as it did before.
- @intentface/latch-net@0.13.3

## 0.13.2

### Patch Changes

- dfe9b90: A decision for an approval the agent already acted on is ignored. `applyApproval` now applies a decision only to a call that is still waiting (`approval-requested`), or that was decided but never continued (`approval-responded`, after a crash or a busy chat). That's the rule the AI SDK's own chat client applies before it sends one. A call with an outcome (`output-available`, `output-denied`, …), or a bubbled subagent approval already `resolved`, gets an empty `200` and nothing runs. Before, a double click that arrived after the first one finished, Slack re-sending a button press, or a second tab ran the model again and appended a repeat answer. The tool itself never ran twice; the SDK already skips a call that has a result.
- @intentface/latch-net@0.13.2

## 0.13.1

### Patch Changes

- 6fed7fa: Deciding a bubbled subagent approval now streams what the resume does, and a delegation paused on an approval ends the parent's turn.
  
  **Fix — a second gate in a resumed subagent reached storage but not the client.** `applyApproval` resumed the subagent, and when it stopped at another gated tool, appended the new `data-subagent-approval` part to the stored message and answered an empty `200`. A chat already showing the paused message never gained the card: the user saw their approval land, then nothing, while the run sat `awaiting_input` on a decision it never offered — until a reload, which showed a card looking just like the one already approved. The same held for channels rendering the response (Slack, Telegram).
  
  The response now streams, continuing the paused message: the subagent's progress while it resumes (the `data-subagent-progress` part `spawn_agent` writes, same id, updated in place), then the re-bubbled `data-subagent-approval` part (id = its `approvalId`, as stored) or the folded `spawn_agent` result as `tool-output-available`, then the parent's continuation once nothing is pending. Previously the resume ran silently before the response began, however long it took.
  
  **Fix — the parent could delegate again while waiting.** `spawn_agent` returns a result (`awaiting_approval`) where a gated call has none, so the tool loop continued and only the result's note kept the model from spawning again — each time adding another bubbled card, up to the step cap. The loop now stops after a step whose `spawn_agent` call paused, as it does at the agent's own gates. Added only for agents that can delegate.
  
  **Upgrading:**
  
  - **Errors during a subagent resume arrive in the stream.** A failure resuming the subagent (its chat busy, a model error) is an `error` chunk in a `200` stream rather than a thrown error, because the response has already started. The empty `200` for a step with several gated calls, some still undecided, is unchanged.
  - **A paused delegation ends the turn at that step.** A test model scripted to continue after `spawn_agent` returns `awaiting_approval` (narration in a further step) now sees its next call on the following turn.
- cf10a1c: A stale approval no longer runs the agent again. `applyApproval` with a decision for an approval the chat has moved past — an old tab, an old Slack card, a late retry after the user sent another message — used to record nothing (that approval was already declined by the next message) yet still continue the turn: the model ran again and an unasked-for answer was appended to the latest reply. Decisions now apply only to the chat's last message, the one a turn can be paused on; anything else is an empty `200` and nothing runs. A real retry — the decision saved but the turn never continued, after a crash or a busy chat — still finds its approval on the last message and continues.
  
  Still open: the same decision sent twice right away (a double click) looks exactly like that retry, and continues twice.
- @intentface/latch-net@0.13.1

## 0.13.0

### Minor Changes

- 71630e1: Parent-aware subagent resolution and connection tool listing.
  
  - core: `ChatRecord.parentAgent` records which agent spawned a sub-thread. `spawn_agent` sets it, and every resolve of that thread passes `{ parentAgent, autoApprove }` to `DynamicAgentStore.resolve(name, principal, ctx?)` — the first sub-turn, a continuation (`runAgent({ threadId })`, the chat surface), approval resumes (on the sub-thread or bubbled through the parent), client tool results, compaction, and crash recovery (`resume` / `sweep`). A host can shape a subagent per parent (e.g. which of a connector's tools a given agent may use) without the shaping lapsing on a later turn. Optional third argument; stores that ignore it behave as before.
  - drizzle: `latch_chats.parent_agent` column (SQLite + Postgres; idempotent ALTER in `migrate`).
  - mcp: `McpConnections.listTools(name, principal)` returns the caller's tool set for one connection with descriptions and annotations (`OpenMcp.toolInfos`, `McpToolInfo.description`) — optional on the interface, like `close`, so a hand-built registry need not offer it; `bearer({ header?, prefix? })` sends the token in a custom header (e.g. `X-API-Key`).
  
  **Upgrading:** a host with its own `StorageAdapter` should accept `parentAgent` in `createChat` and return it from `getChat`. Without that, the parent is known only on the turn that spawns the thread, and any later resolve of it sees none.
- 015e0a1: Safe-mode runs stop stubbing tools the agent explicitly waived, and gain three
  per-turn levers for measurement. Agent references can pin a version.
  
  **Fix — a waived tool is not a gated one.** `blockGated` decided what to stub
  with a truthiness check. The SDK spells a waiver as the string
  `"not-applicable"` — and the drizzle store writes exactly that for every tool
  an agent sets to `false` — so every tool an agent had explicitly waived was
  stubbed in every safe-mode run. On an agent whose reads are waived to override
  a connection default, that is every read tool: the agent could not reach its
  own corpus, and an evaluation graded a model with no access to its tools.
  `gatedBy` now treats only `true`, `"user-approval"`, an object or a function
  as a gate.
  
  **Upgrading — waived tools now run in safe-mode runs.** A tool whose approval
  the agent turned off (`false`, `"not-applicable"`) was stubbed in every
  `runAgent` test run; it now executes, exactly as it does in a normal turn.
  Gated tools are still stubbed. If a test run relied on a waived tool that
  writes never being called, gate that tool or keep the run out of production
  data.
  
  **`blockGated: "simulate-success"`** stubs gated tools with a success-shaped
  result instead of a "blocked" one. A blocked result makes the agent narrate
  the failure into its answer ("I couldn't record this internally"), which then
  lands in the text being graded.
  
  **`memory: false`** on `runAgent` disables recall and memory tools for one
  turn. A sweep over many inputs under one principal otherwise has row 1's
  memory in context by row 20 — the rows stop being independent observations.
  
  **`model`** on `runAgent` overrides the agent's model for one turn; the
  telemetry model id follows it.
  
  **`parseAgentRef` reads `name@7` and `name@draft`**, and `resolve()` honours
  the pin read-only. Measuring an old version must never make it live; without
  this the only way to run v3 was to publish it.
  
  Platform (unpublished): a local SQLite file now runs WAL with a 10s busy
  timeout. `busy_timeout = 0` made a second writer fail instantly rather than
  wait, and a durable runtime writes a checkpoint per step — four agents in
  parallel lost checkpoints, which is not a crash but a silently truncated
  transcript.

### Patch Changes

- 3b0dbfb: Provider web tools work on Claude Haiku. Anthropic's 20260209 web search and web fetch tools can be called from code execution, and Anthropic refuses them to a model without programmatic tool calling — every Haiku turn with `providerWebTools` failed with "does not support programmatic tool calling". Those models now get the direct-only versions (`webSearch_20250305`, `webFetch_20250910`); Opus and Sonnet from 4.6 and Claude 5 keep the newer ones.
  
  `runAgent` says why a turn failed: it returns `error` (the stream's error text — a provider refusal, a tool source that would not open) beside the usually empty `answer`, where a failed turn used to look like a silent one.
- 80f1630: `runAgent` takes optional `files` — sent with the prompt as file parts in the user message, the way chat sends attachments. Omitted, nothing changes.
- 96013b6: `memory: false` reaches delegated agents. A turn run with memory off (as evals run every input, so each is an independent observation) used to spawn subagents with memory back on: they recalled earlier inputs and could save new memory. `spawn_agent` now passes memory off down the tree, like it already does `blockGated`.
- @intentface/latch-net@0.13.0

## 0.12.0

### Minor Changes

- e602c55: `reconstructPrincipal` can now refuse a stored identity by returning `null`, and
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
    `errors` and the occurrence consumed (a recurring schedule stays live; a
    one-shot is spent, as before). Only `null` refuses; `undefined` does not.
  - `sweep` now isolates each resume: a run whose resume throws is logged and
    retried once its lease lapses, instead of aborting the loop and stranding
    every reaped run after it (the reaper marks the whole batch `errored`, and no
    later reap selects those rows again).
  - A refused resume fires no `onRunFinished`: its meta carries the principal,
    and there is none.
  
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

### Patch Changes

- @intentface/latch-net@0.12.0

## 0.11.0

### Patch Changes

- ae91f9c: MCP connections are address-guarded on every leg, and an unattended run no
  longer waives a connection's approval gates.
  
  Reported from a security review of a feature that lets any workspace member add
  an MCP server by URL — three problems a host application could not work around.
  
  **The OAuth legs had no address check at all.** An MCP server's
  protected-resource metadata *names* its authorization server, and Latch then
  fetched that server's metadata, registered a client with it, and posted to its
  token endpoint — following addresses the server operator chose, with no private-
  address check and with the SDK's errors (which quote the remote response body)
  reaching the member who added the connection. `McpOAuthConfig` had an
  `allowedAuthorizationServers` allowlist, but it failed open when unset *and* was
  never exposed on `oauth()`, so it could not be non-empty for any host.
  
  It is now exposed as `allowedAuthorizationServers` on `oauth()`, and **defaults
  to the MCP server's own origin**. A server that genuinely delegates to a
  separate IdP must declare it — the common case (a server that is its own
  authorization server) keeps working untouched. An empty array now allows
  nothing rather than everything.
  
  **The transport connected to an address nothing had vetted.** `host.open()`
  resolved a connection's hostname and rejected private ones, then handed the URL
  to `fetch`, which resolved it again: a name answering public to the check and
  private to the connect reached an internal service carrying the connection's
  credentials. Every connection now gets a fetch that vets inside the lookup its
  own socket uses (`createPinnedFetch`), used by the transport *and* by all OAuth
  legs, with redirects refused. A host-supplied `McpConnection.fetch` still wins —
  layer it over `createGuardedFetch` rather than over `globalThis.fetch`.
  
  `allowPrivateHost` relaxes both, per connection, so a trusted in-cluster server
  or a developer's `http://localhost:3999/mcp` is unaffected.
  
  `createMcpConnections` gains an optional `close()` that releases those fetches'
  keep-alive agents — a long-lived server never needs it; a test or short-lived
  process does.
  
  **Connection errors no longer quote the remote response.** The `authorize` and
  `test` routes returned `error.message`, which for OAuth failures embeds
  `Raw body: …`. They now return a stable code and at most an HTTP status; the
  full error goes to a new `onError` hook on the handler config.
  
  **An unattended run keeps source-contributed approval gates** (`latch-core`).
  `autoApprove` dropped the whole merged approval map, including the entries each
  opened connection contributed — which are not the agent's preference but the end
  user's choice about that connector. It now waives only the agent's own policy;
  a connection's or harness's gates survive and the turn parks instead. `blockGated`
  is unchanged and remains the opt-out, since it has already stubbed those tools.
  Scheduled fires were never affected: `runDue` has always used `autoApprove: false`.
- @intentface/latch-net@0.11.0

## 0.10.0

### Minor Changes

- c70daf1: Agent records are now versioned, so editing a prompt no longer destroys the one
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

### Patch Changes

- 65d1de5: A new seam: `extensions`, on `RuntimeConfig` (every turn) and `AgentConfig`
  (that agent's turns). An extension attaches handlers to the moments of a turn —
  `session_start`, `before_agent_start`, `input`, `register_tools`, `tool_call`, `tool_result`,
  `instructions`, `context`, `step_start`, `step_end`, `render`, `error`,
  `agent_end` — and returns effects; the runtime composes any number of them with
  one merge rule per moment. `defineExtension`, `compose`, `renderTranscript` and
  the moment types are exported.
  
  Omitted, nothing changes: with no extension attached a turn's provider requests,
  UI chunks and stored record are byte-identical to before, which a snapshot
  oracle now holds the runtime to.
  
  Two behaviours are new only when an extension uses them. A `step_end` handler
  runs before the next model call, so an extension that persists has written
  before the model is asked again; and a handler on an extension marked
  `critical` that throws fails the run (an ordinary one is reported and skipped).
- @intentface/latch-net@0.10.0

## 0.9.1

### Patch Changes

- 4b5e9eb: Two delegation paths had drifted from the rules the rest of the runtime applies.
  
  A test run (`runAgent` / `test_agent`: autonomous with gated tools stubbed) that
  delegated through `spawn_agent` handed the child only its approval mode, not
  the stub flag — so a "side-effect-free" trial could delegate to an agent whose
  gated tools ran for real. The child now inherits the parent's execution
  restrictions as a set.
  
  Resuming a subagent after a bubbled-up approval decision re-ran its model over
  history whose last message was the paused assistant turn, without trimming the
  trailing narration the other continuation paths (`applyApproval`,
  `applyToolResult`, crash recovery) already strip. Providers that refuse an
  assistant prefill rejected that request. The subagent resume now applies the
  same trim.
- 8311508: Publish to the public npm registry.
  
  Installing no longer needs an `.npmrc`, a registry mapping or a token:
  `pnpm add @intentface/latch-core` just works. Every tarball now ships the MIT
  license text, and each manifest carries `keywords`, `homepage` and `bugs`.
  
  No code or API changes. The versions previously published to GitHub Packages
  stay where they are; new releases go to npm only.
- 516d8f0: Per-step checkpoints (durability on) now commit in step order, and the finish
  handler's final write is the row's last write.
  
  Each checkpoint replaces the in-progress assistant message wholesale. They were
  fire-and-forget with nothing ordering them, so a slow early write could commit
  after a later one and roll the stored message back to an older step — a crash
  in that window re-ran a step that had already been persisted — and the final
  step's checkpoint raced the finish handler for the same row, where a late
  checkpoint clobbered the usage and cost metadata only the finish handler stamps.
  
  Checkpoints are now chained: each write starts the moment the one before it
  commits, and the finish handler awaits the chain before it settles the run row
  and persists the final message. Recovery never revisits a completed run, so a
  row that says `completed` now always sits next to a message that already holds
  the final step — previously the last checkpoint could still be in flight at
  that moment, and a crash there lost the answer text. The chain orders, it does not batch — a crash at step N still loses at
  most the write in flight and the one queued behind it. A failed checkpoint logs
  and releases the chain, as before.
- 8fd120a: Crash recovery no longer re-runs a turn that had already finished.
  
  Finishing the tool loop and recording that it finished are two separate writes:
  the per-step checkpoint lands at each step's end, while the run row becomes
  `completed` in the finish handler. A process that dies between them leaves a
  finished turn on an `active` row, so the reaper picks up a run whose answer is
  already in history.
  
  `resume()` now reads the tail of that history first. A last step that called no
  tool means the loop had stopped, so the row is reconciled (`completed`, or
  `awaiting_input` when a gate is pending) without a model call — previously the
  answer was generated a second time and, because the message id is reused,
  appended to the message that already held the first one. A turn waiting on a
  client-handled tool (`askUser`) is finished in the same sense: `onFinish`
  records it as completed and the answer arrives through `applyToolResult`, so
  recovery records the same instead of re-running and asking the question twice.
  
  When work genuinely remains, the resumed history now also passes through
  `trimTrailingAssistantPrefill`, which the two human-decision resume paths
  already did and crash recovery never did. Without it a tail ending in the
  turn's own half-written sentence reaches the model as an assistant prefill,
  which models that refuse one reject on the request *shape* — so every identical
  retry fails until `maxAttempts` is spent.
  
  `trimTrailingAssistantPrefill` also gains an `unanchored` option (default off,
  so the decision paths are unchanged) that trims a tail with no `tool-*` part to
  anchor on. Crash recovery passes it as a guard: the one anchorless tail a
  checkpoint can produce is a tool-free turn, which the classifier now settles
  before the trim is reached.
  
  Recovery also checks whether the chat moved on. Reaped runs are resumed one at a
  time, and while one waits its chat is free — so a later message can start, and
  even finish, a whole turn first. That is read off the runs table, never inferred
  from message shapes: a user message is only ever persisted together with its
  run, so a later run in the same chat is the one fact that proves a later turn
  exists. Such a run settles as errored with the same outcome `openTurn` gives a
  stale run, rather than being classified (or re-run) against a conversation that
  moved on. Compaction runs are summaries, not turns, and do not count.
  
  The runtime now also warns at startup when durability is enabled on a storage
  adapter without `openTurn`: turn creation is then two writes, and a crash between
  them is a shape recovery can only partly reason about. Every shipped adapter
  implements it.
  
  Also exports `resumeShapeOf` for hosts that drive recovery themselves.
- Updated dependencies [8311508]
  - @intentface/latch-net@0.9.1

## 0.9.0

### Minor Changes

- ebc0afd: One active run per chat, enforced in storage. `createRun` / `claimRun` throw
  `ChatBusyError` (code `chat_busy`, `retryAfterMs`) when the chat already has a
  live active run; the drizzle adapters back it with a partial unique index on
  `latch_runs (chat_id) WHERE status = 'active'` (both dialects; existing
  duplicates are marked `superseded` on migrate), and supersede an active run
  whose lease — or, for non-durable runs, a 10-minute stale window — has expired
  before opening the next, bumping its fencing token so the old worker's late
  writes are refused. `reclaimRun` returns null for a crashed run whose chat has
  since moved on. New optional `StorageAdapter.openTurn` opens the run and
  appends the user message in one transaction (the shipped adapters implement it;
  the SQLite adapter now uses real transactions on async drivers such as libsql),
  so a refused message leaves no trace and a crash can't leave a run without its
  message; the HTTP handler maps the refusal to 409 with
  `Retry-After`; the channel kernel renders it as "still working". Two tabs, a
  webhook retry racing a reply, or a schedule firing mid-conversation can no
  longer interleave one history — on every surface, not only in channels.
- d062dd2: One cron entry point and one non-streaming turn path.
  
  - `runtime.cron({ now?, maxAttempts? })` fires due schedules (`runDue`), then —
    with durability on — reaps lease-expired runs and resumes them (`sweep`).
    The phases are isolated: a failure in one lands in `errors` and the other
    still runs. Point every cron at this and nothing else. `tick()` is removed
    (it was `storage.reapExpiredRuns` behind a method); `runDue`, `sweep` and
    `resume` stay for callers that want the halves. `POST cron/run` on the
    handler now returns `cron()`'s result (`{ due, reaped, resumed, errors }`)
    instead of `runDue()`'s.
  - `runAgent`, `spawn_agent` and scheduled fires now share one internal
    `runToCompletion` path (previously three near-copies), so approval
    semantics, telemetry linkage and the "did it park?" verdict can't drift.
    Behaviour is unchanged; `runAgent`'s result shape is unchanged.
  - `runTurnStream` (the ephemeral, persist-nothing turn) is removed along with
    the `ephemeral` / `responseFormat: "text"` / `onComplete` branches inside the
    turn builder. Its only consumer was a smoke test. If you need a non-persisted
    turn, that belongs as an option on `handleChat`, not a second entry point.
  - Every tool's `options.context` now also carries `runtime` (the `Runtime`
    itself), so harness tools can schedule, list chats or spawn runs without a
    host-global.
- 8745142: Remove configuration the runtime never read. `RuntimeConfig.secrets` (the
  vault resolver belongs on `createMcpConnections`, and tools resolve secrets
  from `options.context.principal`), `RuntimeConfig.codeModeWrap` and
  `AgentConfig.codeMode` (never executed), `ContextDefinition.toolsContext`
  (the runtime already hands every tool `{ ...runtimeContext, principal, run,
  writer }` as `options.context`), and the deprecated `runtime` alias on the
  agent factory argument (use `context`). Agent-builder's `model` factory
  receives `{ context, principal }` instead of `{ runtime, principal }`.
  
  Drizzle: the unused message-persistence override is gone — the `messages`
  option on both `createSqliteAdapter` and `createPostgresAdapter`, and the
  `MessageStore` type export from the package barrel.
- cbbd775: `@intentface/latch-core/models`: the model side of a host, so no host
  hand-writes it. `loadModelCatalog()` (models.dev-backed: ids, labels, pricing
  incl. the long-context tier, reasoning capability, max output; filtered to
  providers whose SDK is installed and API key is set; static fallback offline),
  `providerOf(modelId)` (one id → provider heuristic, catalog first), and
  `providerDefaults(catalog)` — the `pricing` / `resolveProviderTools` /
  `resolveReasoningOptions` / `resolvePromptCaching` hooks to spread into
  `createRuntime`. The provider SDKs (`@ai-sdk/anthropic`, `@ai-sdk/openai`,
  `@ai-sdk/google`) become OPTIONAL peer dependencies of core, imported lazily per
  provider only when usable — the core root still imports none of them. Lifted
  from latch-platform's `models.ts` / `reasoning.ts` / `provider-tools.ts` /
  `prompt-caching.ts`, which duplicated the provider-prefix inference three times.
- 78a40e3: One observation seam, and a callback that always identifies itself.
  
  - `RuntimeConfig.observability` (`onStep` / `onFinish` / `onError`) is folded
    into `LatchTelemetry`: `TelemetryRunMeta` gains `trigger` (what started the
    turn — `chat` / `decision` / `programmatic` / `schedule` / `resume`), and
    `LatchTelemetry` gains an optional `onStep(run, step)`. `onRunFinished`
    already covered `onFinish` and `onError` (status `"errored"` + the message).
    The two seams fired near-identical payloads at the same points; hosts now
    wire one object, and a tracer and plain callbacks compose instead of living
    in parallel. `TurnTrigger` moved to `telemetry.ts` (still exported from the
    package root).
  - Handler: `stateParams` and the legacy no-pin callback fallback are removed,
    and `resolveContext` loses its `extra` argument. Every flow the handler
    starts pins the resolved principal into the state; a callback without a pin
    is now rejected as `flow_expired` instead of asking the live session to
    stand in — the exact failure that once stored an org's tokens under a
    personal owner.
  - Fix: a turn whose model stream errored used to be settled as `completed`
    (the SDK still runs `onFinish` after `onError`) and reported to telemetry
    three times (`errored`, `errored`, `completed`). The first error now wins:
    one `errored` report, and the run row says `errored` with the message.
- 7d3c553: The last two pieces every host used to hand-write.
  
  - `@intentface/latch-core/harness`: the default harness tools — sandbox
    `bash`/`read_file`/`write_file`/`glob`/`grep` over the `sandbox` seam,
    `web_fetch` (clean markdown/text, images and PDFs as viewable media,
    SSRF-gated and DNS-pinned), `askUser` (client-handled pause), and
    `list_schedules`/`cancel_schedule` over `options.context.runtime`. Pass
    `harnessTools: defaultHarnessTools()`. `web_fetch`'s `turndown` and
    `@intentface/latch-net` are OPTIONAL peers of core, imported on first call.
    Lifted from latch-platform's sandbox/tools.ts + web-fetch.ts; the platform
    keeps only its policy (render_fetch, delivery-aware create_schedule, Slack
    tools).
  - `createLatchApp({ storage, agents, resolveContext })` in latch-server (and
    `createLatchHonoApp` on the hono subpath): the composition root with the
    defaults wired — durability on, croner cron evaluator, the models.dev
    catalog with pricing / reasoning / web-tool / prompt-caching hooks, the
    harness tools, the handler mounted, and an in-process `runtime.cron()`
    driver on long-running hosts (off on serverless). `agents` may be a
    function of the loaded catalog. Every default is overridable via
    `runtime` / `handler`. The example server is now ~30 lines of wiring.
- b22b3cf: Limits — per org / user / agent budgets on turns, tokens and cost.
  `createRuntime({ limits })` takes a `LatchLimits` seam: `limitsFor({ principal,
  agent, trigger })` names the counters a turn counts against and their caps
  (fixed, epoch-aligned windows), and a `LimitStore` holds the counters. The
  runtime refuses at admission with `LimitExceededError` (stable code
  `limit_exceeded`, `retryAfterMs`; the HTTP handler maps it to 429 with
  `Retry-After`), stops the tool loop once this turn's tokens reach the tightest
  remaining token budget, and settles tokens + cost on finish — resumes and
  subagent turns included. `runtime.cron()` prunes dead windows.
  `@intentface/latch-drizzle` adds `latch_limit_counters` (both dialects) and
  `createSqliteLimitStore` / `createPostgresLimitStore`.

### Patch Changes

- @intentface/latch-net@0.9.0

## 0.8.1

### Patch Changes

- e0e2000: Resuming an approved turn no longer dies on providers that reject assistant prefill. `trimTrailingAssistantPrefill` anchored on the last tool-ish part of the paused assistant message — but it accepted a bubbled `data-subagent-approval` marker as that anchor, and `data-*` parts are stripped before the model sees anything, so the narration the model streamed around the pause ("Once approved, it'll be…") stayed as the projection's last visible content. Providers without prefill support refuse that conversation, so clicking Approve in the agent builder produced an error instead of a continuation — intermittently, since it needed the model to have narrated before pausing.
  
  The trim now anchors only on parts the model projection keeps (`tool-*` / `dynamic-tool`), drops trailing `text`/`reasoning`/`step-start` (`step-start` included: it opens a new assistant message in conversion, which — with the text gone — would be empty, trading the prefill rejection for an empty-content one), and keeps the `data-*` approval markers, which the resumed turn re-persists and the UI and `hasPendingApproval` depend on.

## 0.8.0

### Minor Changes

- c5a64fd: Prompt caching is now ON by default for first-party Anthropic and OpenAI models. With no `resolvePromptCaching` hook, the plan is derived from the model object's own `provider` string (`defaultPromptCachingPlan`) — measured at ~6× unit cost on MCP-heavy agents, which is not a default a host should have to discover by reading source. Conservative on purpose: only first-party provider ids match (Bedrock/Vertex untouched, since the Anthropic plan's request-level `cache_control` is first-party only). Opt out with `resolvePromptCaching: () => undefined`, or per turn with `promptCaching: false`. Hosts that already supply the hook are unchanged.
  
  Agent factories now receive the runtime context as `context` (preferred) alongside the deprecated `runtime` alias — two different things named "runtime" made every example ambiguous, including the docs example that didn't compile. Existing factories destructuring `runtime` keep working.
  
  Note for the rare code that INVOKES a factory directly (tests, custom hosts): the ctx argument now requires both `context` and `runtime` (same value). Keeping both required protects the many factory *authors* — making `runtime` optional would type their destructured `runtime` as possibly-undefined — at the cost of the few direct callers, who pass the value twice.

## 0.7.0

### Minor Changes

- fcef9d2: The mounted HTTP surface catches up with the runtime, and an unattended fire that parks is now reported.
  
  - `POST /schedules` forwards `delivery` and `onParked` (both were silently dropped, which made the whole `runSchedule` delivery seam unreachable through the handler); an unknown `onParked` is a 400 rather than a silent default.
  - New `GET /schedules/:id` (owner-scoped, 404 for anything not in the caller's own list) and `POST /schedules/:id/run-now`, which arms the schedule for the next tick so "run now" goes through the ordinary `runDue` path instead of drifting from it.
  - `GET /runs` no longer returns each run's `identity` — the serialized principal is durable server state and a customer type the docs invite you to extend, so it never enters a browser payload. Read it server-side via `runtime.listRuns`.
  - `runDue` returns a new `parked` count: fires that ran and then stopped waiting on a human (tokens spent, no answer delivered), logged on the tick it happens. Counted in `fired` too — the turn did run. This matters most for a one-shot schedule, which has no later occurrence for `onParked` to skip.
  - Docs: the callback route's "resume a waiting chat" comment was wrong (it redirects; resuming is the client's job) — corrected, and the client continuation protocol is now documented in the server README.
- fcef9d2: Observability events now carry `trigger` — what started the turn, and so whether anyone is watching it: `"chat"` (a user message), `"decision"` (a human answered an approval or a client-handled tool), `"programmatic"` (a direct `runAgent` call — no client stream, so `runAgent` takes a `trigger` for hosts that know a person is waiting), `"schedule"` (a cron/one-shot fire), `"resume"` (the durability sweep recovering a crashed run). A subagent turn inherits its parent's trigger, like `rootChatId`.
  
  This is what makes `observability.onFinish` usable as an operational notification channel rather than only an analytics feed: it already carries `principal`, `chatId`, `runId`, `agent`, `status` and `cost`, but `status: "awaiting_input"` was indistinguishable between a scheduled fire nobody can answer and a gate rendering in front of a live user. Now `status === "awaiting_input" && (trigger === "schedule" || trigger === "resume")` is exactly "go tell this turn's owner". Documented in the Observability and Schedules seams, with a push example — no new seam, and no second overlapping way to learn the same fact.
  
  Relatedly, `runSchedule` may now return `{ handled, chatId?, parked? }` instead of a bare boolean. A host that takes over delivery owns the chat its fire ran in, so only it can report that chat (which the next occurrence's `onParked` check reads) and whether the fire parked (which joins `runDue`'s `parked` count). A bare `true`/`false` behaves exactly as before.

## 0.6.0

### Minor Changes

- 3721c48: `listChats` now projects each chat's latest run status as `ChatRecord.lastRunStatus`, derived at read time by one correlated, index-backed subquery in the drizzle adapters (never stored). Lets a list UI flag chats parked on a human (`awaiting_input` — a pending approval or question) without loading messages or scanning runs per chat. Because only the latest run counts, the flag self-heals: a continuation opens a new run, so a superseded pause stops showing the moment the conversation moves on. Optional field — custom adapters that don't populate it keep working unchanged.
- 8b9e1c8: Schedules get a parked-predecessor policy. When a scheduled fire's previous chat is still waiting on a human (an undecided approval or question), firing again just mints another parked chat and pays for the tokens up to the gate — on every tick, forever. `runDue` now checks the last fire's chat (the message-log fold, same predicates the interactive paths trust) and, under the default `onParked: "skip"`, consumes the occurrence without running; `onParked: "fire"` opts a schedule back into the old always-fire behavior. `runDue` returns a new `skipped` counter so quiet ticks stay legible. Storage: `ScheduleRecord.onParked` + `lastChatId`, and an OPTIONAL `noteScheduleFire` adapter method (drizzle implements it on both dialects with idempotent column migrations; custom adapters that skip it keep the old behavior).

## 0.5.0

## 0.4.1

## 0.4.0

## 0.3.1

## 0.3.0

### Minor Changes

- ddfa57b: `runtime.getChat({ principal, id })` — one chat by id, scoped to the caller.
  
  A direct lookup backed by `storage.getChat`, so "does this chat exist, and whose agent is it?"
  stays correct for a tenant with any number of chats. Previously the only read was `listChats`,
  which is a capped scan: anything past the limit is invisible, which silently breaks id-based
  questions for busy tenants.

## 0.2.0

### Patch Changes

- 194c789: Scheduled occurrences are now consumed before firing, and durability failures are no longer silent.
  
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
- c782ec9: Non-`Error` throws and empty-message errors are described instead of masked.
  
  `clientErrorMessage` already forwarded real `Error` messages, but a non-`Error` throw (a raw
  HTTP body, a JSON-RPC error object, a plain string) or an `Error` with an empty message
  collapsed to the bare "An error occurred." — which turned an MCP server's
  `404 {"error":"Session not found"}` into an undebuggable generic string in the chat. Such
  values are now serialized (bounded at 300 chars, cycle-safe) into the client-visible error
  text; named error classes with empty messages report their name.

## 0.1.0

### Minor Changes

- 166c7a8: Prompt caching: a provider-generic plan the host resolves per model, applied in `buildTurn`.
  
  `createRuntime` gains an optional `resolvePromptCaching(modelId, { agent })` hook. Return a
  `PromptCachingPlan` — build one with `promptCachingPlanFor(provider, …)` — and the turn sets
  the provider options that keep the stable prompt prefix cached instead of re-billed on every
  step of the tool loop. Hosts that don't pass the hook are unaffected.
  
  For Anthropic that means three of the four available `cache_control` breakpoints: the last
  function tool definition (so the tool prefix survives a system-block change), the system
  message holding the agent instructions, and a rolling request-level marker. The date line
  moves into a separate unmarked system message, so the daily flip no longer invalidates the
  system breakpoint at midnight UTC. For OpenAI it sets `promptCacheKey` for shard routing.
  
  New exports from `@intentface/latch-core`: `promptCachingPlanFor`, `mergeProviderOptions`,
  `toolsetHash`, `markLastFunctionTool`, and the `PromptCachingPlan` type.
  
  `RunRecord` gains optional `kind` and `toolsHash`; `UsageRecord` gains optional
  `cacheReadTokens` and `cacheWriteTokens`; `createRun` accepts an optional `kind`. All
  additive — existing `StorageAdapter` implementations keep compiling, but they will not
  record the new fields until they store them.

## 0.0.1

### Patch Changes

- 9dd4f7a: First release. Publishes the `@intentface/latch-*` scope to GitHub Packages: the
  runtime and seams (`latch-core`), storage (`latch-drizzle`), the mountable HTTP
  surface (`latch-server`), tool sources (`latch-mcp`, `latch-openapi`), memory,
  channels, the agent-builder store, tracing, and the SSRF helpers.
