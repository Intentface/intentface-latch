---
"@intentface/latch-core": minor
---

Tool guards: `RuntimeConfig.toolGuards` is a list of deterministic, code-level
policies evaluated on every tool call of every turn — before the approval
policy, and on autonomous/subagent turns too. A guard returns `{ allow: true }`
or `{ allow: false, reason }`; a denial is installed as the AI SDK's `denied`
approval status, so the call never executes, never shows an approval card, and
the reason returns to the model as a tool result. Guards AND-compose (first
deny wins) and receive the delegation tree's `rootChatId`, so a channel-scoped
guard holds inside spawned subagents. With guards installed the wrapper takes
over the SDK's per-tool lookup: per-tool approval functions in the merged object
policy and a tool's own `needsApproval` keep working exactly as before.
