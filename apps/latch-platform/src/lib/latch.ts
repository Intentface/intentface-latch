import { createClient } from "@libsql/client";
import {
  createRuntime,
  createVault,
  defineAgent,
  defineContext,
  staticPricing,
  type Runtime,
  type Vault,
} from "@intentface/latch-core";
import {
  createSqliteAdapter,
  createSqliteSecretStore,
  migrate,
} from "@intentface/latch-drizzle";
import type { McpHost } from "@intentface/latch-mcp";
import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { createMcpHost } from "@intentface/latch-mcp";

/** The Vault key holding a tenant's Loredex API token (a connection credential). */
export const LOREDEX_TOKEN_KEY = "loredex_token";

/**
 * The platform's Latch runtime — one durable instance over the shared libsql DB
 * (the same file better-auth uses). Built lazily and memoized per process.
 */
let cached: { runtime: Runtime; vault: Vault; mcpHost: McpHost } | undefined;

export async function getLatch(): Promise<{
  runtime: Runtime;
  vault: Vault;
  mcpHost: McpHost;
}> {
  if (cached) return cached;

  const client = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });
  await migrate(client); // creates latch_* tables alongside the auth tables

  const storage = createSqliteAdapter(client);
  const vault = createVault({
    store: createSqliteSecretStore(client),
    // Dev fallback is a deterministic 32-byte key; set LATCH_VAULT_KEY in prod.
    masterKey: process.env.LATCH_VAULT_KEY ?? btoa("latch-dev-vault-key-32-bytes!!!!"),
  });

  const context = defineContext<{ orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });

  // MCP: the Loredex knowledge base. Per-tenant SSRF allowlist + vault-brokered
  // bearer token. The connection is included only once the org has saved a
  // token; a failed connection is skipped (the agent still works without it).
  const loredexUrl = process.env.LOREDEX_MCP_URL;
  const mcpHost = createMcpHost({
    secrets: vault.resolver,
    allowedHosts: ["app.loredex.ai"],
    connections: async (scope) => {
      if (!loredexUrl || !(await vault.has(scope, LOREDEX_TOKEN_KEY))) return [];
      return [
        {
          name: "loredex",
          url: loredexUrl,
          auth: { type: "bearer", vaultKey: LOREDEX_TOKEN_KEY },
        },
      ];
    },
    onConnectionError: (name, err) =>
      console.warn(`MCP "${name}" skipped:`, err instanceof Error ? err.message : err),
  });

  const agents = {
    assistant: defineAgent<{ orgId: string }>(() => ({
      model: anthropic("claude-sonnet-4-6"),
      instructions:
        "You are Latch's helpful, concise assistant. To charge a customer, " +
        "call chargeCustomer — it requires human approval before it runs. " +
        "When Loredex knowledge-base tools (loredex_*) are available, use them " +
        "to answer questions about the user's documents.",
      toolSources: [mcpHost],
      tools: {
        chargeCustomer: tool({
          description: "Charge a customer's card (sensitive — needs approval).",
          inputSchema: z.object({
            customer: z.string(),
            amountUsd: z.number(),
          }),
          execute: async ({ customer, amountUsd }) => ({
            charged: true,
            customer,
            amountUsd,
            reference: `ch_${Math.round(amountUsd * 100)}`,
          }),
        }),
      },
      // HITL: the turn pauses (awaiting_input) until the user approves.
      toolApproval: { chargeCustomer: "user-approval" },
    })),
  };

  const runtime = createRuntime({
    storage,
    context,
    agents,
    durability: { enabled: true, leaseTtlMs: 30_000, heartbeatMs: 10_000 },
    // Illustrative rates (USD per 1M tokens). Swap for models.dev later.
    pricing: staticPricing({
      "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
    }),
  });

  cached = { runtime, vault, mcpHost };
  return cached;
}
