---
"@intentface/latch-core": patch
---

A stale approval no longer runs the agent again. `applyApproval` with a decision for an approval the chat has moved past — an old tab, an old Slack card, a late retry after the user sent another message — used to record nothing (that approval was already declined by the next message) yet still continue the turn: the model ran again and an unasked-for answer was appended to the latest reply. Decisions now apply only to the chat's last message, the one a turn can be paused on; anything else is an empty `200` and nothing runs. A real retry — the decision saved but the turn never continued, after a crash or a busy chat — still finds its approval on the last message and continues.

Still open: the same decision sent twice right away (a double click) looks exactly like that retry, and continues twice.
