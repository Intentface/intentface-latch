# Subagent HITL — approval propagation across the agent hierarchy

## Problem

A subagent (`spawn_agent` → `runSubagent`) runs in its own `sub_…` thread with
`autoApprove: true` — its gated tools execute without human approval. That's
correct for *autonomous* runs (cron / `runAgent`, no human), but wrong for a
subagent spawned from an *interactive* chat: a mutating tool (e.g. a CRM write)
should pause and ask the user, exactly as it would at the top level.

This is the mainstream default (Claude Code, OpenAI Agents SDK, LangGraph):
approval is uniform across the hierarchy — a gated call **anywhere** suspends the
run and bubbles up to the human, then resumes.

## Design

Reuse Latch's existing approval machinery (approval-requested part → run
`awaiting_input` → `applyApproval` → resume from history) and add **thread
routing** so a child's pending approval surfaces on the parent turn.

### 1. Subagents inherit the parent's approval mode

`spawn_agent` propagates the parent turn's `autoApprove` into `runSubagent`
instead of hardcoding `true`. Interactive top-level (`autoApprove=false`) → the
subagent **gates** its tools; autonomous top-level → subagent still auto-approves.

### 2. A paused subagent returns a pending signal

`runSubagent` drains the sub-turn; if the sub thread ends `awaiting_input`
(`hasPendingApproval`), it returns
`{ threadId, pending: [{ approvalId, toolName, summary }] }` instead of
`{ threadId, answer }`.

### 3. `spawn_agent` surfaces the sub-approval on the parent turn

On a `pending` result, `spawn_agent`'s `execute` writes a
**`data-subagent-approval` data part** into the parent stream (via the turn
`writer`) with `data: { approvalId, subChatId, subApprovalIds, spawnToolCallId,
summaries }` (`subApprovalIds`/`summaries` are arrays — one entry per gated sub
tool), and returns a short "awaiting approval" tool result. The parent turn
finishes with a pending approval → `awaiting_input` (existing behavior). The
user sees the summaries. `pendingApprovals` and `applyApproval` key off
`type === "data-subagent-approval"` and `data.approvalId`.

The parent's tool loop **stops** after a step in which `spawn_agent` returned
`awaiting_approval`, as it does at one of its own gated calls. A gated call has
no result, so the SDK stops there by itself; `spawn_agent` *returns* one, and
without the stop the model was left to obey the result's "stop here" note — a
model that didn't delegated again, one more bubbled card per step, up to the
step cap. (Added only for agents that can delegate.)

### 4. `applyApproval` routes a sub-approval to the child, then resumes the parent

When `applyApproval(parentChat, decisions)` sees a `data-subagent-approval`
part whose `data.approvalId` matches the decision:
1. apply the decision to the **sub thread's** approval parts (`subApprovalIds`);
2. resume the **sub turn** (`buildTurn` on the sub thread from history) → the
   approved tool executes → sub completes → digest;
3. record the sub's answer as the `spawn_agent` tool **result** in the parent
   thread, mark the parent approval part responded;
4. resume the **parent turn** from history → it continues with the digest.

Denial: step 1 records `approved:false`; the sub tool returns a denied result;
the sub completes with a "not performed" digest; parent continues.

### 5. The decision's response carries the whole resume

The `applyApproval` response is the only channel back to a client already
showing the paused message, so everything the routing does is **streamed**
there, continuing that message, in order:

| Chunk | When |
|---|---|
| `data-subagent-progress` (id `subagent_<spawnToolCallId>`) | while the sub runs — the same part `spawn_agent` streamed, updated in place |
| `data-subagent-approval` (id = its `approvalId`) | the resumed sub paused on **another** gated tool — a fresh card |
| `tool-output-available` for the `spawn_agent` call | the folded result: the digest, or `awaiting_approval` again |
| the parent's continuation (`start` … `finish`) | only once nothing is pending |

When the sub pauses again, the stream ends after the new card and the chat stays
`awaiting_input`; the next decision routes through here again, so bubbling
recurses one round per decision. Until 0.14 that case answered an empty `200`:
the new card reached storage but not the client, which showed the approval
landing and then nothing — while the run waited on a decision it never offered.

A host renders these like any other parts; nothing subagent-specific is needed
beyond what `spawn_agent`'s own stream already requires. A failure during the
resume (the sub chat busy, a model error) arrives as an `error` chunk in that
stream rather than as a thrown error, because the response has already started.
The empty `200` remains for one case only: a step with several gated calls,
some still undecided — the client already holds those cards.

### Invariants preserved
- **Isolation:** raw sub-tool output stays in the `sub_…` thread; the parent
  only ever sees the digest + the approval summary.
- **Durability:** approvals are message-state (persisted), not in-memory — the
  pause survives a process restart, unlike an in-memory token store.
- **Recursion:** propagation composes down `depth` (a sub-subagent's approval
  bubbles up two levels via the same mechanism).

### Scope of change (core `runtime.ts`)
- `spawn_agent` execute: propagate `autoApprove`; on `pending`, write the tagged
  approval-requested part.
- `runSubagent`: accept `autoApprove`; detect `hasPendingApproval`; return pending.
- `applyApproval`: branch on `subChatId`-tagged approvals → sub-resume → parent-resume,
  streamed (§5).
- `buildTurn`'s tool loop: stop on a paused delegation (§3).
- Helpers: tag/detect the sub-approval metadata on the part.

### Test
`apps/example/src/subagent-approval.smoke.ts`: interactive agent → `spawn_agent`
a subagent whose tool is gated → assert the PARENT run is `awaiting_input` with
the sub summary; `applyApproval(approve)` → sub write executes → parent completes
with the digest; a second run with `deny` → write not performed.

`packages/core/src/subagent-approval-delivery.test.ts` pins what the client
receives: the re-bubbled card, the resume's progress, the folded result before
the parent's continuation, and the parent stopping at a paused delegation.
