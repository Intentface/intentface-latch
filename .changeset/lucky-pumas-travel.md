---
"@intentface/latch-agent-builder": patch
"@intentface/latch-channels": patch
"@intentface/latch-core": patch
"@intentface/latch-drizzle": patch
"@intentface/latch-langfuse": patch
"@intentface/latch-mcp": patch
"@intentface/latch-memory": patch
"@intentface/latch-net": patch
"@intentface/latch-openapi": patch
"@intentface/latch-server": patch
---

Publish to the public npm registry.

Installing no longer needs an `.npmrc`, a registry mapping or a token:
`pnpm add @intentface/latch-core` just works. Every tarball now ships the MIT
license text, and each manifest carries `keywords`, `homepage` and `bugs`.

No code or API changes. The versions previously published to GitHub Packages
stay where they are; new releases go to npm only.
