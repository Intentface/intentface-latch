/**
 * The moments, wired into a real turn through `createRuntime`. Ported from the
 * agents-sdk experiment's loop/notices/principal/client-tools suites, which
 * were the specification this seam was built against; the assertions are the
 * same, the runtime underneath is latch's.
 */
import { describe, it, expect } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { defineExtension, type Extension, type StepContext } from "./extension.js";
import { call, harness, principal, promptsOf, runTurn, scripted, text, user } from "../__tests__/turn.js";

const deleteRepo = (onExecute?: (name: string) => void) => ({
  deleteRepo: tool({
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      onExecute?.(name);
      return { deleted: name };
    },
  }),
});

describe("session-scoped context", () => {
  it("reaches the model, is stored on its own message, and never fuses with the reply", async () => {
    const wx = defineExtension("wx", (ext) =>
      ext.context(async () => "Weather: sunny", { scope: "session" }),
    ) as Extension;
    const { stored, prompts } = await runTurn({ model: scripted([text("hello")]), extensions: [wx] });

    const carrier = stored.find((m) => m.parts.some((p) => p.type === "data-ctx-wx"))!;
    expect(carrier).toBeTruthy();
    // The defect this guards: the injected message becoming the response
    // anchor, so the reply merges into the context message.
    expect(carrier.parts.map((p) => p.type)).not.toContain("text");
    expect(stored.at(-1)!.role).toBe("assistant");
    expect(stored.at(-1)!.parts.some((p) => p.type === "text")).toBe(true);
    expect(JSON.stringify(prompts[0])).toContain("Weather: sunny");
  });

  it("is hidden from the customer on load", async () => {
    const wx = defineExtension("wx", (ext) =>
      ext.context(async () => "Weather: sunny", { scope: "session" }),
    ) as Extension;
    const h = harness({ model: scripted([text("hello")]), extensions: [wx] });
    await h.turn(user("hi"));
    const shown = await h.runtime.loadHistory({ chatId: "chat_1", principal });
    expect(JSON.stringify(shown)).not.toContain("Weather: sunny");
    expect(JSON.stringify(shown)).toContain("hello");
  });
});

describe("commands", () => {
  it("a handled command answers without calling the model, and the turn still persists", async () => {
    const stats = defineExtension("stats", (ext) =>
      ext.registerCommand("stats", { description: "show stats", handler: async () => "42 turns" }),
    ) as Extension;
    const model = scripted([text("never")]);
    const { chunks, stored, run, prompts } = await runTurn({ model, extensions: [stats], message: user("/stats") });

    expect(prompts).toHaveLength(0);
    expect(chunks.some((c) => c.type === "text-delta" && c.delta === "42 turns")).toBe(true);
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(stored.at(-1))).toContain("42 turns");
    expect(run.status).toBe("completed");
  });

  it("an expanding command rewrites the prompt and lets the model run", async () => {
    const report = defineExtension("report", (ext) =>
      ext.registerCommand("report", { description: "weekly report", expand: async (args) => `Write the ${args} report.` }),
    ) as Extension;
    const { prompts } = await runTurn({ model: scripted([text("ok")]), extensions: [report], message: user("/report weekly") });
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain("Write the weekly report.");
    expect(JSON.stringify(prompts[0])).not.toContain("/report");
  });
});

describe("tool vetoes and rewrites", () => {
  it("a blocked call never executes and the model is told why", async () => {
    const executed: string[] = [];
    const gate = defineExtension("gate", (ext) =>
      ext.on("tool_call", ({ toolName }) =>
        toolName === "deleteRepo" ? { block: true, reason: "production is protected" } : undefined,
      ),
    ) as Extension;
    const { prompts } = await runTurn({
      model: scripted([call("deleteRepo", '{"name":"api"}'), text("ok")]),
      tools: deleteRepo((n) => executed.push(n)),
      extensions: [gate],
    });
    expect(executed).toEqual([]);
    expect(JSON.stringify(prompts[1])).toContain("production is protected");
  });

  it("tool_result rewrites what is stored and what the model reads — but not the call's arguments", async () => {
    const redact = defineExtension("redact", (ext) =>
      ext.on("tool_result", () => ({ output: { deleted: "[redacted]" } })),
    ) as Extension;
    const { stored, prompts } = await runTurn({
      model: scripted([call("deleteRepo", '{"name":"api"}'), text("ok")]),
      tools: deleteRepo(),
      extensions: [redact],
    });
    expect(JSON.stringify(stored)).toContain("[redacted]");
    expect(JSON.stringify(prompts[1])).toContain("[redacted]");
    const part = stored[1]!.parts.find((p) => p.type === "tool-deleteRepo") as { input: unknown };
    expect(part.input).toEqual({ name: "api" });
  });

  it("an extension-registered tool is callable and always active", async () => {
    let ran = false;
    const clock = defineExtension("clock", (ext) =>
      ext.registerTool("now", tool({ inputSchema: z.object({}), execute: async () => ((ran = true), { t: 1 }) })),
    ) as Extension;
    await runTurn({ model: scripted([call("now"), text("ok")]), extensions: [clock] });
    expect(ran).toBe(true);
  });

  it("progress chunks of a streaming tool survive when only tool_result listens", async () => {
    const seen: unknown[] = [];
    const ticker = {
      ticker: tool({
        inputSchema: z.object({}),
        async *execute() {
          yield { step: 1 };
          yield { step: 2 };
          yield { step: 3 };
        },
      }),
    };
    const watch = defineExtension("watch", (ext) => ext.on("tool_result", ({ output }) => void seen.push(output))) as Extension;
    const { stored } = await runTurn({ model: scripted([call("ticker"), text("ok")]), tools: ticker, extensions: [watch] });
    // The hook fires once, on the final yield — not on every progress value.
    expect(seen).toEqual([{ step: 3 }]);
    const part = stored[1]!.parts.find((p) => p.type === "tool-ticker") as { output: unknown };
    expect(part.output).toEqual({ step: 3 });
  });
});

