/**
 * Edge Eval v0 — verification item 6: did the eval's runs and judge scores reach Langfuse?
 *
 *   node --env-file=.env --import tsx src/scripts/edge-langfuse-check.ts [--agent edge-eval-d] [--limit 5]
 *
 * Lists the eval principal's most recent traces for one eval agent with the scores attached
 * (edge_cell from the runner; edge_* dimensions from the judge). Read-only.
 */
import { listOwnerTraces } from "@intentface/latch-langfuse";
import { ownerTagOf } from "../lib/latch";
import { evalPrincipal } from "./edge-connections";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};

async function main() {
  const principal = await evalPrincipal();
  const agent = arg("agent", "edge-eval-d");
  const traces = await listOwnerTraces({ ownerTag: ownerTagOf(principal), agent, limit: Number(arg("limit", "5")) });
  console.log(`[langfuse] ${traces.length} recent traces for ${agent} (owner ${ownerTagOf(principal)})`);
  for (const t of traces) {
    const scores = t.scores.map((s) => `${s.name.replace(/^edge_/, "")}=${s.value}`).join(" ");
    console.log(`[langfuse] ${t.id.slice(0, 12)} run…${t.runId?.slice(-6) ?? "?"} ${new Date(t.timestamp).toISOString().slice(0, 16)} cost=$${t.totalCost?.toFixed(3) ?? "?"} · ${scores || "(no scores)"}`);
  }
}

main()
  .catch((e) => {
    console.error("[langfuse] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 200));
