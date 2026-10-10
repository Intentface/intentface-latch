---
"@intentface/latch-server": patch
"@intentface/latch-mcp": patch
"@intentface/latch-langfuse": patch
---

The published packages no longer include compiled test files (4 in latch-server, 24 in latch-mcp, 4 in latch-langfuse). They build from a tsconfig that leaves tests out, as the other packages already did.
