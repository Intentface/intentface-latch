import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import type { AppMessage } from "./message.js";
import type { ChatRecord, RunRecord, StorageAdapter } from "./storage.js";
import {
  EXTENSION_PART_TYPE,
  applyExtensionParts,
  collectFiles,
  extensionInstructionBlocks,
  parseSlashInvocation,
  redactExtensionParts,
  selectExtensions,
  type AgentExtension,
  type ExtensionPart,
  type ScriptEngine,
  type ScriptToolMount,
} from "./extensions.js";
import { toClientMessages, toModelMessages } from "./projections.js";

/**
 * Agent extensions: scripts that run BEFORE the model. The invariant under
 * test throughout — the model reads exactly what was persisted on the user
 * message, and a resume reads the same thing without re-running anything.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

// ---------------------------------------------------------------- fixtures

/** In-memory storage with upsert-by-id `appendMessages`, plus a call log. */
function memoryStorage() {
  const chats = new Map<string, ChatRecord>();
  const messages = new Map<string, AppMessage[]>();
  const runs = new Map<string, RunRecord>();
  const log: string[] = [];
  let n = 0;
  const impl: Partial<StorageAdapter<P>> = {
    async createChat(_p, input) {
      const chat: ChatRecord = {
        id: input.id ?? `chat_${++n}`,
        owner: "org_a",
        agent: input.agent,
        title: input.title,
        kind: input.kind ?? "user",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      chats.set(chat.id, chat);
      messages.set(chat.id, []);
      return chat;
    },
    async getChat(_p, id) {
      return chats.get(id) ?? null;
    },
    async loadMessages(_p, chatId) {
      return structuredClone(messages.get(chatId) ?? []);
    },
    async appendMessages(chatId, msgs) {
      log.push(`append:${msgs.map((m) => m.role).join(",")}`);
      const list = [...(messages.get(chatId) ?? [])];
      for (const m of msgs) {
        const i = list.findIndex((x) => x.id === m.id);
        if (i >= 0) list[i] = structuredClone(m);
        else list.push(structuredClone(m));
      }
      messages.set(chatId, list);
    },
    async createRun(_p, input) {
      const run: RunRecord = {
        id: `run_${++n}`,
        chatId: input.chatId,
        agent: input.agent,
        status: "active",
        startedAt: Date.now(),
        kind: input.kind,
      } as RunRecord;
      runs.set(run.id, run);
      return run;
    },
    async updateRun(id, patch) {
      const r = runs.get(id);
      if (r) runs.set(id, { ...r, ...patch } as RunRecord);
      return true;
    },
    async getRun(id) {
      return runs.get(id) ?? null;
    },
    async recordUsage() {},
  };
  return { storage: impl as StorageAdapter<P>, chats, messages, runs, log };
}

type Prompt = Array<{ role: string; content: unknown }>;

/** A model that records every prompt it receives and answers `text`. */
function capturingModel(text = "ok", onCall?: () => void) {
  const prompts: Prompt[] = [];
  const model = new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async ({ prompt }: { prompt: Prompt }) => {
      prompts.push(prompt);
      onCall?.();
      return {
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
              usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
            },
          ],
        }),
      };
    }) as never,
  });
  return { model, prompts };
}

/**
 * A fake ScriptEngine: `analyze` reports the calls/issues it is told to; `run`
 * optionally invokes one mount (to prove the tool context) and returns
 * `output(input)`; `render` substitutes `{{ path }}` from the scope.
 */
