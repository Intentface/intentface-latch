# Code Mode — Build Spec

Let an agent **write JS that orchestrates its own tools** ("code mode"), run it in a
locked-down QuickJS VM, with the **host** executing the real tool calls so
credentials never enter the sandbox. Phased to add durable human approvals.

Validated by spikes (2026-06-26): QuickJS-NG runtime, `latch.call` host bridge,
ambient-denied, killable; and quickjs-wasi snapshot→restore resumes a VM suspended
mid-approval. See memory `agent-code-mode-runtime`.

## Engine decision
Build on **`quickjs-wasi`** (Vercel Labs, QuickJS-NG → WASM, snapshot/restore).
Chosen because we want **snapshot-based** durable approvals and NOT a
replay/deterministic-globals layer — and only quickjs-wasi has snapshots.
It is **experimental + load-bearing**, so:
- vendor + **pin `quickjs.wasm`**; record its version with every snapshot.
- **never import quickjs-wasi outside the `CodeRuntime` module** — keep the engine
  swappable behind the interface.

## `CodeRuntime` seam (engine-agnostic)
```ts
interface CodeRuntime {
  run(opts: {
    code: string;
    tools: ToolBinding[];          // { name, dispatch(argsJson) => Promise<json> }
    caps: { memBytes; timeoutMs; maxCalls; maxResultBytes };
    signal?: AbortSignal;
  }): Promise<CodeResult>;          // { status:"completed"|"paused"|"error", result?, error?, pending?, snapshotRef? }
}
```

## quickjs-wasi implementation
- Lifecycle: `QuickJS.create({ wasm })`; pinned vendored `.wasm`.
- Caps: `memoryLimit` (mem), interrupt handler (timeout), bridge counter (maxCalls).
- Ambient denied by construction (no fetch/process/require); WASI overrides keep
  network/fs off.

## Bridge — host-mediated tool calls
- **Async** (MCP is async): host fn `newPromise()`, kicks the real call via
  `connections.host` under the Principal, returns the deferred handle; guest does
  `await tools.x(args)`; on settle `deferred.resolve(json)` and the runner drives
  `executePendingJobs`/`resolvePromise` until the program settles.
- JSON strings across the boundary (no live handles).
- `truncateResult` per call (`maxResultBytes`): keep small structured, else truncated
  JSON text + size marker.
- Errors return a structured envelope — never throw through the host call.
- Audit: log every call `{ name, argsHash, status }` on the run.

## Tool discovery — `search` / `describe` (NOT inline types)  [Q3, Q5]
The `tools` surface is **discovered at runtime**, not dumped into the prompt:
- `tools.search(query)` → matching tool names + one-line summaries.
- `tools.describe(name)` → generated TS declaration for that tool (from MCP discovery
  / AI-SDK Zod schema via a `generateTypesFromJsonSchema`-style step).
- `tools.<conn>.<method>(input)` → the call.
The `run_code` tool description teaches this search→describe→call workflow (plus maybe
a handful of always-relevant tools). Type-gen still exists — invoked on demand by
`describe`, not inlined. **Discovery API is part of Phase 1.**

## Per-agent toggle  [Q1]
Code mode is **opt-in per agent**. Add `codeMode?: boolean` to the agent definition
(code agents) and the UI agent record (`agentStore` / `latch_agents`). The single
`run_code` tool is added to an agent's toolset **only when `codeMode` is enabled**.

## Capability scoping
`allowedConnections` ⊆ the agent's connections; `search`/`describe` only surface
allowed tools; the bridge re-checks the target at dispatch (a computed name can't
escape scope). No ambient authority; caps enforced host-side.

## Approvals — phased
- **Phase A — boundary (ship first):** approval-flagged tools are **not** discoverable
  in code; they stay top-level tool calls, reusing the existing
  `approval-requested`/`applyApproval` durable pause/resume. The bridge rejects any
  mid-code call to an approval tool ("must be called at top level").
  *(How a tool is flagged approval-required — per-connection vs per-tool — is TBD [Q2];
  the design only needs a predicate `requiresApproval(tool)`.)*
- **Phase B — snapshot mid-code:** at an approval gate → `snapshot()` → serialize →
  gzip → persist (run-keyed, encrypted, TTL) → emit `approval-requested`. On approve →
  `restore` → `registerHostCallback` (re-attach every tool fn by name) → resolve the
  gate → `executePendingJobs`. **One-shot:** delete on resume / terminal / TTL; reaped
  by the existing sweep; per-tenant cap. Snapshot **only at the gate** (MCP calls
  already settled into locals).

## Data model
- **Phase 1–2:** none new — code-mode is ephemeral per turn; calls logged on `latch_runs`.
- **Phase 3:** `latch_code_snapshots` in **libsql for now** (run_id, gzipped blob,
  created_at, expires_at); **move to an object store (Vercel Blob/S3) later** if blobs
  grow. [Q4]
- **Later (tool authoring, out of scope):** `latch_tools` (persist/promote written tools).

## Files
- `packages/core`: `CodeRuntime` interface, `run_code` tool, bridge dispatch +
  scoping + audit + `search`/`describe` (engine-agnostic); `codeMode` on the agent type.
- `apps/latch-platform`: quickjs-wasi impl + vendored `quickjs.wasm`; type-gen from
  `allConnections`; `codeMode` in `agentStore`/editor; snapshot store + sweep hook (P3).

## Phasing
1. **Runtime + bridge + discovery + `run_code`** — run-to-completion, caps, truncation,
   error envelopes, `search`/`describe`, per-agent toggle. No approvals/snapshots.
2. **Boundary approvals** — exclude approval-flagged tools from discovery; reuse
   top-level pause/resume.
3. **Snapshot-on-approval** — mid-code pause/resume (productionize the spike) +
   `latch_code_snapshots` + lifecycle.
4. *(later)* tool authoring (persist/promote + eval gate); Vercel Sandbox npm tier.

## Verification (per phase)
- P1: agent (codeMode on) writes code that `search`→`describe`→`await tools.x()` with
  filter/loop/date logic → correct result; ambient denied; runaway loop killed;
  oversized result truncated; out-of-scope tool rejected; codeMode-off agent has no
  `run_code`.
- P2: approval-flagged action surfaces top-level and pauses/resumes as today; not
  discoverable/callable in code.
- P3: code paused mid-call snapshots, restores in a fresh VM, resumes after approve;
  snapshot deleted on resume; expired snapshot reaped.

## Risks
- quickjs-wasi maturity (load-bearing) → behind `CodeRuntime`, pinned wasm +
  snapshot-format version, drain on upgrade.
- Async host call in-flight at snapshot → snapshot only at the gate.
- Snapshot blob ~100 KB gz/pause → TTL + per-tenant cap.

## Open
- [Q2] approval-required marking mechanism (per-connection flag vs per-tool metadata).
