/**
 * The oracle. Seven turns through `createRuntime`, each snapshotted on three
 * surfaces at once:
 *
 *   requests   what the MODEL was asked — every `doStream` call's prompt,
 *              tools, providerOptions (cache breakpoints), maxOutputTokens
 *   chunks     what the CLIENT received — the UI chunk sequence
 *   stored     what STORAGE holds afterwards — messages and run rows
 *
 * Recorded before the extension seam existed. A refactor that changes any
 * byte here has changed behaviour, whatever the other tests say — the point
 * is that the provider request and the persisted record have no other test
 * that reads them whole. Ids and timestamps are normalised; everything else
 * is compared literally, including the date line's position in the prompt.
 */
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime, type Runtime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import type { AppMessage } from "./message.js";
import type { MemoryProvider } from "./memory.js";
import { memoryStorage } from "./__tests__/memory-storage.js";

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org_a", userId: "u_1" };

// --- a scripted model -------------------------------------------------------

type Step = { kind: "text"; text: string } | { kind: "tool"; name: string; input: string };
const text = (t: string): Step => ({ kind: "text", text: t });
const call = (name: string, input = "{}"): Step => ({ kind: "tool", name, input });

const usage = (cacheRead = 0) => ({
  inputTokens: { total: 100, noCache: 100 - cacheRead, cacheRead, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
});

function streamFor(step: Step, cacheRead: number) {
  const finish = (reason: string) => ({ type: "finish", finishReason: reason, usage: usage(cacheRead) });
  const chunks =
    step.kind === "text"
      ? [
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "resp", modelId: "mock", timestamp: new Date(0) },
          { type: "text-start", id: "t0" },
          { type: "text-delta", id: "t0", delta: step.text },
          { type: "text-end", id: "t0" },
          finish("stop"),
        ]
      : [
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "resp", modelId: "mock", timestamp: new Date(0) },
          { type: "tool-input-start", id: "call_1", toolName: step.name },
          { type: "tool-input-delta", id: "call_1", delta: step.input },
          { type: "tool-input-end", id: "call_1" },
          { type: "tool-call", toolCallId: "call_1", toolName: step.name, input: step.input },
          finish("tool-calls"),
        ];
  return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
}

/** Each model call plays the next scripted step; the last one repeats. */
function scripted(steps: Step[], opts: { provider?: string; modelId?: string; cacheRead?: number } = {}) {
  let n = 0;
  return new MockLanguageModelV4({
    provider: opts.provider ?? "mock-provider",
    modelId: opts.modelId ?? "mock",
    doStream: (async () => streamFor(steps[Math.min(n++, steps.length - 1)]!, opts.cacheRead ?? 0)) as never,
  });
}

// --- tools ----------------------------------------------------------------------

const getTime = tool({
  description: "The current time.",
  inputSchema: z.object({}),
  execute: async () => ({ time: "12:00" }),
});
const writeThing = tool({
  description: "Writes something.",
  inputSchema: z.object({ what: z.string() }),
  execute: async ({ what }) => ({ wrote: what }),
});

// --- normalisation -------------------------------------------------------------

const ID_KEYS = new Set([
  "id", "messageId", "runId", "chatId", "threadId", "approvalId", "subChatId",
  "spawnToolCallId", "parentRunId", "rootChatId", "callId",
]);
const TS_KEYS = new Set(["createdAt", "updatedAt", "startedAt", "endedAt", "timestamp", "at", "leaseExpiresAt"]);
const RANDOM_ID = /^(msg|run|chat|sub|sapv|inst)_[A-Za-z0-9_-]+$|^[A-Za-z0-9_-]{16,}$/;
// By shape, not by the value captured at module load: a suite that crosses UTC
// midnight would otherwise write a real date into the snapshot.
const DATE_LINE = /Today's date is (?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, \d{4}-\d{2}-\d{2} \(UTC\)\./g;

