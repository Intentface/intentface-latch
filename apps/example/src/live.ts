import { createClient } from "@libsql/client";
import {
  createRuntime,
  createVault,
  defineAgent,
  defineContext,
  type Runtime,
  type Vault,
} from "@intentface/latch-core";
import {
  createSqliteAdapter,
  createSqliteSecretStore,
  migrate,
} from "@intentface/latch-drizzle";
import { model } from "./models.js";
import { tools } from "./tools.js";

/** The example's Principal (opaque to Latch). `owner` keys isolation per org+user. */
export interface Principal {
  orgId: string;
  userId?: string;
}
const owner = (p: Principal) => (p.userId ? [p.orgId, p.userId] : [p.orgId]);

/**
 * A real-model runtime — same wiring as `setup.ts`, but the agent's `model` is
 * a live provider model (via the registry in `models.ts`) instead of the mock.
 * Also returns a Vault (for connection credentials / MCP OAuth). Used by
 * `serve.ts`. Requires `ANTHROPIC_API_KEY` (and/or `OPENAI_API_KEY`); the Vault
 * needs `LATCH_VAULT_KEY` (base64 32 bytes).
 */
export async function makeLiveRuntime(): Promise<{
  runtime: Runtime<Principal>;
  vault: Vault<Principal>;
}> {
  const client = createClient({ url: "file:./latch-dev.db" });
  await migrate(client);
  const storage = createSqliteAdapter<Principal>(client, { owner });

  const masterKey = process.env.LATCH_VAULT_KEY;
  if (!masterKey) {
    throw new Error(
      "LATCH_VAULT_KEY is required (base64 of 32 bytes). Generate one with:\n" +
        '  node -e "console.log(crypto.randomBytes(32).toString(\'base64\'))"',
    );
  }
  const vault = createVault<Principal>({
    store: createSqliteSecretStore<Principal>(client, { owner }),
    masterKey,
  });

  const context = defineContext<Principal, { orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });

  const agents = {
    assistant: defineAgent<Principal, { orgId: string }>(() => ({
      model: model("latch:default"), // swap to "latch:smart" / "latch:openai" anytime
      instructions:
        "You are a concise, friendly assistant. Use tools when they help; " +
        "for the current time, always call getCurrentTime rather than guessing.",
      tools,
    })),
  };

  const runtime = createRuntime<Principal, { orgId: string }>({
    storage,
    context,
    agents,
    // T2 durability: lease + heartbeat per turn; reaped/resumed by the scheduler.
    durability: { enabled: true, leaseTtlMs: 30_000, heartbeatMs: 10_000 },
  });
  return { runtime, vault };
}
