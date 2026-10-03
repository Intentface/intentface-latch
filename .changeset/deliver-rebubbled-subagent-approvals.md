---
"@intentface/latch-core": patch
---

Deciding a bubbled subagent approval now streams what the resume does, and a delegation paused on an approval ends the parent's turn.

**Fix — a second gate in a resumed subagent reached storage but not the client.** `applyApproval` resumed the subagent, and when it stopped at another gated tool, appended the new `data-subagent-approval` part to the stored message and answered an empty `200`. A chat already showing the paused message never gained the card: the user saw their approval land, then nothing, while the run sat `awaiting_input` on a decision it never offered — until a reload, which showed a card looking just like the one already approved. The same held for channels rendering the response (Slack, Telegram).

The response now streams, continuing the paused message: the subagent's progress while it resumes (the `data-subagent-progress` part `spawn_agent` writes, same id, updated in place), then the re-bubbled `data-subagent-approval` part (id = its `approvalId`, as stored) or the folded `spawn_agent` result as `tool-output-available`, then the parent's continuation once nothing is pending. Previously the resume ran silently before the response began, however long it took.

**Fix — the parent could delegate again while waiting.** `spawn_agent` returns a result (`awaiting_approval`) where a gated call has none, so the tool loop continued and only the result's note kept the model from spawning again — each time adding another bubbled card, up to the step cap. The loop now stops after a step whose `spawn_agent` call paused, as it does at the agent's own gates. Added only for agents that can delegate.

**Upgrading:**

- **Errors during a subagent resume arrive in the stream.** A failure resuming the subagent (its chat busy, a model error) is an `error` chunk in a `200` stream rather than a thrown error, because the response has already started. The empty `200` for a step with several gated calls, some still undecided, is unchanged.
- **A paused delegation ends the turn at that step.** A test model scripted to continue after `spawn_agent` returns `awaiting_approval` (narration in a further step) now sees its next call on the following turn.
