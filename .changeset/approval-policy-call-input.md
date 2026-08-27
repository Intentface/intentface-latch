---
"@intentface/latch-mcp": minor
---

Approval policy can now see call arguments. A connection's `approval` predicate may return, instead of a boolean, a per-call function `(input) => boolean | Promise<boolean>` — evaluated by the AI SDK with the model's arguments each time the tool is called. This is the escape hatch for meta-tool servers (one `execute_tool` multiplexing every operation through its arguments carries a single annotation set, so a per-tool boolean can only gate everything or nothing): gate `execute_tool` only when `input.toolName` starts with `create_`, and let the reads run free. Annotations remain the first-class, default signal. New exports: `McpCallApproval`, `mcpApprovalValue`. `needsMcpApproval`'s return type widens to `boolean | McpCallApproval` (a function is truthy, so existing truthiness checks stay conservative and correct).