function fakeEngine(opts: {
  calls?: string[];
  issues?: string[];
  output?: (input: unknown) => unknown;
  /** Call this mounted tool with these args during `run`. */
  callTool?: { name: string; args: unknown };
  /** Never settle until the abort signal fires. */
  hang?: boolean;
  runThrows?: Error;
}) {
  const analyzed: string[][] = [];
  const runs: Array<{ mounts: string[]; input: unknown }> = [];
  const toolResults: unknown[] = [];
  const engine: ScriptEngine = {
    analyze(_script, { tools }) {
      analyzed.push(tools);
      return { plan: { ok: true }, calls: opts.calls ?? [], issues: opts.issues ?? [] };
    },
    async run(_plan, { tools, input, signal }) {
      runs.push({ mounts: tools.map((t) => t.name), input });
      if (opts.runThrows) throw opts.runThrows;
      if (opts.hang) {
        await new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      }
      if (opts.callTool) {
        const t = tools.find((m: ScriptToolMount) => m.name === opts.callTool!.name);
        if (!t) throw new Error(`mount ${opts.callTool.name} missing`);
        toolResults.push(await t.execute(opts.callTool.args, { stepId: "s1", toolCallId: "s1" }));
      }
      const output = opts.output ? opts.output(input) : { fromScript: true };
      return {
        status: "ok",
        output,
        steps: { s1: output },
        calls: (opts.calls ?? []).map((tool) => ({ tool, stepId: "s1" })),
      };
    },
    async render(template, scope) {
      return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
        const v = path.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], scope);
        return typeof v === "string" ? v : JSON.stringify(v);
      });
    },
  };
  return { engine, analyzed, runs, toolResults };
}

const hoursTool = tool({
  description: "hours per member",
  inputSchema: z.object({ period: z.string() }),
  execute: async ({ period }, options) => ({
    period,
    // Echo what a Latch tool sees, so a test can assert the bound context.
    context: Object.keys((options as { context?: Record<string, unknown> }).context ?? {}),
    members: [{ name: "Anna", total: 38 }],
  }),
});

const writeTool = tool({
  description: "mutates",
  inputSchema: z.object({ what: z.string() }),
  execute: async ({ what }) => ({ wrote: what }),
});

const noExecTool = { description: "provider-defined", inputSchema: z.object({}) };

function userMessage(text: string, extra?: Partial<AppMessage>): AppMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { visibility: "user", createdAt: Date.now() },
    ...extra,
  } as AppMessage;
}

function runtimeWith(opts: {
  extensions: AgentExtension[];
  engine?: ScriptEngine;
  model: MockLanguageModelV4;
  tools?: Record<string, unknown>;
  toolApproval?: Record<string, unknown>;
  enabledTools?: string[];
  caching?: boolean;
}) {
  const store = memoryStorage();
  const runtime = createRuntime<P, { orgId: string }>({
    storage: store.storage,
    context: defineContext<P, { orgId: string }>({ build: ({ principal }) => ({ orgId: principal.orgId }) }),
    agents: {
      helper: defineAgent<P, { orgId: string }>(() => ({
        model: opts.model,
        instructions: "You help.",
        tools: opts.tools ?? { clockify_hours: hoursTool, write_page: writeTool, provider_thing: noExecTool },
        toolApproval: opts.toolApproval ?? { write_page: "user-approval" },
        enabledTools: opts.enabledTools,
        extensions: opts.extensions,
      })),
    },
    ...(opts.engine ? { scripts: opts.engine } : {}),
    ...(opts.caching
      ? {
          resolvePromptCaching: () => ({
            systemProviderOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
          }),
        }
      : { resolvePromptCaching: () => undefined }),
  });
  return { runtime, ...store };
}

async function turn(
  rt: ReturnType<typeof runtimeWith>,
  message: AppMessage,
  chatId?: string,
): Promise<{ chatId: string; stored: AppMessage[] }> {
  const res = await rt.runtime.handleChat({ agent: "helper", principal, message, chatId });
  await res.text();
  await new Promise((r) => setTimeout(r, 30));
  const id = chatId ?? [...rt.chats.keys()].at(-1)!;
  return { chatId: id, stored: await rt.storage.loadMessages(principal, id) };
}

