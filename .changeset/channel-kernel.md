---
"@intentface/latch-channels": minor
---

One turn kernel for direct-message surfaces. `createTurnKernel(config, surface)`
(package root) now owns what Telegram and WhatsApp each re-implemented: dedupe,
the identity gate with stash + post-link replay, thread epochs, the `/new`
`/compact` `/cancel` `/status` `/help` commands, questionnaires, the
one-turn-per-chat lease (`withTurnLease`), media folding, rendering the answer,
approvals and button taps. Telegram and WhatsApp are now a webhook parser plus a
`Surface` each; a new DM platform is the same two pieces. WhatsApp gains the full
command set and (with a `thread` store) `/new`; its approval taps are verified
against fresh history like Telegram's.

**Telegram posts once at finish.** Progressive `editMessageText` streaming is
gone (never edit-to-mimic): the answer arrives as one HTML message (plain on an
entity-parse failure), split past 4000 chars, with "typing…" refreshed while the
turn runs. Removed: `renderTelegramStream`, `TelegramStreamOptions/Result`,
`MAX_TELEGRAM_TEXT_CHARS`, `TELEGRAM_TEXT_TRUNCATION_NOTICE`. Link notices use
an inline URL button instead of an anchor in the text.

**Slack sheds its unused seams.** The multi-tenant `resolve()`/`SlackTenant`/
`SlackPeek` seam is removed — `principal`, `botToken`, `runtime`, `botUserId`
and `teamId` are required; `runMessage`/`resumeApproval` lose `tenant`.
`feedback`/`onFeedback`/`feedbackActions`/`FEEDBACK_ACTION` and
`suggestedPrompts` (app_home_opened) are removed, as are the unused client
methods `sessionsRename`, `setSuggestedPrompts`, `conversationsInfo`, `authTest`.
`authorizeUser` returns the shared `AuthResult<P>`.

Also removed: `TelegramAuthResult`, `WhatsappAuthResult` (use `AuthResult`).
`splitWhatsappText` stays as an alias of the kernel's `splitText`.
