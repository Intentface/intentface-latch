import { describe, expect, it } from "vitest";
import type { ScriptToolMount } from "@intentface/latch-core";
import { createScriptEngine } from "./engine.js";

const hours: ScriptToolMount = {
  name: "clockify_hours",
  description: "hours per member",
  inputSchema: {
    type: "object",
    properties: { period: { type: "string" } },
    required: ["period"],
  },
  execute: async (args) => [
    { name: "Anna", total: 38, period: (args as { period: string }).period },
    { name: "Bo", total: 12 },
  ],
};

const now: ScriptToolMount = {
  name: "getCurrentTime",
  execute: async () => ({ iso: "2026-09-08T10:00:00Z" }),
};

const failing: ScriptToolMount = {
  name: "flaky",
  execute: async () => {
    throw Object.assign(new Error("upstream 503"), { code: "upstream" });
  },
};

const engine = createScriptEngine();
const names = [hours.name, now.name, failing.name];

describe("analyze", () => {
  it("accepts bare underscore tool names and reports the distinct calls", () => {
    const a = engine.analyze(
      `const h = await clockify_hours({ period: input.args });
       const t = await getCurrentTime({});
       return { hours: h, at: t.iso };`,
      { tools: names },
    );
    expect(a.issues).toEqual([]);
    expect(a.calls.sort()).toEqual(["clockify_hours", "getCurrentTime"]);
    expect(a.plan).toBeDefined();
  });

  it("refuses unknown tools, unbounded loops and reassignment before anything runs", () => {
    expect(engine.analyze(`const x = await github_list({}); return x;`, { tools: names }).issues[0]).toMatch(
      /Unknown tool "github_list"/,
    );
    expect(engine.analyze(`while (true) {}`, { tools: names }).issues[0]).toMatch(/unbounded loops/);
    const re = engine.analyze(`let x = 1; x = 2; return x;`, { tools: names });
    expect(re.issues.length).toBeGreaterThan(0);
  });

  it("refuses the classic escapes: computed callee, __proto__, globals", () => {
    const attempts = [
      `const h = await clockify_hours({ period: "w" }); return h.constructor.constructor("return process")();`,
      `const h = await clockify_hours({ period: "w" }); return h.__proto__;`,
      `const k = "constr" + "uctor"; const h = await clockify_hours({ period: "w" }); return h[k][k]("return 1")();`,
      `return globalThis;`,
      `return process.env;`,
    ];
    for (const src of attempts) {
      const a = engine.analyze(src, { tools: names });
      expect(a.issues.length, src).toBeGreaterThan(0);
      expect(a.plan, src).toBeUndefined();
    }
  });

  it("takes a JSON plan as an object or as text", () => {
    const plan = { steps: [{ id: "h", call: "clockify_hours", args: { period: "w" } }] };
    expect(engine.analyze(plan, { tools: names }).calls).toEqual(["clockify_hours"]);
    expect(engine.analyze(JSON.stringify(plan), { tools: names }).calls).toEqual(["clockify_hours"]);
  });

  it("never throws: a syntax error is an issue", () => {
    const a = engine.analyze(`const = ;`, { tools: names });
    expect(a.issues.length).toBeGreaterThan(0);
  });
});

describe("run", () => {
  it("executes calls, pure transforms and the return, recording each call", async () => {
    const { plan } = engine.analyze(
      `const h = await clockify_hours({ period: input.args });
       const total = h.reduce((s, x) => s + x.total, 0);
       const t = await getCurrentTime({});
       return { total, names: h.map((x) => x.name), at: t.iso };`,
      { tools: names },
    );
    const r = await engine.run(plan, { tools: [hours, now, failing], input: { args: "week" } });
    expect(r.status).toBe("ok");
    expect(r.output).toEqual({ total: 50, names: ["Anna", "Bo"], at: "2026-09-08T10:00:00Z" });
    expect(r.steps.total).toBe(50);
    expect(r.calls.map((c) => c.tool).sort()).toEqual(["clockify_hours", "getCurrentTime"]);
    expect(r.calls.find((c) => c.tool === "clockify_hours")?.stepId).toBe("h");
  });

  it("maps a failing tool to an error result with its code and step", async () => {
    const { plan } = engine.analyze(`const f = await flaky({}); return f;`, { tools: names });
    const r = await engine.run(plan, { tools: [hours, now, failing] });
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ message: "upstream 503", code: "upstream", at: "f" });
  });

  it("try/catch in the script becomes the error branch", async () => {
    const { plan } = engine.analyze(
      `try { const f = await flaky({}); return f; } catch (e) { return { failed: e.message }; }`,
      { tools: names },
    );
    const r = await engine.run(plan, { tools: [hours, now, failing] });
    expect(r.status).toBe("ok");
    expect(r.output).toEqual({ failed: "upstream 503" });
  });

  it("bounded fan-out runs each item and the mount sees per-item call ids", async () => {
    const seen: string[] = [];
    const echo: ScriptToolMount = {
      name: "echo",
      execute: async (args, ctx) => {
        seen.push(ctx.toolCallId);
        return args;
      },
    };
    const { plan } = engine.analyze(
      `const xs = await Promise.all([1, 2, 3].slice(0, 3).map((n) => echo({ n }))); return xs;`,
      { tools: ["echo"] },
    );
    const r = await engine.run(plan, { tools: [echo] });
    expect(r.status).toBe("ok");
    expect(r.output).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(seen.sort()).toEqual(["xs[0]", "xs[1]", "xs[2]"]);
  });

  it("settles as an aborted error when the signal fires, and refuses further dispatches", async () => {
    let dispatched = 0;
    const slow: ScriptToolMount = {
      name: "slow",
      execute: () => {
        dispatched++;
        return new Promise(() => {});
      },
    };
    const { plan } = engine.analyze(`const a = await slow({}); const b = await slow({}); return b;`, {
      tools: ["slow"],
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("timed out")), 10);
    const r = await engine.run(plan, { tools: [slow], signal: ac.signal });
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "aborted", message: "timed out" });
    expect(dispatched).toBe(1);
  });

});

describe("render", () => {
  it("renders loops, nested access and filters", async () => {
    const out = await engine.render(
      `Hours for {{ input.args }}:
{% for h in output.hours %}- {{ h.name }}: {{ h.total }}h
{% endfor %}Total {{ output.total }} ({{ output.names | join: ", " }})`,
      {
        input: { args: "week" },
        output: { hours: [{ name: "Anna", total: 38 }], total: 38, names: ["Anna", "Bo"] },
      },
    );
    expect(out).toBe("Hours for week:\n- Anna: 38h\nTotal 38 (Anna, Bo)");
  });

  it("an unknown filter is an error (strictFilters), a missing variable is empty", async () => {
    await expect(engine.render(`{{ x | nope }}`, { x: 1 })).rejects.toThrow(/nope/);
    expect(await engine.render(`[{{ missing.deep }}]`, {})).toBe("[]");
  });

  it("cannot call methods or reach outside the scope", async () => {
    await expect(
      engine.render(`{{ x.constructor.constructor("return process")() }}`, { x: {} }),
    ).rejects.toThrow();
  });
});
