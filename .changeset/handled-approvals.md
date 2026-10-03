---
"@intentface/latch-core": patch
---

A decision for an approval the agent already acted on is ignored. `applyApproval` now applies a decision only to a call that is still waiting (`approval-requested`), or that was decided but never continued (`approval-responded`, after a crash or a busy chat). That's the rule the AI SDK's own chat client applies before it sends one. A call with an outcome (`output-available`, `output-denied`, …), or a bubbled subagent approval already `resolved`, gets an empty `200` and nothing runs. Before, a double click that arrived after the first one finished, Slack re-sending a button press, or a second tab ran the model again and appended a repeat answer. The tool itself never ran twice; the SDK already skips a call that has a result.
