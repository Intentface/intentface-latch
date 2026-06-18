import { createClient, type Client } from "@libsql/client";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  createRuntime,
  defineAgent,
  defineContext,
  type Runtime,
  type StorageAdapter,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";

/** A mock model that streams `text` and reports token usage — no API key. */
export function mockModel(text = "Hello, world!") {
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: {
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: text },
          { type: "text-end", id: "0" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } },
          },
        ],
      }),
    } as never,
  });
}

/** Build a runtime over an in-memory SQLite DB with one mock-backed `echo` agent. */
export async function makeRuntime(): Promise<{
  runtime: Runtime;
  storage: StorageAdapter;
  client: Client;
}> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter(client);
  const context = defineContext<{ orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });
  const agents = {
    echo: defineAgent<{ orgId: string }>(() => ({
      model: mockModel(),
      instructions: "You are a friendly assistant.",
    })),
  };
  const runtime = createRuntime({ storage, context, agents });
  return { runtime, storage, client };
}

export function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
