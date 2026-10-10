---
"@intentface/latch-core": minor
---

A `runSchedule` hook that throws, or returns something other than `true`, `false` or `{ handled }` (say `undefined`, from a hook that forgot to return), now ends that occurrence as an error (`runDue`'s `errors`) and nothing else runs. Before, a throw fell through to the default run in a new chat, so a hook that had already run the agent and then failed (on delivery, say) paid for the same occurrence twice. To decline, return `false` before doing any work, as before; once delivered, return `true` even if a later step fails.
