---
"@intentface/latch-channels": minor
---

Slack: `resumeApproval` — continue a thread after a connection's OAuth completes in the browser.

The sign-in card a Slack thread renders for an unauthorized connection sends the user to a
browser OAuth flow; until now nothing brought the result back, so the parked `connect_<name>`
approval never resolved and the conversation dead-ended. `slackChannel(...)` now also returns
`resumeApproval({ chatId, approvalId, userId, tenant? })`: it approves the parked connect
approval and renders the resumed run into the thread.

Deliberately restricted to CONNECT approvals, verified against fresh history — unlike the
Approve/Deny buttons (whose payloads arrive Slack-signed), this entry point is reached from a
browser redirect, so an approvalId alone must not be able to approve an arbitrary gated tool.
