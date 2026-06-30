import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { QuickJS } from "quickjs-wasi";
import { transform } from "sucrase";
import { isBlockedHost } from "../web-fetch";

/**
 * The tool-authoring runtime: runs a (human- or agent-) authored JS program in a
 * locked-down QuickJS-NG VM (via quickjs-wasi), returning its `return` value. The
 * program is deterministic compute over two host capabilities:
 *
 *  - `globalThis.input` — the call arguments.
 *  - `globalThis.fetch(url, opts)` — a host-mediated HTTP(S) fetch, restricted to
 *    the tool's declared `allowedHosts` (+ an SSRF block on private/loopback).
 *    Returns `{ ok, status, statusText, headers, text, json }` (json = parsed if
 *    the response is JSON, else null). Credentials never enter the sandbox.
 *
 * Ambient authority is denied by construction (no process/require/raw network);
 * only the injected globals reach the outside. The engine is `quickjs-wasi`
 * (snapshot-capable) so durable pause/resume can be layered on LATER without an
 * engine migration — but this runtime runs to completion, no snapshots.
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

let wasmBytes: Promise<Uint8Array> | undefined;
function loadWasm(): Promise<Uint8Array> {
  if (!wasmBytes) {
    const require = createRequire(import.meta.url);
    let p: string;
    try {
      p = require.resolve("quickjs-wasi/quickjs.wasm");
    } catch {
      p = require.resolve("quickjs-wasi").replace(/dist[\\/].*$/, "quickjs.wasm");
    }
    wasmBytes = readFile(p);
  }
  return wasmBytes;
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
  if (v && typeof v === "object" && "message" in v) return String((v).message);
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
  const validate = (t: URL): string | null => {
    if (t.protocol !== "http:" && t.protocol !== "https:") return "only http(s) URLs are allowed";
    if (isBlockedHost(t.hostname)) return `host "${t.hostname}" is not allowed (private/loopback)`;
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
      const bad = validate(current);
      if (bad) return JSON.stringify({ error: bad });
      res = await fetch(current, {
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
  const wasm = await loadWasm();
  const deadline = Date.now() + caps.timeoutMs;
  const vm = (await QuickJS.create({
    wasm,
    memoryLimit: caps.memBytes,
    interruptHandler: () => Date.now() > deadline,
  }));
  const v = vm as unknown as {
    global: unknown;
    newFunction: (name: string, fn: (a: unknown) => unknown) => unknown;
    setProp: (obj: unknown, key: string, val: unknown) => void;
    newString: (s: string) => unknown;
    newPromise: () => { handle: unknown; resolve: (h: unknown) => void };
    dump: (h: unknown) => unknown;
    evalCode: (code: string, file?: string) => unknown;
    resolvePromise: (h: unknown) => Promise<{ value?: unknown; error?: unknown }>;
    executePendingJobs: () => void;
  };
  // Set once the VM is disposed (on timeout/return) so an in-flight host fetch
  // that settles afterward doesn't call into a freed VM (use-after-free crash).
  let disposed = false;
  try {
    // Host `__host_fetch`: kick the real fetch on a microtask, resolve the
    // guest promise with the JSON envelope, then pump the guest forward.
    const asyncFetch = (a: unknown) => {
      const argJson = String(v.dump(a));
      const d = v.newPromise();
      Promise.resolve()
        .then(() => hostFetch(argJson, allowedHosts, caps))
        .then((res) => {
          if (!disposed) d.resolve(v.newString(res));
        })
        .catch((e) => {
          if (!disposed) d.resolve(v.newString(JSON.stringify({ error: stringifyErr(e) })));
        })
        .finally(() => {
          if (!disposed) v.executePendingJobs();
        });
      return d.handle;
    };
    v.setProp(v.global, "__host_fetch", v.newFunction("__host_fetch", asyncFetch));

    let assigned: string;
    try {
      assigned = compile(code); // TS→JS (also fine for JS) + the `__run` IIFE
    } catch (e) {
      return { status: "error", error: `compile error: ${stringifyErr(e)}` };
    }
    const inputDecl = `globalThis.input = ${JSON.stringify(opts.input ?? null)};\n`;
    const program = `${GUEST_SHIM}${inputDecl}${assigned}`;
    v.evalCode(program, "tool.js");

    // Race the settle against a wall-clock timeout. The VM `interruptHandler`
    // only fires while JS is executing, so it can't break an await-stall (a
    // program that returns a never-settling promise, or a stalled host bridge);
    // this guarantees the run can't hang the request forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("tool run timed out")), caps.timeoutMs + 1000);
      (timer as { unref?: () => void }).unref?.();
    });
    let settled: { value?: unknown; error?: unknown };
    try {
      settled = await Promise.race([v.resolvePromise(v.evalCode("globalThis.__run")), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if ("error" in settled) {
      return { status: "error", error: stringifyErr(v.dump(settled.error)) };
    }
    return { status: "completed", result: truncate(v.dump(settled.value), caps.maxResultBytes) };
  } catch (e) {
    return { status: "error", error: stringifyErr(e) };
  } finally {
    disposed = true; // block any late host-fetch callback from touching the VM
    try {
      (vm as unknown as { dispose?: () => void }).dispose?.();
    } catch {
      /* already disposed */
    }
  }
}
