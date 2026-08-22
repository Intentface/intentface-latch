---
"@intentface/latch-channels": minor
---

Slack: `authorizeUser` is now a resolver — per-message principals, so each member acts with their own credentials.

`authorizeUser` may return `principal` alongside `allowed: true`; that message's turn (and its
history reads, approval resumes, and rendered follow-ups) runs as that principal instead of the
tenant's. This is how a shared channel bot stops running everyone through the installer's
credentials — a data-exposure problem, not just an attribution one. The principal is opaque to
the channel; the host decides how it encodes "shared thread, per-user credentials".

Approve/Deny interactions are now gated and resolved the same way: the resume re-runs the agent
with tool access, so the CLICKER must pass `authorizeUser` (an unlinked bystander can no longer
approve gated tools), and the resumed turn runs as the clicker. `resumeApproval` accepts an
optional `principal` for the same reason.

Hosts whose `authorizeUser` returns no principal keep the previous behavior exactly.