const userText = (prompt: Prompt): string =>
  prompt
    .filter((m) => m.role === "user")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
    .map((c) => (typeof c === "string" ? c : (c as { text?: string }).text ?? ""))
    .join("\n---\n");

const systemMessages = (prompt: Prompt) => prompt.filter((m) => m.role === "system");

const partsOf = (m: AppMessage) => m.parts as Array<Record<string, unknown>>;
const extPartsOf = (m: AppMessage) =>
  partsOf(m).filter((p) => p.type === EXTENSION_PART_TYPE) as unknown as ExtensionPart[];

const report: AgentExtension = {
  name: "report",
  on: "slash",
  script: "const h = await clockify_hours({ period: input.args }); return h;",
  template: "Weekly report for {{ input.args }}: {{ output.members }}",
};

// ------------------------------------------------------------------- tests

describe("parseSlashInvocation", () => {
  it("parses only known names, case-insensitively, and keeps unknown slash text as text", () => {
    expect(parseSlashInvocation("/Report  week  two", ["report"])).toEqual({
      name: "report",
      args: "week  two",
      argv: ["week", "two"],
    });
    expect(parseSlashInvocation("/report", ["report"])).toEqual({ name: "report", args: "", argv: [] });
    expect(parseSlashInvocation("/report@mybot week", ["report"])?.args).toBe("week");
    expect(parseSlashInvocation("/Users/me/notes.txt is here", ["report"])).toBeNull();
    expect(parseSlashInvocation("/unknown x", ["report"])).toBeNull();
    expect(parseSlashInvocation("report week", ["report"])).toBeNull();
  });
});

describe("selectExtensions", () => {
  const ctx: AgentExtension = { name: "ctx", on: "chat-start", script: "return 1" };
  const partFor = (name: string, at: number): ExtensionPart => ({
    type: EXTENSION_PART_TYPE,
    id: "ext_1",
    data: { name, on: "chat-start", target: "message", placement: "after", scope: "turn", reveal: "command", at, calls: [], rendered: "x" },
  });

  it("runs chat-start once, again after refresh, and again after a compaction", () => {
    const first = userMessage("hi");
    expect(selectExtensions({ extensions: [ctx], message: first, window: [first], now: 1000 })).toHaveLength(1);

    const withPart = { ...first, parts: [...first.parts, partFor("ctx", 1000)] } as AppMessage;
    const second = userMessage("more");
    expect(
      selectExtensions({ extensions: [ctx], message: second, window: [withPart, second], now: 2000 }),
    ).toHaveLength(0);

    const refreshing = { ...ctx, refresh: { afterMs: 500 } };
    expect(
      selectExtensions({ extensions: [refreshing], message: second, window: [withPart, second], now: 2000 }),
    ).toHaveLength(1);
    expect(
      selectExtensions({ extensions: [refreshing], message: second, window: [withPart, second], now: 1200 }),
    ).toHaveLength(0);

    // The caller passes the post-compaction window: the old part is out of it.
    expect(selectExtensions({ extensions: [ctx], message: second, window: [second], now: 2000 })).toHaveLength(1);
  });

  it("a structured metadata.extension wins over the text", () => {
    const m = userMessage("/report week", { metadata: { extension: { name: "report", input: { period: "month" } } } });
    const sel = selectExtensions({ extensions: [report], message: m, window: [m], now: 0 });
    expect(sel).toHaveLength(1);
    expect(sel[0].input).toEqual({ period: "month" });
  });

  it("nothing runs for a non-user tail", () => {
    const a = { id: "a", role: "assistant", parts: [{ type: "text", text: "hi" }] } as AppMessage;
    expect(selectExtensions({ extensions: [ctx, report], message: a, window: [a], now: 0 })).toHaveLength(0);
  });
});

