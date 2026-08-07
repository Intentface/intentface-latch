import { transform } from "sucrase";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import type { QuickJSAsyncWASMModule } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-mjs-release-asyncify";
import { isBlockedHost, isBlockedResolved } from "@intentface/latch-net";
import { pinnedFetch } from "@intentface/latch-net/pinned";

/**
 * The tool-authoring runtime: runs a (human- or agent-) authored JS program in a
 * locked-down QuickJS VM, returning its `return` value. The program is
 * deterministic compute over two host capabilities:
 *
 *  - `globalThis.input` — the call arguments.
 *  - `globalThis.fetch(url, opts)` — a host-mediated HTTP(S) fetch, restricted to
 *    the tool's declared `allowedHosts` (+ an SSRF block on private/loopback).
 *    Returns `{ ok, status, statusText, headers, text, json }` (json = parsed if
 *    the response is JSON, else null). Credentials never enter the sandbox.
 *
 * Ambient authority is denied by construction (no process/require/raw network);
 * only the injected globals reach the outside. Engine: `quickjs-emscripten` with
 * a SINGLEFILE asyncify variant — the wasm is inlined in the JS, so it bundles
 * cleanly on serverless (Vercel) with no runtime file resolution; asyncify lets
 * the async host `fetch` be awaited from the guest. Runs to completion — no
 * snapshots (durable pause/resume is a deferred future, would need a different
 * engine build).
 */

export interface ToolCaps {
  memBytes: number;
  timeoutMs: number;
  /** Cap on the JSON size of the returned value. */
  maxResultBytes: number;
  /** Cap on a single fetch response body (bytes). */
  maxFetchBytes: number;
}

export const DEFAULT_TOOL_CAPS: ToolCaps = {
  memBytes: 64 * 1024 * 1024,
  timeoutMs: 15_000,
  maxResultBytes: 64_000,
  maxFetchBytes: 4 * 1024 * 1024,
};

export type ToolResult =
  | { status: "completed"; result: unknown }
  | { status: "error"; error: string };

export interface ToolRunOpts {
  /** Value exposed to the program as `globalThis.input`. */
  input?: unknown;
  /** Hostnames the program's `fetch` may reach (exact or dot-suffix match). */
  allowedHosts?: string[];
  caps?: ToolCaps;
}

// The wasm is inlined in the variant module → no file resolution. A fresh module
// (and runtime/context) per call keeps each run fully isolated — the asyncify
// build doesn't reliably support reusing one module across sequential contexts.
function newModule(): Promise<QuickJSAsyncWASMModule> {
  return newQuickJSAsyncWASMModuleFromVariant(variant);
}

// Guest-side globals. `fetch` round-trips through the async host fn and reshapes
// the host envelope into a Response-ish object (no streaming/body methods — the
// host already read+capped the body and parsed JSON when applicable).
const GUEST_SHIM = `
globalThis.fetch = async (url, opts) => {
  const raw = await __host_fetch(JSON.stringify({ url: String(url), opts: opts == null ? {} : opts }));
  const r = JSON.parse(raw);
  if (r && r.error) throw new Error(r.error);
  return r;
};
`;

/**
 * Strip TS types (no type-check) and produce the guest program's `__run`
 * assignment. Wrapping in the async IIFE before transpiling makes the authored
 * body's top-level `return`/`await` valid. Throws on a syntax error — surfaced
 * to the author as a tool error.
 */
function compile(code: string): string {
  const wrapped = `globalThis.__run = (async () => {\n${code}\n})();`;
  return transform(wrapped, { transforms: ["typescript"], production: true }).code;
}

