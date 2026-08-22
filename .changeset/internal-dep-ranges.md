---
"@intentface/latch-agent-builder": patch
"@intentface/latch-channels": patch
"@intentface/latch-drizzle": patch
"@intentface/latch-langfuse": patch
"@intentface/latch-mcp": patch
"@intentface/latch-memory": patch
"@intentface/latch-openapi": patch
"@intentface/latch-server": patch
---

Publish internal `@intentface/latch-*` dependencies as caret ranges instead of exact pins.

These packages previously declared each other at an exact version, so installing two of
them at different patch levels put a second copy of the shared package in `node_modules` —
its own module registry, its own `instanceof` identities, and no error to say so. They now
declare `^<version>`, which dedupes against the range in your own `package.json`.

Nothing to do on your side beyond installing; a fresh install collapses any duplicate that
an earlier version produced.