describe("a slash extension on a turn", () => {
  it("renders after the user's text, persists the part BEFORE the model runs, and keeps it after onFinish", async () => {
    const { engine, runs } = fakeEngine({ calls: ["clockify_hours"], output: (i) => ({ members: [(i as { args: string }).args] }) });
    let appendsBeforeModel = -1;
    const rt = runtimeWith({ extensions: [report], engine, model: undefined as never });
    // Build the model with access to the storage log so it can record ordering.
    const { model, prompts } = capturingModel("done", () => {
      appendsBeforeModel = rt.log.filter((l) => l === "append:user").length;
    });
    const rt2 = runtimeWith({ extensions: [report], engine, model });
    const { stored } = await turn(rt2, userMessage("/report week"));

    // The model saw the raw text AND the rendered block, in that order.
    expect(prompts).toHaveLength(1);
    const text = userText(prompts[0]);
    expect(text).toContain("/report week");
    expect(text.indexOf("/report week")).toBeLessThan(text.indexOf("Weekly report for week"));
    expect(text).toContain('Weekly report for week: ["week"]');
    // The script got the parsed args.
    expect(runs[0].input).toEqual({ args: "week", argv: ["week"] });
    // Persisted first: the user message was (re)appended before doStream ran.
    void appendsBeforeModel;
    expect(rt2.log.indexOf("append:user")).toBeLessThan(rt2.log.indexOf("append:user,assistant"));
    // ...and onFinish's re-persist kept the part (the in-memory message was swapped).
    const user = stored.find((m) => m.role === "user")!;
    const parts = extPartsOf(user);
    expect(parts).toHaveLength(1);
    expect(parts[0].data).toMatchObject({
      name: "report",
      on: "slash",
      target: "message",
      rendered: 'Weekly report for week: ["week"]',
      calls: [{ tool: "clockify_hours", stepId: "s1" }],
    });
    expect((partsOf(user)[0] as { text: string }).text).toBe("/report week");
    expect(stored.at(-1)?.role).toBe("assistant");
  });

  it("leaves unknown slash text alone and never calls the engine", async () => {
    const { engine, analyzed } = fakeEngine({});
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [report], engine, model });
    const { stored } = await turn(rt, userMessage("/Users/me/notes.txt says hi"));
    expect(analyzed).toHaveLength(0);
    expect(userText(prompts[0])).toBe("/Users/me/notes.txt says hi");
    expect(extPartsOf(stored[0])).toHaveLength(0);
  });

  it("is ignored entirely when the runtime has no script engine", async () => {
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [report], model });
    const { stored } = await turn(rt, userMessage("/report week"));
    expect(userText(prompts[0])).toBe("/report week");
    expect(extPartsOf(stored[0])).toHaveLength(0);
  });

  it("puts a `before` placement ahead of the user's text and renders JSON when there is no template", async () => {
    const { engine } = fakeEngine({ output: () => ({ n: 1 }) });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [{ ...report, template: undefined, placement: "before" }], engine, model });
    await turn(rt, userMessage("/report week"));
    const text = userText(prompts[0]);
    expect(text.indexOf("```json")).toBeLessThan(text.indexOf("/report week"));
    expect(text).toContain('"n": 1');
  });
});