function normalise(v: unknown, key?: string): unknown {
  if (typeof v === "function") return undefined;
  if (Array.isArray(v)) return v.map((x) => normalise(x));
  if (v && typeof v === "object") {
    if (typeof AbortSignal !== "undefined" && v instanceof AbortSignal) return undefined;
    if (v instanceof Date) return "<date>";
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "abortSignal" || k === "headers") continue;
      const n = normalise(val, k);
      if (n !== undefined) out[k] = n;
    }
    return out;
  }
  if (typeof v === "string") {
    if (key && ID_KEYS.has(key) && RANDOM_ID.test(v)) return "<id>";
    return v.replace(DATE_LINE, "<date-line>");
  }
  if (typeof v === "number" && key && TS_KEYS.has(key)) return "<ts>";
  return v;
}

/** SSE body → UI chunks. */
async function chunksOf(res: Response): Promise<unknown[]> {
  const body = await res.text();
  return body
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice("data: ".length)) as unknown);
}

const user = (id: string, t: string): AppMessage =>
  ({ id, role: "user", parts: [{ type: "text", text: t }], metadata: { visibility: "user" } }) as AppMessage;

function snapshotOf(mem: ReturnType<typeof memoryStorage<P>>, models: MockLanguageModelV4[], chunks: unknown) {
  // Storage mints ids from a process-wide counter, so a chat's id depends on
  // how many tests ran before it. Explicit ids (the approval fixture's
  // "chat_g") are kept; minted ones are named by kind.
  const stored = Object.fromEntries(
    [...mem.messages.entries()].map(([chatId, msgs]) => [
      chatId.startsWith("sub_") ? "<sub>" : /^chat_\d+$/.test(chatId) ? "<chat>" : chatId,
      msgs.map((m) => ({
        ...m,
        parts: (m.parts as Array<{ type: string; data?: { messages?: unknown[] } }>).map((p) =>
          // The live-progress mirror of a subagent's transcript is timing-dependent
          // in how often it was re-sent; only its final shape is the contract.
          p.type === "data-subagent-progress" && p.data?.messages
            ? { ...p, data: { ...p.data, messages: `<${p.data.messages.length} messages>` } }
            : p,
        ),
      })),
    ]),
  );
  return normalise({
    requests: models.map((m) => m.doStreamCalls),
    chunks,
    stored,
    runs: [...mem.runs.values()],
  });
}

// --- the runtime under test -----------------------------------------------------

const memoryProvider: MemoryProvider<P> = {
  instructionsFor: async () => "## What I remember\n- Prefers tea.",
  toolsFor: () => ({
    memory_search: tool({
      description: "Search memory.",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => ({ hits: [] }),
    }),
  }),
};

function runtimeFor(mem: ReturnType<typeof memoryStorage<P>>, models: Record<string, MockLanguageModelV4>): Runtime<P> {
  return createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, { orgName: string }>({ build: async ({ principal: p }) => ({ orgName: p.orgId }) }),
    pricing: () => ({ inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }),
    memory: memoryProvider,
    agents: {
      echo: defineAgent<P>({ model: models.echo!, instructions: "Echo the user." }),
      tooler: defineAgent<P>({ model: models.tooler!, instructions: "Use tools.", tools: { get_time: getTime } }),
      gated: defineAgent<P>({
        model: models.gated!,
        instructions: "Write carefully.",
        tools: { write_thing: writeThing },
        toolApproval: { write_thing: "user-approval" },
      }),
      mem: defineAgent<P>({
        model: models.mem!,
        instructions: "Remember things.",
        tools: { get_time: getTime },
        memory: { scope: "agent-user" } as never,
      }),
      smooth: defineAgent<P>({ model: models.smooth!, instructions: "Be smooth.", smoothStream: true }),
      capped: defineAgent<P>({ model: models.capped!, instructions: "Loop.", tools: { get_time: getTime }, maxSteps: 2 }),
      parent: defineAgent<P>({ model: models.parent!, instructions: "Delegate.", subagents: ["child"] }),
      child: defineAgent<P>({ model: models.child!, instructions: "Do the task." }),
    },
  });
}

