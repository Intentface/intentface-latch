---
"@intentface/latch-core": patch
"@intentface/latch-script": patch
"@intentface/latch-agent-builder": patch
"@intentface/latch-drizzle": patch
---

Agent extensions: scripts that run BEFORE the model, rendered into the prompt.

An agent may declare `extensions`: a script over its tools plus a Liquid
template, triggered by a `/slash` invocation (`on: "slash"`, the user types
`/report week`), once per conversation (`on: "chat-start"`, refreshable), or
before every message (`on: "every-turn"`). The result lands in the user turn
or, with `target: "instructions"`, in the system prompt after the cache
breakpoint (`scope: "chat"` keeps it for the whole conversation). Media the
script returns under `files` becomes file parts the model reads natively.

**What is persisted is what the model read.** The script's result is written as
a `data-extension` part on the triggering user message before the model is
called; `toModelMessages` renders that part and `toClientMessages` redacts it
per the extension's `reveal` (`command` — only the typed text, `prompt`,
`both`). A crash-resume replays the identical prompt without re-running
anything, and the user's own text is never rewritten. `AppMetadata.extension`
lets a client invoke a slash extension structurally.

The engine is a seam: `RuntimeConfig.scripts?: ScriptEngine`, implemented by
the new `@intentface/latch-script` (callscript + LiquidJS). Scripts are a
JavaScript subset parsed into an inert plan — no sandbox; loops, `new`,
globals and prototype access are validation errors — and are **read-only by
default**: a call to an approval-gated tool is refused at analysis time unless
the extension sets `allowMutations`, because a script call bypasses the SDK's
approval gate. `onError: "proceed" | "fail"` (default proceed: the model is
told the extension failed and continues). Without a `scripts` engine the
declaration is ignored, like `memory` without a provider.

New runtime facade methods: `previewExtension` (run a saved extension or an
inline draft over an agent's tools, no model call, nothing persisted) and
`listExtensions` (names/descriptions/triggers, never scripts).

`@intentface/latch-agent-builder`: `AgentExtensionSchema` and `extensions` on
the agent record (slash names may not shadow the channel commands `new reset
compact cancel skip status help commands start`; duplicates rejected); the
builder offers extensions when the host declares
`capabilities.extensions`, with a `test_extension` tool for drafts.

`@intentface/latch-drizzle`: `latch_agents.extensions` JSON column, added
idempotently on both dialects and carried into `AgentConfig.extensions`.