describe("tool mounting", () => {
  it("mounts only executable, ungated, active tools and binds the Latch tool context", async () => {
    const { engine, runs, toolResults } = fakeEngine({
      calls: ["clockify_hours"],
      callTool: { name: "clockify_hours", args: { period: "w" } },
    });
    const { model } = capturingModel();
    const rt = runtimeWith({ extensions: [report], engine, model });
    await turn(rt, userMessage("/report week"));
    expect(runs[0].mounts).toEqual(["clockify_hours"]); // write_page gated, provider_thing has no execute
    const result = toolResults[0] as { period: string; context: string[] };
    expect(result.period).toBe("w");
    expect(result.context).toEqual(expect.arrayContaining(["orgId", "principal", "runtime", "run", "writer"]));
  });

  it("includes gated tools only with allowMutations", async () => {
    const { engine, runs } = fakeEngine({ calls: ["write_page"] });
    const { model } = capturingModel();
    const rt = runtimeWith({ extensions: [{ ...report, allowMutations: true }], engine, model });
    await turn(rt, userMessage("/report week"));
    expect(runs[0].mounts).toEqual(["clockify_hours", "write_page"]);
  });

  it("refuses a script that calls a gated tool, tells the model, and the turn still completes", async () => {
    const { engine, runs } = fakeEngine({ calls: ["write_page"] });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [report], engine, model });
    const { stored } = await turn(rt, userMessage("/report week"));
    expect(runs).toHaveLength(0); // refused at analysis
    const part = extPartsOf(stored[0])[0];
    expect(part.data.error?.code).toBe("gated_tool");
    expect(part.data.rendered).toBeUndefined();
    expect(userText(prompts[0])).toContain('[Extension "report" failed: calls approval-gated tool(s) write_page');
    expect(stored.at(-1)?.role).toBe("assistant");
  });

  it("follows activeTools: an agent's own tools stay mounted under an `enabledTools` restriction (they are capabilities)", async () => {
    const { engine, runs } = fakeEngine({});
    const { model } = capturingModel();
    const rt = runtimeWith({ extensions: [report], engine, model, enabledTools: [] });
    await turn(rt, userMessage("/report week"));
    expect(runs[0].mounts).toEqual(["clockify_hours"]);
  });
});

describe("failure handling", () => {
  it("analyze issues → error part, model proceeds", async () => {
    const { engine, runs } = fakeEngine({ issues: ["line 1: Unknown tool \"foo\""] });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [report], engine, model });
    const { stored } = await turn(rt, userMessage("/report week"));
    expect(runs).toHaveLength(0);
    expect(extPartsOf(stored[0])[0].data.error).toMatchObject({ code: "invalid_script" });
    expect(userText(prompts[0])).toContain("Unknown tool");
  });

  it("a throwing script → error part, model proceeds", async () => {
    const { engine } = fakeEngine({ runThrows: Object.assign(new Error("boom"), { code: "tool_error" }) });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [report], engine, model });
    const { stored } = await turn(rt, userMessage("/report week"));
    expect(extPartsOf(stored[0])[0].data.error).toEqual({ message: "boom", code: "tool_error" });
    expect(prompts).toHaveLength(1);
  });

  it("a hanging script times out via the abort signal", async () => {
    const { engine } = fakeEngine({ hang: true });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [{ ...report, limits: { timeoutMs: 20 } }], engine, model });
    const { stored } = await turn(rt, userMessage("/report week"));
    expect(extPartsOf(stored[0])[0].data.error?.message).toContain("timed out after 20 ms");
    expect(prompts).toHaveLength(1);
  });

  it("onError: fail → the turn errors, no model call, the failed part is persisted", async () => {
    const { engine } = fakeEngine({ issues: ["bad"] });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [{ ...report, onError: "fail" }], engine, model });
    const { stored } = await turn(rt, userMessage("/report week"));
    expect(prompts).toHaveLength(0);
    expect(extPartsOf(stored[0])[0].data.error?.message).toBe("bad");
    const run = [...rt.runs.values()][0];
    expect(run.status).toBe("errored");
    expect(run.error).toContain('Extension "report" failed: bad');
  });
});

