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
import { tools } from "./tools.js";

/** The example's Principal (opaque to Latch). The `owner` fn keys isolation. */
export interface Principal {
  orgId: string;
  userId?: string;
}
export const owner = (p: Principal) =>
  p.userId ? [p.orgId, p.userId] : [p.orgId];

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

/**
 * A two-step mock: step 1 emits a `getCurrentTime` tool call, step 2 (after the
 * tool runs) emits the final text. `doStream` as an array returns by call index,
 * so the ToolLoopAgent gets the tool-call turn first, then the answer turn.
 * Usage on each step accumulates via `onStepEnd` (10+12 in, 5+6 out).
 */
export function toolCallMock() {
  const step1 = {
    stream: simulateReadableStream({
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "call_1", toolName: "getCurrentTime" },
        { type: "tool-input-delta", id: "call_1", delta: '{"timeZone":"Asia/Tokyo"}' },
        { type: "tool-input-end", id: "call_1" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "getCurrentTime",
          input: '{"timeZone":"Asia/Tokyo"}',
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
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
        { type: "text-delta", id: "0", delta: "It's currently afternoon in Tokyo." },
        { type: "text-end", id: "0" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: { total: 12 }, outputTokens: { total: 6 } },
        },
      ],
    }),
  };
  return new MockLanguageModelV4({
    modelId: "mock-tools",
    doStream: [step1, step2] as never,
  });
}

/** A runtime whose `clock` agent calls the real `getCurrentTime` tool (mock-driven). */
export async function makeToolRuntime(): Promise<{
  runtime: Runtime<Principal>;
  storage: StorageAdapter<Principal>;
  client: Client;
}> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter<Principal>(client, { owner });
  const context = defineContext<Principal, { orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });
  const agents = {
    clock: defineAgent<Principal, { orgId: string }>(() => ({
      model: toolCallMock(),
      instructions: "Call getCurrentTime for the time.",
      tools,
    })),
  };
  const runtime = createRuntime<Principal, { orgId: string }>({ storage, context, agents });
  return { runtime, storage, client };
}

/** Build a runtime over an in-memory SQLite DB with one mock-backed `echo` agent. */
export async function makeRuntime(): Promise<{
  runtime: Runtime<Principal>;
  storage: StorageAdapter<Principal>;
  client: Client;
}> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter<Principal>(client, { owner });
  const context = defineContext<Principal, { orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });
  const agents = {
    echo: defineAgent<Principal, { orgId: string }>(() => ({
      model: mockModel(),
      instructions: "You are a friendly assistant.",
    })),
  };
  const runtime = createRuntime<Principal, { orgId: string }>({ storage, context, agents });
  return { runtime, storage, client };
}

/** A durable runtime (T2): leasing + heartbeat + reaper enabled, mock-backed. */
export async function makeDurableRuntime(
  durability: { leaseTtlMs?: number; heartbeatMs?: number; instanceId?: string } = {},
): Promise<{ runtime: Runtime<Principal>; storage: StorageAdapter<Principal>; client: Client }> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter<Principal>(client, { owner });
  const context = defineContext<Principal, { orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });
  const agents = {
    echo: defineAgent<Principal, { orgId: string }>(() => ({
      model: mockModel(),
      instructions: "You are a friendly assistant.",
    })),
  };
  const runtime = createRuntime<Principal, { orgId: string }>({
    storage,
    context,
    agents,
    durability: { enabled: true, ...durability },
  });
  return { runtime, storage, client };
}

export function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
