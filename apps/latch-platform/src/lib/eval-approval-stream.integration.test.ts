import { createClient } from "@libsql/client";
import { jsonSchema, parseJsonEventStream, readUIMessageStream, tool } from "ai";
import type { UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { beforeAll, describe, expect, it } from "vitest";
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";
import type { Runtime, TurnWriter } from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";

/**
 * End-to-end over the REAL runtime: a gated tool (like run_evals) that streams
 * `data-eval-progress` parts while it executes. Covers the whole reported-broken
 * path: approve → applyApproval continuation → progress chunks on the wire
 * BEFORE the tool result → the client reader materializing them into the
 * message the EvalRunCard renders.
 */

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org", userId: "user" };

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const streamFrom = (parts: unknown[]) =>
  new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });

/** Call 1: ask for the gated tool. Call 2 (after execution): final answer. */
let modelCalls = 0;
const model = new MockLanguageModelV3({
  doStream: async () => {
    modelCalls += 1;
    if (modelCalls === 1) {
      return {
        stream: streamFrom([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "r1", modelId: "mock", timestamp: new Date(0) },
          { type: "tool-call", toolCallId: "call_slow", toolName: "slow_evals", input: JSON.stringify({ n: 3 }) },
          { type: "finish", finishReason: "tool-calls", usage },
        ]),
      };
    }
    return {
      stream: streamFrom([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "r2", modelId: "mock", timestamp: new Date(0) },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "All done." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ]),
    };
  },
});

/** Gated tool that reports progress through the turn writer, like run_evals. */
const slowAgent = defineAgent<P>({
  model: model as never,
  instructions: "test agent",
  tools: {
    slow_evals: tool({
      description: "slow gated tool streaming progress",
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }, options) => {
        const env = options as { toolCallId?: string; context?: { writer?: TurnWriter } };
        for (let i = 1; i <= n; i++) {
          await new Promise((r) => setTimeout(r, 20));
          env.context?.writer?.write({
            type: "data-eval-progress",
            id: `evalprog_${env.toolCallId ?? "run"}`,
            data: { toolCallId: env.toolCallId, completed: i, total: n },
          });
        }
        return { passed: n };
      },
    }),
  },
  toolApproval: { slow_evals: "user-approval" },
});

async function drain(res: Response) {
  if (res.body) for await (const _ of res.body as unknown as AsyncIterable<unknown>) void _;
}

async function readChunks(res: Response): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  const parsed = parseJsonEventStream({
    stream: res.body!,
    schema: jsonSchema<UIMessageChunk>({}),
  }) as unknown as AsyncIterable<{ success: boolean; value: UIMessageChunk }>;
  for await (const part of parsed) if (part.success) out.push(part.value);
  return out;
}

describe("approval continuation streams eval progress", () => {
  let runtime: Runtime<P>;

  beforeAll(async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    runtime = createRuntime<P, { orgId: string }>({
      storage: createSqliteAdapter<P>(client, { owner: (p) => [p.orgId, p.userId] }),
      context: defineContext<P, { orgId: string }>({
        build: ({ principal: p }) => ({ orgId: p.orgId }),
      }),
      agents: { slow: slowAgent },
    });
  });

  it("streams progress chunks before the tool result, and the client reader applies them", async () => {
    const chatId = "chat_eval_stream";
    // Turn 1: model asks for the gated tool → turn pauses on approval.
    await drain(
      await runtime.handleChat({
        agent: "slow",
        chatId,
        principal,
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "run the evals" }],
        } as never,
      }),
    );
    const history = await runtime.loadHistory({ chatId, principal });
    const assistant = history.at(-1)!;
    const toolPart = (assistant.parts as Record<string, unknown>[]).find(
      (p) => p.type === "tool-slow_evals",
    )!;
    expect(toolPart.state).toBe("approval-requested");
    const approvalId = (toolPart.approval as { id: string }).id;

    // Approve → continuation stream (what submitApproval hands consumeResume).
    const chunks = await readChunks(
      await runtime.applyApproval({
        chatId,
        principal,
        decisions: [{ approvalId, approved: true }],
      }),
    );

    // Wire order: progress chunks exist and ALL land before the tool result.
    const types = chunks.map((c) => (c as { type: string }).type);
    const progressIdxs = types.flatMap((t, i) => (t === "data-eval-progress" ? [i] : []));
    const outputIdx = types.findIndex((t) => t === "tool-output-available");
    expect(progressIdxs).toHaveLength(3);
    expect(outputIdx).toBeGreaterThan(progressIdxs[2]);

    // Client side: seed the reader with the optimistically-decided message
    // (what applyLocalDecision produces) and replay the continuation.
    const seed = structuredClone(assistant) as { parts: Record<string, unknown>[] };
    for (const p of seed.parts) {
      if (p.type === "tool-slow_evals") {
        p.state = "approval-responded";
        p.approval = { ...(p.approval as object), approved: true };
      }
    }
    const snapshots: { parts: Record<string, unknown>[] }[] = [];
    for await (const snap of readUIMessageStream({
      message: seed as never,
      stream: streamFrom(chunks) as never,
    })) {
      snapshots.push(structuredClone(snap) as never);
    }

    // Mid-run: some snapshot shows partial progress while the tool has no output
    // — exactly the state the EvalRunCard renders live.
    const midRun = snapshots.find((s) => {
      const prog = s.parts.find((p) => p.type === "data-eval-progress") as
        | { data?: { completed?: number } }
        | undefined;
      const call = s.parts.find((p) => p.type === "tool-slow_evals") as
        | { state?: string }
        | undefined;
      return !!prog?.data && prog.data.completed! < 3 && call?.state !== "output-available";
    });
    expect(midRun, "no snapshot showed partial progress before the tool result").toBeDefined();

    // Final: tool result landed and progress reconciled to done (single part, by id).
    const last = snapshots.at(-1)!;
    const finalCall = last.parts.find((p) => p.type === "tool-slow_evals") as {
      state?: string;
      output?: { passed?: number };
    };
    expect(finalCall.state).toBe("output-available");
    expect(finalCall.output?.passed).toBe(3);
    const progressParts = last.parts.filter((p) => p.type === "data-eval-progress");
    expect(progressParts).toHaveLength(1);
    expect((progressParts[0] as { data: { completed: number } }).data.completed).toBe(3);

    // The persisted history converts cleanly for the next turn (no dangling calls).
    const finalHistory = await runtime.loadHistory({ chatId, principal });
    const lastMsg = finalHistory.at(-1)!;
    const persistedCall = (lastMsg.parts as Record<string, unknown>[]).find(
      (p) => p.type === "tool-slow_evals",
    );
    expect((persistedCall as { state?: string } | undefined)?.state).toBe("output-available");
  });
});
