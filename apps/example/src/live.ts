import { createClient } from "@libsql/client";
import {
  createRuntime,
  defineAgent,
  defineContext,
  type Runtime,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";
import { model } from "./models.js";
import { tools } from "./tools.js";

/**
 * A real-model runtime — same wiring as `setup.ts`, but the agent's `model` is
 * a live provider model (via the registry in `models.ts`) instead of the mock.
 * Used by `serve.ts`. Requires `ANTHROPIC_API_KEY` (and/or `OPENAI_API_KEY`).
 */
export async function makeLiveRuntime(): Promise<Runtime> {
  const client = createClient({ url: "file:./latch-dev.db" });
  await migrate(client);
  const storage = createSqliteAdapter(client);

  const context = defineContext<{ orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });

  const agents = {
    assistant: defineAgent<{ orgId: string }>(() => ({
      model: model("latch:default"), // swap to "latch:smart" / "latch:openai" anytime
      instructions:
        "You are a concise, friendly assistant. Use tools when they help; " +
        "for the current time, always call getCurrentTime rather than guessing.",
      tools,
    })),
  };

  return createRuntime({
    storage,
    context,
    agents,
    // T2 durability: lease + heartbeat per turn; reaped/resumed by the scheduler.
    durability: { enabled: true, leaseTtlMs: 30_000, heartbeatMs: 10_000 },
  });
}
