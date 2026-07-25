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
- `applyApproval`: branch on `subChatId`-tagged approvals → sub-resume → parent-resume.
- Helpers: tag/detect the sub-approval metadata on the part.

### Test
`apps/example/src/subagent-approval.smoke.ts`: interactive agent → `spawn_agent`
a subagent whose tool is gated → assert the PARENT run is `awaiting_input` with
the sub summary; `applyApproval(approve)` → sub write executes → parent completes
with the digest; a second run with `deny` → write not performed.