describe("step control", () => {
  it("step_start stop ends the run before the model is called, storing no empty reply", async () => {
    const budget = defineExtension("budget", (ext) => ext.on("step_start", () => ({ stop: true }))) as Extension;
    const { prompts, stored, run } = await runTurn({ model: scripted([text("never")]), extensions: [budget] });
    expect(prompts).toHaveLength(0);
    expect(stored.map((m) => m.role)).toEqual(["user"]);
    expect(run.status).toBe("completed");
  });

  it("step_start can stop a loop between steps", async () => {
    let allowed = 0;
    const two = defineExtension("two", (ext) =>
      ext.on("step_start", (ctx) => (ctx.stepNumber >= 2 ? { stop: true } : void allowed++)),
    ) as Extension;
    const { prompts } = await runTurn({
      model: scripted([call("now")]), // never stops calling
      tools: { now: tool({ inputSchema: z.object({}), execute: async () => ({ t: 1 }) }) },
      extensions: [two],
    });
    expect(prompts).toHaveLength(2);
    expect(allowed).toBe(2);
  });

  it("notify appends a part the model never sees", async () => {
    const notices = defineExtension("cost", (ext) =>
      ext.notify((info) => `step ${info.stepNumber}: ${info.usage.inputTokens} in`),
    ) as Extension;
    const { stored, prompts } = await runTurn({ model: scripted([text("hello")]), extensions: [notices] });
    expect(JSON.stringify(stored)).toContain("step 0: 12 in");
    expect(JSON.stringify(prompts[0])).not.toContain("12 in");
  });
});

describe("notices", () => {
  const ping = { ping: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
  const twoSteps = () => scripted([call("ping"), text("done")]);

  it("reach the live stream as well as storage, exactly once each", async () => {
    const notes = defineExtension("n", (ext) => ext.notify((info) => `step ${info.stepNumber}`)) as Extension;
    const { chunks, stored, prompts } = await runTurn({ model: twoSteps(), tools: ping, extensions: [notes] });

    const streamed = chunks.filter((c) => c.type === "data-notice-n").map((c) => c.data);
    const inStorage = (stored.at(-1)!.parts as Array<{ type: string; data?: unknown }>)
      .filter((p) => p.type === "data-notice-n")
      .map((p) => p.data);
    expect(streamed).toEqual(["step 0", "step 1"]);
    expect(inStorage).toEqual(["step 0", "step 1"]);
    expect(JSON.stringify(prompts)).not.toContain("step 0");
  });

  it("a notice sits after the step it belongs to", async () => {
    const notes = defineExtension("n", (ext) => ext.notify((info) => `after ${info.stepNumber}`)) as Extension;
    const { stored } = await runTurn({ model: twoSteps(), tools: ping, extensions: [notes] });
    const types = (stored.at(-1)!.parts as Array<{ type: string; data?: unknown }>).map((p) =>
      p.type === "data-notice-n" ? `notice:${p.data}` : p.type,
    );
    const i0 = types.indexOf("notice:after 0");
    const i1 = types.indexOf("notice:after 1");
    // First notice after the tool part and before the second step's start;
    // second notice last.
    expect(i0).toBeGreaterThan(types.indexOf("tool-ping"));
    expect(i0).toBeLessThan(types.lastIndexOf("step-start"));
    expect(i1).toBe(types.length - 1);
  });

  it("a hidden notice never reaches the stream but is still stored", async () => {
    const secret = defineExtension("secret", (ext) => {
      ext.notify(() => "internal only");
      ext.registerRenderer((p) => (p.type === "data-notice-secret" ? { hide: true } : undefined));
    }) as Extension;
    const { chunks, stored } = await runTurn({ model: twoSteps(), tools: ping, extensions: [secret] });
    expect(JSON.stringify(chunks)).not.toContain("internal only");
    expect(JSON.stringify(stored)).toContain("internal only");
  });

  it("a replacement is what streams", async () => {
    const masked = defineExtension("masked", (ext) => {
      ext.notify(() => "raw value");
      ext.registerRenderer((p) =>
        p.type === "data-notice-masked" ? { replace: { type: "data-notice-masked", data: "•••" } } : undefined,
      );
    }) as Extension;
    const { chunks } = await runTurn({ model: twoSteps(), tools: ping, extensions: [masked] });
    expect(JSON.stringify(chunks)).toContain("•••");
    expect(JSON.stringify(chunks)).not.toContain("raw value");
  });

  it("a persisting step_end runs before the next model call", async () => {
    const order: string[] = [];
    const persist = defineExtension("persist", (ext) =>
      ext.on("step_end", async (_m, info) => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(`persisted ${info.stepNumber}`);
      }),
    ) as Extension;
    const model = scripted([call("ping"), text("done")]);
    const origin = model.doStream;
    model.doStream = (async (o: unknown) => {
      order.push(`model call ${order.filter((x) => x.startsWith("model")).length}`);
      return (origin as (o: unknown) => unknown)(o);
    }) as never;
    await runTurn({ model, tools: ping, extensions: [persist] });
    expect(order).toEqual(["model call 0", "persisted 0", "model call 1", "persisted 1"]);
  });
});

