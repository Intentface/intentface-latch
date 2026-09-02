---
"@intentface/latch-channels": minor
---

One turn per chat is core's storage invariant now (`ChatBusyError`, since
latch-core 0.9), so the channels stop asking hosts to guard it: Slack's
`claimTurn` / `releaseTurn` are optional (the kernel's already were), and a
busy refusal from core renders as the same quiet notice the lease produced —
in DM surfaces, Slack messages, approval clicks and connect resumes. Hosts on
the shipped storage adapters can drop their turn-lease table; a host on an
adapter without the invariant may still wire `claimTurn`.
