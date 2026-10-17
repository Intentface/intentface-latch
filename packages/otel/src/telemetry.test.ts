import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRuntime, defineAgent, type LatchTelemetry } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";
import { otelTelemetry, traceIdForRun } from "./index.js";
import { langfuse, langfuseOtlp } from "./langfuse.js";

type P = { tenantId: string; userId: string };
const me: P = { tenantId: "t1", userId: "u7" };

const usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = (reason: string) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
const meta = { type: "response-metadata", id: "resp", modelId: "mock", timestamp: new Date(0) };
const toolCall = [
  { type: "stream-start", warnings: [] },
  meta,
  { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: '{"q":"weather"}' },
  finish("tool-calls"),
];
const answer = (text: string) => [
  { type: "stream-start", warnings: [] },
  meta,
  { type: "text-start", id: "t0" },
  { type: "text-delta", id: "t0", delta: text },
  { type: "text-end", id: "t0" },
  finish("stop"),
];

/** Calls the tool once, then answers. */
function model() {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () => ({
      stream: simulateReadableStream<unknown>({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks: n++ === 0 ? toolCall : answer("It's sunny.") }),
    })) as never,
  });
}

async function runOnce(telemetry: LatchTelemetry<P>, m = model()) {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const rt = createRuntime<P>({
    storage: createSqliteAdapter<P>(drizzle(client, { schema }), { owner: (p) => [p.tenantId, p.userId] }),
    agents: {
      helper: defineAgent<P>({
        model: m,
        tools: { lookup: tool({ inputSchema: z.object({ q: z.string() }), execute: async () => "sunny" }) },
      }),
    },
    telemetry,
  });
  return rt.runAgent({ principal: me, agent: "helper", prompt: "What's the weather?" });
}

const rootOf = (spans: ReadableSpan[]) => spans.find((s) => s.name === "latch.run helper")!;

describe("otelTelemetry", () => {
  it("records a run as one trace: the run's span with the AI SDK's spans under it", async () => {
    const exporter = new InMemorySpanExporter();
    const result = await runOnce(otelTelemetry<P>({ export: exporter, user: (p) => `${p.tenantId}/${p.userId}`, environment: "test" }));
    expect(result.answer).toBe("It's sunny.");

    const spans = exporter.getFinishedSpans();
    const root = rootOf(spans);
    const runId = String(root.attributes["latch.run.id"]);
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.spanContext().traceId).toBe(await traceIdForRun(runId));
    expect(spans.length).toBeGreaterThan(2);
    expect(spans.some((s) => s.attributes["gen_ai.operation.name"] === "execute_tool")).toBe(true);
    for (const s of spans) {
      expect(s.spanContext().traceId, s.name).toBe(root.spanContext().traceId);
      expect(s.attributes, s.name).toMatchObject({ "session.id": result.threadId, "user.id": "t1/u7", "latch.run.id": runId });
    }
    expect(root.attributes).toMatchObject({
      "input.value": "What's the weather?",
      "output.value": "It's sunny.",
      "latch.run.status": "completed",
      "deployment.environment.name": "test",
    });
  });

  it("marks the run's span as an error when the run fails", async () => {
    const exporter = new InMemorySpanExporter();
    const failing = new MockLanguageModelV4({ modelId: "mock", doStream: (async () => Promise.reject(new Error("provider down"))) as never });
    await runOnce(otelTelemetry<P>({ export: langfuse({ exporter, publicKey: "pk", secretKey: "sk" }) }), failing);

    const root = rootOf(exporter.getFinishedSpans());
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes).toMatchObject({ "latch.run.status": "errored", "langfuse.observation.level": "ERROR" });
  });

  it("never fails a turn: a throwing callback only loses its attributes", async () => {
    const exporter = new InMemorySpanExporter();
    const boom = () => {
      throw new Error("boom");
    };
    const result = await runOnce(
      otelTelemetry<P>({
        user: boom,
        attributes: boom,
        agentOwner: async () => boom(),
        export: { exporter, runAttributes: boom, finishedAttributes: boom },
      }),
    );
    expect(result.answer).toBe("It's sunny.");
    const root = rootOf(exporter.getFinishedSpans());
    expect(root.attributes).toMatchObject({ "latch.run.status": "completed" });
    expect(root.attributes).not.toHaveProperty("user.id");
  });

  it("derives the same trace id latch-langfuse did", async () => {
    expect(await traceIdForRun("run_abc")).toBe("ccce92cfea89e318e24539046f02ffaf");
  });
});

describe("langfuse()", () => {
  it("puts the session, user, tags and metadata Langfuse filters on onto every span", async () => {
    const exporter = new InMemorySpanExporter();
    await runOnce(otelTelemetry<P>({ export: langfuse({ exporter, publicKey: "pk", secretKey: "sk", environment: "dev" }), user: (p) => p.userId }));

    const spans = exporter.getFinishedSpans();
    const runId = String(rootOf(spans).attributes["latch.run.id"]);
    for (const s of spans) {
      expect(s.attributes, s.name).toMatchObject({
        "langfuse.trace.name": "helper",
        "langfuse.user.id": "u7",
        "langfuse.environment": "dev",
        "langfuse.trace.metadata.runId": runId,
      });
      expect(s.attributes["langfuse.trace.tags"]).toEqual(["owner:u7", "agent:helper", `run:${runId}`]);
    }
    expect(rootOf(spans).attributes["langfuse.observation.type"]).toBe("agent");
  });

  it("sends to the project's OTLP endpoint with its keys", () => {
    expect(langfuseOtlp({ publicKey: "pk-lf-1", secretKey: "sk-lf-2", baseUrl: "https://us.cloud.langfuse.com/" })).toEqual({
      url: "https://us.cloud.langfuse.com/api/public/otel/v1/traces",
      headers: { Authorization: `Basic ${btoa("pk-lf-1:sk-lf-2")}`, "x-langfuse-ingestion-version": "4" },
    });
    const saved = { pk: process.env.LANGFUSE_PUBLIC_KEY, sk: process.env.LANGFUSE_SECRET_KEY };
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    try {
      expect(() => langfuse()).toThrow(/LANGFUSE_PUBLIC_KEY/);
    } finally {
      if (saved.pk) process.env.LANGFUSE_PUBLIC_KEY = saved.pk;
      if (saved.sk) process.env.LANGFUSE_SECRET_KEY = saved.sk;
    }
  });
});
