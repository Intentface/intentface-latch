---
"@intentface/latch-drizzle": patch
"@intentface/latch-server": patch
---

Drop the AI SDK beta pin: both packages now declare `ai` as `>=7.0.0`, matching
every other package in the repo.

`latch-drizzle` and `latch-server` still declared `ai: ">=7.0.0-beta.178"` and
dev-installed that exact beta, so a workspace install resolved two copies of
`ai` — a beta for these two and a release for everyone else. Two copies in one
process means two sets of error classes, so an `instanceof AISDKError` check
across the boundary silently fails.

No source change: the published code is byte-identical. Only the declared floor
moves, from a prerelease nobody should still be on to the release line.
