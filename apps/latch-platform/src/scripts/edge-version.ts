/**
 * Edge Eval v0 — (re)write `src/evals/edge/v0/version.json`, the guide's Step-1 version
 * record (guide lines 71-82) plus what makes a run attributable here: the git sha, each
 * variant's `prompt:<sha8>`, and the fixture-tree hash of the client plane.
 *
 *   node --import tsx src/scripts/edge-version.ts
 *
 * Re-run after any prompt edit, plane snapshot, or knowledge-plane re-capture. The
 * vertical-plane block is recorded by hand from orient/read_file (read-only scope, no bulk
 * export) — update it when edge-base changes.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { buildAllVariants } from "../evals/edge/variants";
import { fixtureFiles, planeVersion } from "./edge-plane-snapshot";

const sha = execSync("git rev-parse HEAD").toString().trim();
const variants = Object.fromEntries(
  buildAllVariants().map((v) => [
    v.variant,
    {
      agent: v.name,
      prompt_sha8: v.promptSha8,
      connections: v.record.connections,
      gated_tools: Object.entries(v.record.tools?.approval ?? {})
        .filter(([, gated]) => gated)
        .map(([tool]) => tool),
    },
  ]),
);

const version = {
  edge_version: "v0",
  date: "2026-09-10",
  model: "gpt-5.6-sol",
  reasoning_mode: "provider default (no exec.effort set - same as production)",
  sampling: "provider default, identical in all arms",
  system_prompt_version: {
    source: "src/evals/edge/prompt/edge-v2.prompt.md (tagged; variants are a selection over segments)",
    git_commit_sha: sha,
    captured_production_instructions: "src/evals/edge/v0/edge-v2-instructions.md",
    captured_production_instructions_sha256_prefix: "2254078611ab6cb3",
    variants,
  },
  vertical_context_version: {
    workspace: "edge-base (ws_tRUBqZ-dKZDFalqejsUrs)",
    endpoint: "https://app.loredex.ai/ws_tRUBqZ-dKZDFalqejsUrs/mcp/edge-v2-kn (read-only scope over edge-kn/)",
    files: {
      "edge-kn/kn/agent-infra/playbook.md": { fileId: "file_YKuJz9qctjgR8kUq0v7ax", version: 1, lines: 139 },
      "edge-kn/kn/ax/playbook.md": { fileId: null, version: null, lines: 112 },
      "edge-kn/kn/agentic-coding-practises/playbook.md": { fileId: null, version: null, lines: 56 },
      "edge-kn/kn/insights/playbook.md": { fileId: "file_BHrCQXE5ks_mAUXfghL4J", version: 1, lines: 344 },
      "edge-kn/examples/catalog.md": {
        fileId: "file_Oef_qbntFZVmL3U3NKQRQ",
        version: 2,
        lines: 110,
        defect: "whole catalog duplicated (second H1 at line 58) - fix pending, re-capture after",
      },
    },
    note: "Recorded from orient/read_file on 2026-09-10; no content hash (read-only scope, no bulk export). Re-capture after the catalog dedupe.",
  },
  horizontal_context_version: {
    workspace: "edge-client (ws_7e_rtGs6Hbd0IUAhJ_Pdf) - the live client workspace, used AS IS (no wipe, no reseed)",
    snapshot_tree: "src/evals/edge/fixtures/client-plane/edge/ (read-only snapshot for diffing; never seeded back)",
    sha256: planeVersion(fixtureFiles()),
    snapshot_script: "src/scripts/edge-plane-snapshot.ts (--verify at sweep start and end)",
    client: "TwentyOne (fictional)",
  },
  retrieval_config: "agent-driven: Loredex MCP orient then read_file per turn; no RAG, no injected context beyond the system prompt",
  toolset_version: {
    "edge-client": "26 tools (Loredex full scope); the 6 write tools + create_theme/edit_theme/submit_feedback gated -> inert under blockGated",
    "edge-v2-kn": "17 read tools (scoped; no write tools exist)",
    "edge-v2-inbox": "9 write tools (scoped; no orient/read); all gated -> inert under blockGated",
    provider_web_tools: false,
    blockGated: true,
  },
  memory_config:
    "exec.memory OFF in all arms (production: agent-user on edge-client). Tier-3 under test = the live edge/memory/ notes as they are; writes are inert under blockGated so they cannot grow mid-sweep.",
  notes: [
    "Pre-freeze edits vs production (guide line 84, mechanical failures): E1 deleted the two get_current_date lines (no such tool on the record); E2 rewrote the gap path around edge-v2-inbox_create into edge-inbox/inbox-twentyone (the write-only inbox scope has no orient/read_file; edit_file cannot match an empty gaps file); E3 split Tier-4/precedence clauses so no variant references a plane it lacks.",
    "Deliberate divergences from production, identical across arms: model gpt-5.6-sol (production gpt-5.5) per the guide's Sol Edge; exec.memory off (production on).",
    "Web tools off: production has none and the eval docs are silent (user decision 2026-09-10).",
    "Baseline captured by hand from the production agent editor (no production DB access); see v0/edge-v2-record.json.",
  ],
};

const out = new URL("../evals/edge/v0/version.json", import.meta.url);
writeFileSync(out, JSON.stringify(version, null, 2) + "\n");
console.log(`[version] wrote ${out.pathname} @ ${sha.slice(0, 8)}`);
for (const [v, info] of Object.entries(variants)) console.log(`[version] ${v} prompt:${info.prompt_sha8} ${(info.connections ?? []).join(",") || "-"}`);