describe("chat-start and every-turn across turns", () => {
  const ctx: AgentExtension = {
    name: "ctx",
    on: "chat-start",
    script: "return 1",
    template: "Context block v{{ output.v }}",
    target: "instructions",
    scope: "chat",
  };

  it("chat-start runs once; its instructions block persists on later turns without re-running", async () => {
    let v = 0;
    const { engine, runs } = fakeEngine({ output: () => ({ v: ++v }) });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [ctx], engine, model });
    const { chatId } = await turn(rt, userMessage("hello"));
    await turn(rt, userMessage("again"), chatId);
    expect(runs).toHaveLength(1);
    // Non-caching branch: one joined system message, then the block — both turns.
    for (const p of prompts) {
      const sys = systemMessages(p);
      expect(sys).toHaveLength(2);
      expect(sys[0].content).toContain("You help.");
      expect(sys[1].content).toBe("Context block v1");
    }
    // Nothing rendered into the user turns for an instructions target.
    expect(userText(prompts[1])).toBe("hello\n---\nagain");
  });

  it("scope: turn applies only on the turn that produced it", async () => {
    const { engine } = fakeEngine({ output: () => ({ v: 1 }) });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [{ ...ctx, scope: "turn" }], engine, model });
    const { chatId } = await turn(rt, userMessage("hello"));
    await turn(rt, userMessage("again"), chatId);
    expect(systemMessages(prompts[0])).toHaveLength(2);
    expect(systemMessages(prompts[1])).toHaveLength(1);
  });

  it("with a caching plan the block lands after the unmarked date line, never on the marked prefix", async () => {
    const { engine } = fakeEngine({ output: () => ({ v: 7 }) });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [ctx], engine, model, caching: true });
    await turn(rt, userMessage("hello"));
    const sys = systemMessages(prompts[0]) as Array<{ content: string; providerOptions?: unknown }>;
    expect(sys).toHaveLength(3);
    expect(sys[0].content).toContain("You help.");
    expect(sys[0].providerOptions).toBeDefined();
    expect(sys[1].content).toMatch(/date/i);
    expect(sys[1].providerOptions).toBeUndefined();
    expect(sys[2].content).toBe("Context block v7");
    expect(sys[2].providerOptions).toBeUndefined();
  });

  it("every-turn runs on each chat turn and on a programmatic run, and only the parts drive the prompt", async () => {
    let v = 0;
    const { engine, runs } = fakeEngine({ output: () => ({ v: ++v }) });
    const { model, prompts } = capturingModel();
    const live: AgentExtension = { name: "live", on: "every-turn", script: "return 1", template: "live {{ output.v }}" };
    const rt = runtimeWith({ extensions: [live], engine, model });
    const { chatId } = await turn(rt, userMessage("one"));
    await turn(rt, userMessage("two"), chatId);
    expect(runs).toHaveLength(2);
    // Turn 2's prompt carries BOTH stored parts (history replays turn 1's).
    expect(userText(prompts[1])).toContain("live 1");
    expect(userText(prompts[1])).toContain("live 2");
    await rt.runtime.runAgent({ principal, agent: "helper", prompt: "three" });
    expect(runs).toHaveLength(3);
  });
});

describe("resume", () => {
  it("replays a stored part without calling the engine and renders the identical prompt", async () => {
    const { engine, analyzed } = fakeEngine({});
    const { model, prompts } = capturingModel();
    const history: AppMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "/report week" },
          {
            type: EXTENSION_PART_TYPE,
            id: "ext_1",
            data: {
              name: "report", on: "slash", target: "message", placement: "after", scope: "turn",
              reveal: "command", at: 1, calls: [], rendered: "Weekly report for week: [stored]",
            },
          },
        ],
        metadata: { visibility: "user" },
      } as AppMessage,
    ];
    let row: RunRecord = {
      id: "run_1", chatId: "chat_1", agent: "helper", status: "active", leaseOwner: "node_old",
      leaseExpiresAt: 1, fencingToken: 1, attempt: 1, startedAt: 1000, identity: principal,
    } as RunRecord;
    const appended: AppMessage[][] = [];
    const storage = {
      async reclaimRun() { return row; },
      async listRuns() { return [row]; },
      async loadMessages() { return structuredClone(history); },
      async updateRun(_id: string, patch: Partial<RunRecord>) { row = { ...row, ...patch }; return true; },
      async getRun() { return row; },
      async appendMessages(_c: string, msgs: AppMessage[]) { appended.push(msgs); },
      async heartbeatRun() { return true; },
      async recordUsage() {},
    } as unknown as StorageAdapter<P>;
    const runtime = createRuntime<P, Record<string, never>>({
      storage,
      context: defineContext<P, Record<string, never>>({ build: () => ({}) }),
      agents: { helper: defineAgent(() => ({ model, instructions: "You help.", extensions: [report] })) },
      scripts: engine,
      reconstructPrincipal: (identity) => identity as P,
      durability: { enabled: true, instanceId: "node_a" },
      resolvePromptCaching: () => undefined,
    });
    const outcome = await runtime.resume("run_1");
    expect(outcome?.status).toBe("completed");
    expect(analyzed).toHaveLength(0);
    expect(userText(prompts[0])).toContain("Weekly report for week: [stored]");
    expect(userText(prompts[0])).toContain("/report week");
  });
});

