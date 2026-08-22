---
"@intentface/latch-channels": patch
---

Slack manifests now fit the create-app wizard's real description limit.

The manifest reference documents 140 characters for `display_information.description`, but the
"create from manifest" wizard enforces the app-listing limit of 100 — a longer description is
rejected as "too long", and on the review page the confirm button just stays disabled with no
visible error. Generated manifests now trim the description to 100 characters at a word boundary.