describe("identity", () => {
  it("reaches every moment, so extensions cannot disagree about who a run is for", async () => {
    const seen: Record<string, unknown> = {};
    const everywhere = defineExtension("everywhere", (ext) => {
      ext.on("input", (_i, run) => void (seen.input = run.principal));
      ext.on("before_agent_start", (_m, run) => void (seen.before_agent_start = run.principal));
      ext.on("register_tools", (t, run) => ((seen.register_tools = run.principal), t));
      ext.on("tool_call", (_i, run) => void (seen.tool_call = run.principal));
      ext.on("tool_result", (_i, run) => void (seen.tool_result = run.principal));
      ext.on("step_start", (ctx: StepContext) => void (seen.step_start = ctx.principal));
      ext.on("step_end", (_m, info) => void (seen.step_end = info.principal));
      ext.on("agent_end", ({ principal: p }) => void (seen.agent_end = p));
    }) as Extension;
    await runTurn({
      model: scripted([call("whoami"), text("ok")]),
      tools: { whoami: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }) },
      extensions: [everywhere],
    });
    for (const k of ["input", "before_agent_start", "register_tools", "tool_call", "tool_result", "step_start", "step_end", "agent_end"])
      expect(seen[k], k).toEqual(principal);
  });

  it("a per-tenant veto is expressible", async () => {
    let ran = false;
    const policy = defineExtension("policy", (ext) =>
      ext.on("tool_call", (_i, run) =>
        (run.principal as { orgId: string }).orgId === "org_a" ? { block: true, reason: "not on this plan" } : undefined,
      ),
    ) as Extension;
    await runTurn({
      model: scripted([call("whoami"), text("ok")]),
      tools: { whoami: tool({ inputSchema: z.object({}), execute: async () => ((ran = true), { ok: true }) }) },
      extensions: [policy],
    });
    expect(ran).toBe(false);
  });
});

describe("client-side tools", () => {
  /** No `execute`: the browser runs it. */
  const tools = { getTimezone: tool({ description: "Read the browser timezone.", inputSchema: z.object({}) }) };

  it("tool_result fires with source 'client' when the answer arrives, and an override reaches the model", async () => {
    const sources: string[] = [];
    const tz = defineExtension("tz", (ext) =>
      ext.on("tool_result", ({ source, output }) => {
        sources.push(source);
        return source === "client" ? { output: { ...(output as object), normalised: true } } : undefined;
      }),
    ) as Extension;
    const model = scripted([call("getTimezone"), text("Helsinki then.")]);
    const h = harness({ model, tools, extensions: [tz] });
    const first = await h.turn(user("what time is it for me?"));
    // The turn ends with the call unanswered — a client tool is the browser's
    // to run — and nothing has fired yet.
    const pending = first.stored.at(-1)!.parts.find((p) => p.type === "tool-getTimezone") as { state: string };
    expect(pending.state).toBe("input-available");
    expect(sources).toEqual([]);

    const res = await h.runtime.applyToolResult({
      chatId: "chat_1",
      principal,
      toolCallId: "call_1",
      output: { tz: "Europe/Helsinki" },
    });
    await res.text();
    expect(sources).toEqual(["client"]);
    expect(JSON.stringify(promptsOf(model)[1])).toContain('"normalised":true');
    expect([...h.mem.runs.values()].at(-1)!.status).toBe("completed");
  });
});

describe("failure", () => {
  it("a critical extension that throws fails the run; an ordinary one is skipped", async () => {
    const ok = await runTurn({
      model: scripted([text("fine")]),
      extensions: [
        defineExtension("flaky", (ext) =>
          ext.on("step_end", () => {
            throw new Error("boom");
          }),
        ) as Extension,
      ],
    });
    expect(ok.run.status).toBe("completed");

    const bad = await runTurn({
      model: scripted([text("fine")]),
      extensions: [
        defineExtension(
          "db",
          (ext) =>
            ext.on("step_end", () => {
              throw new Error("connection reset");
            }),
          { critical: true },
        ) as Extension,
      ],
    });
    expect(bad.run.status).toBe("errored");
    expect(String(bad.run.error)).toContain("connection reset");
  });
});