describe("media", () => {
  it("a `files` list becomes file parts the model can read; unsupported media is dropped with a note", async () => {
    const png = Buffer.from("fake-png-bytes").toString("base64");
    const { engine } = fakeEngine({
      output: () => ({
        summary: "two files",
        files: [
          { mediaType: "image/png", data: png, filename: "chart.png" },
          { kind: "media", mediaType: "application/pdf", data: png },
          { mediaType: "text/csv", data: png, filename: "rows.csv" },
        ],
      }),
    });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [{ ...report, template: "{{ output.summary }}" }], engine, model });
    const { stored } = await turn(rt, userMessage("/report week"));
    const part = extPartsOf(stored[0])[0];
    expect(part.data.files?.map((f) => f.mediaType)).toEqual(["image/png", "application/pdf"]);
    expect(part.data.files?.[0].url.startsWith("data:image/png;base64,")).toBe(true);
    expect((part.data.output as Record<string, unknown>).files).toBeUndefined(); // not stored twice
    expect(part.data.rendered).toBe("two files");
    expect(part.data.error?.code).toBe("media_dropped");
    expect(part.data.error?.message).toContain("rows.csv: unsupported media type text/csv");
    const user = prompts[0].find((m) => m.role === "user")!.content as Array<Record<string, unknown>>;
    const files = user.filter((c) => c.type === "file");
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.mediaType)).toEqual(["image/png", "application/pdf"]);
  });

  it("collectFiles enforces the byte cap", () => {
    const big = "A".repeat(Math.ceil((4.5 * 1024 * 1024 * 4) / 3) + 8);
    const r = collectFiles({ files: [{ mediaType: "image/png", data: "abcd" }, { mediaType: "image/png", data: big }] });
    expect(r.files).toHaveLength(1);
    expect(r.dropped[0]).toContain("media cap");
    expect(collectFiles("not an object")).toEqual({ output: "not an object", files: [], dropped: [] });
  });
});

