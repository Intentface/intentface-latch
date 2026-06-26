import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { QuickJS } from "quickjs-wasi";

/**
 * The code-mode runtime: runs a model-written JS program in a locked-down
 * QuickJS-NG VM (via quickjs-wasi), with the HOST executing the real tool calls
 * through a bridge — so credentials never enter the sandbox. Ambient authority
 * is denied by construction (no fetch/process/require); only the injected
 * `tools` global reaches the outside. Engine kept behind this module so it stays
 * swappable (quickjs-wasi is experimental + load-bearing). See docs/CODE_MODE.md.
 */
export interface CodeBridge {
  /** `{ name, input }` JSON → result envelope JSON `{ value }` | `{ error }`. Async (MCP). */
  call(opJson: string): Promise<string>;
  /** query → JSON `[{ name, description }]`. Sync (local schema read). */
  search(query: string): string;
  /** tool name → JSON `{ name, description, inputSchema? }`. Sync. */
  describe(name: string): string;
}

export interface CodeCaps {
  memBytes: number;
  timeoutMs: number;
  maxResultBytes: number;
}

export type CodeResult =
  | { status: "completed"; result: unknown }
  | { status: "error"; error: string };

// The wasm engine is ~1.5MB; load + cache once per process.
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

// Guest-side `tools` shim over the injected host functions. search/describe are
// synchronous; call is async (the host runs the MCP call and resolves it).
const GUEST_SHIM = `
globalThis.tools = {
  search: (q) => JSON.parse(__host_search(String(q == null ? "" : q))),
  describe: (n) => JSON.parse(__host_describe(String(n))),
  call: async (name, input) => {
    const raw = await __host_call(JSON.stringify({ name: String(name), input: input == null ? {} : input }));
    const r = JSON.parse(raw);
    if (r && r.error) throw new Error(r.error);
    return r ? r.value : undefined;
  },
};
`;

function stringifyErr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "message" in v) return String((v as { message: unknown }).message);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Cap result size: small values pass through; large ones become a marked preview. */
function truncate(value: unknown, maxBytes: number): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { __unserializable: true };
  }
  if (json === undefined) return value;
  if (Buffer.byteLength(json) <= maxBytes) return value;
  return { __truncated: true, bytes: Buffer.byteLength(json), preview: json.slice(0, maxBytes) };
}

export async function runCode(
  code: string,
  bridge: CodeBridge,
  caps: CodeCaps,
): Promise<CodeResult> {
  const wasm = await loadWasm();
  const deadline = Date.now() + caps.timeoutMs;
  const vm = await QuickJS.create({
    wasm,
    memoryLimit: caps.memBytes,
    interruptHandler: () => Date.now() > deadline, // kills runaway CPU loops
  });
  try {
    // Sync host fns: search / describe.
    vm.setProp(
      vm.global,
      "__host_search",
      vm.newFunction("__host_search", (a) => vm.newString(bridge.search(String(vm.dump(a))))),
    );
    vm.setProp(
      vm.global,
      "__host_describe",
      vm.newFunction("__host_describe", (a) => vm.newString(bridge.describe(String(vm.dump(a))))),
    );
    // Async host fn: call. Returns a guest promise; the host runs the real tool
    // call and resolves it, then pumps the microtask queue.
    vm.setProp(
      vm.global,
      "__host_call",
      vm.newFunction("__host_call", (a) => {
        const opJson = String(vm.dump(a));
        const d = vm.newPromise();
        Promise.resolve()
          .then(() => bridge.call(opJson))
          .then((res) => d.resolve(vm.newString(res)))
          .catch((e) =>
            d.resolve(vm.newString(JSON.stringify({ error: stringifyErr(e) }))),
          )
          .finally(() => vm.executePendingJobs());
        return d.handle;
      }),
    );

    const program = `${GUEST_SHIM}\nglobalThis.__run = (async () => {\n${code}\n})();`;
    vm.evalCode(program, "code.js"); // throws on syntax error → caught below
    const runHandle = vm.evalCode("globalThis.__run");
    const settled = await vm.resolvePromise(runHandle);
    if ("error" in settled) {
      return { status: "error", error: stringifyErr(vm.dump(settled.error)) };
    }
    return { status: "completed", result: truncate(vm.dump(settled.value), caps.maxResultBytes) };
  } catch (e) {
    return { status: "error", error: stringifyErr(e) };
  } finally {
    try {
      vm.dispose();
    } catch {
      /* already disposed */
    }
  }
}
