---
"@intentface/latch-core": minor
---

`useChat`'s own approval flow works with Latch. After `addToolApprovalResponse`, with `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`, `useChat` sends the paused assistant message back to the chat route; `handleChat` now reads only the decisions from it and continues the run exactly as `applyApproval` does, streaming the answer into the same message. Nothing else in the client's copy is stored or used: a tool runs with the input the agent asked for. Several cards in one step work the same way, and answers sent twice are ignored. `applyApproval` and the approvals route still take decisions from anywhere else (Slack, another device).
