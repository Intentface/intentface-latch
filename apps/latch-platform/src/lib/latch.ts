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
import { anthropic } from "@ai-sdk/anthropic";

/**
 * The platform's Latch runtime — one durable instance over the shared libsql DB
 * (the same file better-auth uses). Built lazily and memoized per process.
 */
let cached: { runtime: Runtime; vault: Vault } | undefined;

export async function getLatch(): Promise<{ runtime: Runtime; vault: Vault }> {
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

  const agents = {
    assistant: defineAgent<{ orgId: string }>(() => ({
      model: anthropic("claude-sonnet-4-6"),
      instructions: "You are Latch's helpful, concise assistant.",
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

  cached = { runtime, vault };
  return cached;
}