function stringifyErr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "message" in v) {
    // undici wraps connect-time failures (incl. the pinned fetch's SSRF
    // block) as `TypeError: fetch failed` with the reason in `cause` —
    // surface it or the block looks like a network blip.
    const cause = (v as { cause?: unknown }).cause;
    const causeMsg =
      cause && typeof cause === "object" && "message" in cause && cause.message
        ? `: ${String(cause.message)}`
        : "";
    return String(v.message) + causeMsg;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(value: unknown, maxBytes: number): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { __unserializable: true };
  }
  // JSON.stringify returns undefined for undefined/function/symbol inputs (the
  // type omits this) — the guard is real at runtime.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (json === undefined) return value;
  if (Buffer.byteLength(json) <= maxBytes) return value;
  return { __truncated: true, bytes: Buffer.byteLength(json), preview: json.slice(0, maxBytes) };
}

/** True if `host` is permitted by the allowlist (exact or `.suffix` match). */
function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const x = a.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return h === x || h.endsWith(`.${x}`);
  });
}

/** Host side of `fetch`: validate against the allowlist + SSRF, fetch, cap, shape. */
async function hostFetch(argJson: string, allowedHosts: string[], caps: ToolCaps): Promise<string> {
  let url: string;
  let opts: { method?: string; headers?: Record<string, string>; body?: string } = {};
  try {
    const parsed = JSON.parse(argJson) as { url: string; opts?: typeof opts };
    url = parsed.url;
    opts = parsed.opts ?? {};
  } catch {
    return JSON.stringify({ error: "bad fetch args" });
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return JSON.stringify({ error: "invalid URL" });
  }
  // Validate a target against protocol + SSRF block + the tool's allowlist.
  // Applied to the INITIAL url AND every redirect hop (see below) — otherwise an
  // allowlisted host could 302 to an internal/loopback address (SSRF).
  //
  // `allowedHosts` is NOT a security boundary here: it is supplied by whoever
  // saves or tests the tool (and is an input of the LLM-callable `test_tool`),
  // so a caller can allowlist a host they control that resolves to a private
  // address. The DNS backstop, not the allowlist, is what closes that.
  const validate = async (t: URL): Promise<string | null> => {
    if (t.protocol !== "http:" && t.protocol !== "https:") return "only http(s) URLs are allowed";
    if (isBlockedHost(t.hostname) || (await isBlockedResolved(t.hostname))) {
      return `host "${t.hostname}" is not allowed (private/loopback)`;
    }
    if (allowedHosts.length === 0 || !hostAllowed(t.hostname, allowedHosts)) {
      return `host "${t.hostname}" is not in this tool's allowedHosts [${allowedHosts.join(", ")}]`;
    }
    return null;
  };

  const signal = AbortSignal.timeout(caps.timeoutMs);
  const MAX_REDIRECTS = 4;
  let res: Response;
  try {
    let current = u;
    for (let hop = 0; ; hop++) {
      const bad = await validate(current);
      if (bad) return JSON.stringify({ error: bad });
      // Pinned fetch: vets addresses inside the connection's own DNS lookup,
      // closing the rebinding gap `validate` alone leaves open.
      res = await pinnedFetch(current, {
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
        body: opts.body,
        signal,
        // Follow redirects MANUALLY so each hop is re-validated against the
        // allowlist + SSRF block before we fetch it.
        redirect: "manual",
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) return JSON.stringify({ error: "too many redirects" });
      try {
        current = new URL(location, current);
      } catch {
        return JSON.stringify({ error: "invalid redirect location" });
      }
    }
  } catch (e) {
    return JSON.stringify({ error: stringifyErr(e) });
  }
  // Reject oversized bodies by declared length BEFORE buffering (avoid OOM),
  // then enforce the cap again on the actual bytes (length may be absent/lying).
  const declared = res.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > caps.maxFetchBytes) {
    return JSON.stringify({ error: `response too large (> ${caps.maxFetchBytes} bytes)` });
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > caps.maxFetchBytes) {
    return JSON.stringify({ error: `response too large (> ${caps.maxFetchBytes} bytes)` });
  }
  const text = new TextDecoder().decode(buf);
  const contentType = res.headers.get("content-type") ?? "";
  let json: unknown = null;
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      json = JSON.parse(text);
    } catch {
      /* leave json null; text still available */
    }
  }
  return JSON.stringify({
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers),
    text,
    json,
  });
}