describe("projections", () => {
  const msg = (reveal: "command" | "prompt" | "both"): AppMessage =>
    ({
      id: "u1",
      role: "user",
      parts: [
        { type: "text", text: "/report week" },
        {
          type: EXTENSION_PART_TYPE,
          id: "ext_1",
          data: {
            name: "report", on: "slash", target: "message", placement: "after", scope: "turn", reveal,
            input: { args: "week" }, at: 5, calls: [{ tool: "x", stepId: "s" }], rendered: "SECRET", output: { rows: 3 },
            error: { message: "media dropped: a", code: "media_dropped" },
          },
        },
      ],
      metadata: { visibility: "user" },
    }) as AppMessage;

  it("the client sees only the typed text under reveal: command, everything under prompt/both", () => {
    const [c] = toClientMessages([msg("command")]);
    const d = extPartsOf(c)[0].data as unknown as Record<string, unknown>;
    expect(d).toEqual({ name: "report", on: "slash", target: "message", reveal: "command", at: 5, input: { args: "week" }, error: { message: "media dropped: a" } });
    expect(d.rendered).toBeUndefined();
    expect(extPartsOf(toClientMessages([msg("prompt")])[0])[0].data.rendered).toBe("SECRET");
    expect(extPartsOf(toClientMessages([msg("both")])[0])[0].data.output).toEqual({ rows: 3 });
    // redact is a no-op on messages without parts of ours
    expect(redactExtensionParts([userMessage("x")])[0].parts).toHaveLength(1);
  });

  it("the model projection renders the part into text and strips it", async () => {
    const [m] = applyExtensionParts([msg("command")]);
    expect(partsOf(m).map((p) => p.type)).toEqual(["text", "text"]);
    expect((partsOf(m)[1] as { text: string }).text).toBe("SECRET");
    const model = await toModelMessages([msg("command")]);
    expect(JSON.stringify(model)).toContain("SECRET");
    expect(JSON.stringify(model)).not.toContain(EXTENSION_PART_TYPE);
  });

  it("extensionInstructionBlocks: latest per name, chat scope anywhere, turn scope only on the last user message", () => {
    const part = (name: string, scope: "turn" | "chat", rendered: string): ExtensionPart => ({
      type: EXTENSION_PART_TYPE, id: "x",
      data: { name, on: "chat-start", target: "instructions", placement: "after", scope, reveal: "command", at: 0, calls: [], rendered },
    });
    const u = (id: string, ...parts: ExtensionPart[]) =>
      ({ id, role: "user", parts: [{ type: "text", text: "t" }, ...parts] }) as AppMessage;
    const a = { id: "a", role: "assistant", parts: [{ type: "text", text: "r" }] } as AppMessage;
    expect(
      extensionInstructionBlocks([u("1", part("mode", "chat", "terse"), part("once", "turn", "gone")), a, u("2", part("mode", "chat", "verbose"), part("now", "turn", "here")), a]),
    ).toEqual(["verbose", "here"]);
  });
});

describe("previewExtension", () => {
  it("runs one extension without a model call or persistence and returns its part data", async () => {
    const { engine, runs } = fakeEngine({ calls: ["clockify_hours"], output: (i) => ({ members: [(i as { args: string }).args] }) });
    const { model, prompts } = capturingModel();
    const rt = runtimeWith({ extensions: [report], engine, model });
    const data = await rt.runtime.previewExtension({ agent: "helper", principal, name: "report", text: "/report q3" });
    expect(data.rendered).toBe('Weekly report for q3: ["q3"]');
    expect(runs[0].input).toEqual({ args: "q3", argv: ["q3"] });
    expect(runs[0].mounts).toEqual(["clockify_hours"]);
    expect(prompts).toHaveLength(0);
    expect(rt.log).toHaveLength(0);
    await expect(rt.runtime.previewExtension({ agent: "helper", principal, name: "nope" })).rejects.toThrow(/Unknown extension/);
    // An inline draft runs over the agent's tools without being saved on it.
    const draft = await rt.runtime.previewExtension({
      agent: "helper",
      principal,
      extension: { name: "draft", on: "every-turn", script: "return 1", template: "draft says {{ output.members }}" },
      input: { args: "d" },
    });
    expect(draft.name).toBe("draft");
    expect(draft.rendered).toBe('draft says ["d"]');
    // listExtensions: names/descriptions/triggers only, never the script.
    const listed = await rt.runtime.listExtensions({ agent: "helper", principal });
    expect(listed).toEqual([{ name: "report", on: "slash" }]);
    expect(JSON.stringify(listed)).not.toContain("clockify_hours");
  });

  it("returns the failed part instead of throwing, even with onError: fail", async () => {
    const { engine } = fakeEngine({ issues: ["bad"] });
    const { model } = capturingModel();
    const rt = runtimeWith({ extensions: [{ ...report, onError: "fail" }], engine, model });
    const data = await rt.runtime.previewExtension({ agent: "helper", principal, name: "report", input: { args: "x" } });
    expect(data.error?.message).toBe("bad");
  });
});
