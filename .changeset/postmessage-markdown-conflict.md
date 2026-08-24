---
"@intentface/latch-channels": patch
---

Document that `chat.postMessage`'s `markdown_text` is exclusive with
`text`/`blocks` (`markdown_text_conflict`) — combining them fails every call.
