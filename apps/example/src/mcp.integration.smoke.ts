import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createClient } from "@libsql/client";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  createRuntime,
  defineAgent,
  defineContext,
  type AppMessage,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";
import { createMcpHost } from "@intentface/latch-mcp";
import { assert, owner, type Principal } from "./setup.js";

/**
 * Live MCP integration: a real (in-memory) MCP server exposes a `shout` tool;
 * the Latch MCP host surfaces it as a `toolSource`; an agent calls it and the
 * uppercased result — only producible by the server actually running — is
 * persisted. Exercises discovery (tools()), execution (MCP roundtrip), tool
 * namespacing, and per-turn open/close, end to end.
 */

/** Two-step mock: step 1 calls the MCP tool `demo_shout`, step 2 answers. */
function shoutMock() {
  const step1 = {
    stream: simulateReadableStream({
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "call_1", toolName: "demo_shout" },
        { type: "tool-input-delta", id: "call_1", delta: '{"text":"hello"}' },
        { type: "tool-input-end", id: "call_1" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "demo_shout",
          input: '{"text":"hello"}',
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: { total: 8 }, outputTokens: { total: 4 } },
        },
      ],
    }),
  };
  const step2 = {
    stream: simulateReadableStream({
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "Done — I shouted it." },
        { type: "text-end", id: "0" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: { total: 9 }, outputTokens: { total: 5 } },
        },
      ],
    }),
  };
  return new MockLanguageModelV4({ modelId: "mock-mcp", doStream: [step1, step2] as never });
}

async function main() {
  // --- a real MCP server with one tool, linked in-memory -----------------
  const server = new McpServer({ name: "demo-server", version: "1.0.0" });
  server.registerTool(
    "shout",
    { description: "Uppercase the given text.", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  // --- Latch MCP host over the in-process transport ----------------------
  const host = createMcpHost({
    connections: [{ name: "demo", transport: clientTransport }],
    allowedHosts: [], // not consulted for transport connections
  });

  // --- a runtime whose agent uses the MCP host as a tool source ----------
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter<Principal>(client, { owner });
  const context = defineContext<Principal, { orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });
  const agents = {
    mcpAgent: defineAgent<Principal, { orgId: string }>(() => ({
      model: shoutMock(),
      instructions: "Use the available tools.",
      toolSources: [host],
    })),
  };
  const runtime = createRuntime<Principal, { orgId: string }>({ storage, context, agents });

  const principal: Principal = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat(principal, { agent: "mcpAgent" });
  const userMessage: AppMessage = {
    id: "msg_user_1",
    role: "user",
    parts: [{ type: "text", text: "shout hello" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };

  await (
    await runtime.handleChat({ agent: "mcpAgent", chatId: chat.id, principal, message: userMessage })
  ).text();
  await new Promise((r) => setTimeout(r, 50));

  // --- assertions --------------------------------------------------------
  const loaded = await storage.loadMessages({ orgId: "org_a", userId: "user_1" }, chat.id);
  assert(loaded.length === 2, `user + assistant persisted (got ${loaded.length})`);
  const assistant = loaded.find((m) => m.role === "assistant");
  const partTypes = (assistant?.parts ?? []).map((p) => p.type);
  // MCP tools have runtime-discovered schemas, so they surface as `dynamic-tool`
  // parts (with a toolName) rather than a static `tool-<name>` type.
  assert(
    partTypes.includes("dynamic-tool"),
    `MCP tool called as a dynamic tool (parts: ${partTypes.join(", ")})`,
  );
  const blob = JSON.stringify(assistant?.parts ?? []);
  assert(blob.includes("demo_shout"), "called under its namespaced name `demo_shout`");
  assert(
    blob.includes("HELLO"),
    "the MCP server actually ran (uppercased result persisted)",
  );

  await server.close();
  console.log("✅ mcp integration passed — live discovery + execution through the host");
}

main().catch((e) => {
  console.error("❌ mcp integration failed:", e);
  throw e;
});
