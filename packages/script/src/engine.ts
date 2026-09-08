import {
  ScriptValidationError,
  analyzeScript,
  parseJsScript,
  scriptEngine,
  tool,
  validateScript,
  type ScriptLimits,
} from "callscript";
import { Liquid, type LiquidOptions } from "liquidjs";
import type {
  ScriptAnalysis,
  ScriptEngine,
  ScriptRunResult,
  ScriptToolMount,
} from "@intentface/latch-core";

/**
 * `@intentface/latch-core`'s `ScriptEngine` seam over callscript + LiquidJS.
 *
 * Why callscript: the author (a person or the Agent Builder) writes a small
 * JavaScript subset — `const h = await clockify_hours({ period: input.args });
 * return { h }` — and callscript PARSES it into an inert JSON plan. Nothing
 * the author wrote executes as code: expressions are a side-effect-free
 * subset (no `new`, no computed callees, no `__proto__`, no globals, no
 * loops), so there is no sandbox to run and the plan validates completely
 * before anything fires — unknown tools, bad arguments and unbound names are
 * all reported at once. The only things that can execute are the tools core
 * mounted, and core has already excluded the approval-gated ones.
 *
 * Why Liquid: templates are sandboxed by construction too (filters only, no
 * code), and `{{ x }}` / `{% for %}` is what people already know.
 *
 * The engine never imports `ai` and knows nothing about Latch tools: core
 * hands it plain mounts whose `execute` is already bound to the turn's
 * context, and takes back plain data.
 */
export interface CreateScriptEngineOptions {
  /** callscript limits (steps, fan-out, total calls, concurrency, result bytes). */
  limits?: Partial<ScriptLimits>;
  /** LiquidJS options. Default: `strictFilters: true` (a typo'd filter is an error, not empty text). */
  liquid?: LiquidOptions;
}

export function createScriptEngine(opts: CreateScriptEngineOptions = {}): ScriptEngine {
  const liquid = new Liquid({ strictFilters: true, ...opts.liquid });

  const analyze: ScriptEngine["analyze"] = (script, { tools }) => {
    try {
      const parsed = typeof script === "string" ? parseSource(script) : script;
      const validated = validateScript(parsed, { tools, ...opts.limits });
      const analysis = analyzeScript(validated);
      return { plan: validated, calls: analysis.tools, issues: [] } satisfies ScriptAnalysis;
    } catch (e) {
      if (e instanceof ScriptValidationError) {
        return { calls: [], issues: e.issues.map((i) => `${i.path}: ${i.message}`) };
      }
      return { calls: [], issues: [messageOf(e)] };
    }
  };

  const run: ScriptEngine["run"] = async (plan, { tools, input, variables, signal }) => {
    const calls: ScriptRunResult["calls"] = [];
    const engine = scriptEngine({
      tools: tools.map((m) => mount(m, calls, signal)),
      ...(opts.limits ? { limits: opts.limits } : {}),
    });
    let result: Awaited<ReturnType<typeof engine.run>>;
    try {
      result = await raceAbort(engine.run({ script: plan, input, variables }), signal);
    } catch (e) {
      if (signal?.aborted) {
        return {
          status: "error",
          steps: {},
          calls,
          error: { message: messageOf(signal.reason ?? e), code: "aborted" },
        };
      }
      throw e;
    }
    const steps: Record<string, unknown> = {};
    for (const [id, s] of Object.entries(result.state.steps)) {
      if (s.output !== undefined) steps[id] = s.output;
    }
    if (result.status === "ok") return { status: "ok", output: result.output, steps, calls };
    if (result.status === "error") {
      return {
        status: "error",
        steps,
        calls,
        error: {
          message: result.error.message,
          ...(result.error.code ? { code: result.error.code } : {}),
          at: result.at,
        },
      };
    }
    return {
      status: "suspended",
      steps,
      calls,
      error: {
        message: `suspended at step ${result.state.at ?? "?"}`,
        code: "suspended",
        ...(result.state.at ? { at: result.state.at } : {}),
      },
    };
  };

  const render: ScriptEngine["render"] = (template, scope) => liquid.parseAndRender(template, scope);

  return { analyze, run, render };
}

/** A JS-subset source, or a JSON plan someone stored as text. */
function parseSource(source: string): unknown {
  const trimmed = source.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not JSON after all — let the JS parser report it.
    }
  }
  return parseJsScript(source);
}

function mount(m: ScriptToolMount, calls: ScriptRunResult["calls"], signal?: AbortSignal) {
  return tool({
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
    ...(m.inputSchema ? { inputSchema: m.inputSchema as never } : {}),
    execute: async (args: unknown, ctx) => {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
      calls.push({ tool: m.name, stepId: ctx.stepId });
      const toolCallId =
        ctx.itemIndex === undefined ? ctx.stepId : `${ctx.stepId}[${ctx.itemIndex}]`;
      return m.execute(args, { stepId: ctx.stepId, toolCallId });
    },
  });
}

/**
 * callscript has no abort signal of its own: settle as soon as the signal
 * fires and let the in-flight run drain in the background (mounts refuse new
 * dispatches once aborted, so it winds down within the current step).
 */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => {});
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