/** Run an authored program to completion in a fresh sandboxed VM. */
export async function runTool(code: string, opts: ToolRunOpts = {}): Promise<ToolResult> {
  const caps = opts.caps ?? DEFAULT_TOOL_CAPS;
  const allowedHosts = opts.allowedHosts ?? [];

  let assigned: string;
  try {
    assigned = compile(code); // TS→JS (also fine for JS) + the `__run` IIFE
  } catch (e) {
    return { status: "error", error: `compile error: ${stringifyErr(e)}` };
  }

  const mod = await newModule();
  const ctx = mod.newContext();
  const deadline = Date.now() + caps.timeoutMs;
  ctx.runtime.setMemoryLimit(caps.memBytes);
  ctx.runtime.setInterruptHandler(() => Date.now() > deadline);

  try {
    // Host `__host_fetch`: asyncify lets the guest `await` this real async call.
    // It must NEVER reject — Emscripten asyncify can't resume a suspended call
    // whose host promise rejected (it hangs until the wall-clock timeout). So
    // catch everything and always return a string handle (an error envelope).
    const fetchFn = ctx.newAsyncifiedFunction("__host_fetch", async (argHandle) => {
      let resJson: string;
      try {
        const argJson = ctx.getString(argHandle);
        resJson = await hostFetch(argJson, allowedHosts, caps);
      } catch (e) {
        resJson = JSON.stringify({ error: stringifyErr(e) });
      }
      try {
        return ctx.newString(resJson);
      } catch {
        // Context disposed mid-flight (timeout teardown) — the run already
        // returned, so nothing awaits this; return undefined without rejecting.
        return ctx.undefined;
      }
    });
    ctx.setProp(ctx.global, "__host_fetch", fetchFn);
    fetchFn.dispose();

    const inputDecl = `globalThis.input = ${JSON.stringify(opts.input ?? null)};\n`;
    const program = `${GUEST_SHIM}${inputDecl}${assigned}`;

    // Wall-clock timeout guards against an await-stall the interrupt handler
    // can't break (it only fires during JS execution, not while awaiting a host
    // promise) — so a hung fetch/never-settling promise can't run past the cap.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("tool run timed out")), caps.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });

    // Evaluate, then drive the guest's async IIFE to completion: pump pending
    // jobs (executePendingJobs is async when an asyncified host call suspends —
    // await it) until none remain, then read the resolved `__run` value.
    const drive = async (): Promise<ToolResult> => {
      const evalRes = await ctx.evalCodeAsync(program, "tool.js");
      if (evalRes.error) {
        const msg = stringifyErr(ctx.dump(evalRes.error));
        evalRes.error.dispose();
        return { status: "error", error: msg };
      }
      evalRes.value.dispose();

      const runHandle = ctx.getProp(ctx.global, "__run");
      const settledPromise = ctx.resolvePromise(runHandle);
      runHandle.dispose();
      for (let i = 0; i < 1_000_000; i++) {
        const r = ctx.runtime.executePendingJobs() as
          | { value?: number }
          | Promise<unknown>;
        if (typeof (r as Promise<unknown>).then === "function") {
          await r; // asyncified host call suspended — resume after it settles
          continue;
        }
        if (((r as { value?: number }).value ?? 0) === 0) break; // no work left
      }
      const settled = await settledPromise;
      if (settled.error) {
        const msg = stringifyErr(ctx.dump(settled.error));
        settled.error.dispose();
        return { status: "error", error: msg };
      }
      const value = ctx.dump(settled.value);
      settled.value.dispose();
      return { status: "completed", result: truncate(value, caps.maxResultBytes) };
    };

    try {
      return await Promise.race([drive(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    return { status: "error", error: stringifyErr(e) };
  } finally {
    try {
      ctx.dispose();
    } catch {
      /* already disposed */
    }
    try {
      (mod as unknown as { dispose?: () => void }).dispose?.();
    } catch {
      /* already disposed */
    }
  }
}