function fixtures() {
  return {
    echo: scripted([text("hello there")]),
    tooler: scripted([call("get_time"), text("It is noon.")]),
    gated: scripted([call("write_thing", '{"what":"x"}'), text("Wrote it.")]),
    // An Anthropic-family provider id turns the DEFAULT prompt-caching plan on,
    // so the request carries cache breakpoints; cache reads exercise pricing.
    mem: scripted([call("get_time"), text("Noted.")], { provider: "anthropic.messages", modelId: "claude-mock", cacheRead: 80 }),
    smooth: scripted([text("one two three four")]),
    capped: scripted([call("get_time")]),
    parent: scripted([call("spawn_agent", '{"agent":"child","prompt":"do it"}'), text("The child said ok.")]),
    child: scripted([text("ok")]),
  };
}

describe("turn snapshot oracle", () => {
  it("a plain text turn", async () => {
    const mem = memoryStorage<P>();
    const m = fixtures();
    const rt = runtimeFor(mem, m);
    const chunks = await chunksOf(await rt.handleChat({ agent: "echo", principal, message: user("u1", "hi") }));
    expect(snapshotOf(mem, [m.echo], chunks)).toMatchSnapshot();
  });

  it("a tool call then an answer", async () => {
    const mem = memoryStorage<P>();
    const m = fixtures();
    const rt = runtimeFor(mem, m);
    const chunks = await chunksOf(await rt.handleChat({ agent: "tooler", principal, message: user("u1", "time?") }));
    expect(snapshotOf(mem, [m.tooler], chunks)).toMatchSnapshot();
  });

  it("an approval gate, then the decision continues the turn", async () => {
    const mem = memoryStorage<P>();
    const m = fixtures();
    const rt = runtimeFor(mem, m);
    const first = await chunksOf(await rt.handleChat({ agent: "gated", principal, chatId: "chat_g", message: user("u1", "write x") }));
    const paused = mem.messages.get("chat_g")!;
    const part = paused
      .flatMap((msg) => msg.parts as Array<{ type: string; state?: string; approval?: { id: string } }>)
      .find((p) => p.type === "tool-write_thing" && p.state === "approval-requested")!;
    const second = await chunksOf(
      await rt.applyApproval({ chatId: "chat_g", principal, decisions: [{ approvalId: part.approval!.id, approved: true }] }),
    );
    expect(snapshotOf(mem, [m.gated], { first, second })).toMatchSnapshot();
  });

  it("a memory-enabled agent on a caching provider", async () => {
    const mem = memoryStorage<P>();
    const m = fixtures();
    const rt = runtimeFor(mem, m);
    const chunks = await chunksOf(await rt.handleChat({ agent: "mem", principal, message: user("u1", "what do I like?") }));
    expect(snapshotOf(mem, [m.mem], chunks)).toMatchSnapshot();
  });

  it("smoothStream on", async () => {
    const mem = memoryStorage<P>();
    const m = fixtures();
    const rt = runtimeFor(mem, m);
    const chunks = await chunksOf(await rt.handleChat({ agent: "smooth", principal, message: user("u1", "go") }));
    expect(snapshotOf(mem, [m.smooth], chunks)).toMatchSnapshot();
  });

  it("maxSteps caps a loop that never stops calling tools", async () => {
    const mem = memoryStorage<P>();
    const m = fixtures();
    const rt = runtimeFor(mem, m);
    const chunks = await chunksOf(await rt.handleChat({ agent: "capped", principal, message: user("u1", "loop") }));
    expect(snapshotOf(mem, [m.capped], chunks)).toMatchSnapshot();
  });

  it("a subagent delegation", async () => {
    const mem = memoryStorage<P>();
    const m = fixtures();
    const rt = runtimeFor(mem, m);
    const chunks = await chunksOf(await rt.handleChat({ agent: "parent", principal, message: user("u1", "delegate") }));
    expect(snapshotOf(mem, [m.parent, m.child], chunks)).toMatchSnapshot();
  });
});
