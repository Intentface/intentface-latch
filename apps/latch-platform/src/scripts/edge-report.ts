/**
 * Edge Eval v0 — render one sweep (cells + judgments) as a self-contained HTML bench.
 *
 *   node --import tsx src/scripts/edge-report.ts --run demo-3 [--out edge-eval-runs/demo-3/report.html]
 *
 * Reads edge-eval-runs/<run>/{cells.jsonl,judgments.jsonl,summary.json,judge-summary.json}
 * plus the case contracts, embeds them as JSON and renders client-side: a scoreboard of
 * cases × arms, then every case with the four arms side by side — scores, tool calls,
 * both turns, the judge's reasons. No external libraries; fonts from Google Fonts.
 *
 * With --background (default on; --no-background to skip) the page opens with what the
 * answers are grounded against, fetched LIVE through the connections at render time: who
 * the client is (placement summary, market context, constraints, named next rung, AI
 * strategy), what the knowledge plane holds (pillars with their stance titles, peer
 * catalog), what memory the advisor had (note titles), and the rubric. Plane content flows
 * into the published page only — never into the repo.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLatch } from "../lib/latch";
import { CONNECTIONS } from "../evals/edge/variants";
import { DIMENSIONS, PILLAR_FOR } from "../evals/edge/judge/rubric";
import { CTX_FILES, callTool, listMemoryFiles, readViaConnection, stripLineNumbers, withPlanes, type Dynamic } from "../evals/edge/judge/reference";
import { evalPrincipal } from "./edge-connections";
import { CONTRACTS } from "../evals/edge/cases/contracts";
import { QUESTIONS } from "../evals/edge/cases/questions";
import { CANNED_FOLLOWUP } from "../evals/edge/cases/followup";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const RUN = arg("run");
if (!RUN) throw new Error("--run <name> is required");
const DIR = resolve(`edge-eval-runs/${RUN}`);
const OUT = resolve(arg("out") ?? `${DIR}/report.html`);

const jsonl = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const json = (p: string) => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : null);

const WITH_BACKGROUND = !process.argv.includes("--no-background");

/** Pull the section of a markdown doc under `## <heading>` (until the next ## / #). */
function section(md: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$([\\s\\S]*?)(?=^#{1,2}\\s|(?![\\s\\S]))`, "m");
  const m = re.exec(md);
  return m ? m[1]!.trim() : "";
}

interface Background {
  client: { name: string; what: string; summary: string; market: string; constraints: string; aiStrategy: string; nextRung: string };
  pillars: Array<{ pillar: string; category: string; stances: string[] }>;
  peers: string[];
  memory: string[];
  rubric: Array<{ name: string; kind: string; target: string; criterion: string }>;
}

async function loadBackground(): Promise<Background | null> {
  if (!WITH_BACKGROUND) return null;
  const principal = await evalPrincipal();
  const { dynamic } = await getLatch();
  return withPlanes(dynamic as unknown as Dynamic, principal, async (client, kn) => {
    const read = (f: string) => readViaConnection(client, `${CONNECTIONS.client}_read_file`, f);
    const placement = await read(CTX_FILES[0]!);
    const strategy = await read(CTX_FILES[1]!);
    const product = await read(CTX_FILES[2]!);
    const memoryFiles = await listMemoryFiles(client);
    const memory: string[] = [];
    for (const f of memoryFiles) {
      const txt = await read(f);
      memory.push(...[...txt.matchAll(/^# (.+)$/gm)].map((m) => m[1]!.trim()));
    }
    const pillars: Background["pillars"] = [];
    for (const [category, pillar] of Object.entries(PILLAR_FOR)) {
      const txt = await readViaConnection(kn, `${CONNECTIONS.kn}_read_file`, `edge-kn/kn/${pillar}/playbook.md`);
      const stances = [...txt.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim()).filter((h) => !/^(Article candidates|Open questions|What to avoid|Sources|Needs decision|Needs redaction|Not covered yet)/i.test(h));
      pillars.push({ pillar, category, stances });
    }
    const catalog = await readViaConnection(kn, `${CONNECTIONS.kn}_read_file`, "edge-kn/examples/catalog.md");
    const peers = [...new Set([...catalog.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1]!.trim()))];
    const orientKn = stripLineNumbers(await callTool(kn, `${CONNECTIONS.kn}_orient`, {}));
    void orientKn;
    return {
      client: {
        name: (/^# (.+?) — /m.exec(placement)?.[1] ?? "the client").trim(),
        what: section(product, "What it is"),
        summary: section(placement, "Summary"),
        market: section(placement, "Market context"),
        constraints: section(strategy, "Funding and constraints"),
        aiStrategy: section(strategy, "AI strategy"),
        nextRung: section(placement, "The named next rung"),
      },
      pillars,
      peers,
      memory,
      rubric: DIMENSIONS.map((d) => ({ name: d.name, kind: d.kind, target: d.target, criterion: d.criterion.split("\n")[0]! })),
    };
  });
}

const cells = jsonl(`${DIR}/cells.jsonl`).filter((c) => !c.error);
const judgments = jsonl(`${DIR}/judgments.jsonl`);
const summary = json(`${DIR}/summary.json`);
const judgeSummary = json(`${DIR}/judge-summary.json`);
const caseIds = [...new Set(cells.map((c) => c.case_id as string))];
async function main() {
const background = await loadBackground().catch((e) => {
  console.warn(`[report] background skipped: ${(e as Error).message}`);
  return null;
});
const data = {
  run: RUN,
  background,
  summary,
  judgeSummary,
  cases: caseIds.map((id) => {
    const q = QUESTIONS.find((x) => x.id === id)!;
    const contract = CONTRACTS.find((c) => c.case_id === id) ?? null;
    return { id, category: q.category, author: q.author, question: q.text, followup: q.followup ?? CANNED_FOLLOWUP, contract };
  }),
  cells,
  judgments,
};

const html = `<title>Edge Ablation Bench</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root {
  color-scheme: light;
  --ground: #f6f7f9; --surface: #ffffff; --surface-2: #eef0f4; --ink: #15181d; --ink-2: #5a6270; --ink-3: #8a919c; --rule: #dfe3ea;
  --arm-A: #2a78d6; --arm-B: #eb6834; --arm-C: #1baf7a; --arm-D: #4a3aa7;
  --good: #008300; --bad: #e34948; --good-bg: #e8f4e8; --bad-bg: #fbeaea; --warn-bg: #fff4dc; --warn: #8a5a00;
  --display: "Fraunces", Georgia, "Times New Roman", serif;
  --body: "Source Sans 3", "Segoe UI", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --ground: #15171b; --surface: #1f2228; --surface-2: #272b33; --ink: #f2f3f5; --ink-2: #a7adb8; --ink-3: #737b88; --rule: #2e333b;
    --arm-A: #3987e5; --arm-B: #d95926; --arm-C: #199e70; --arm-D: #9085e9;
    --good: #4fbf4f; --bad: #e66767; --good-bg: #1d2e1d; --bad-bg: #3a2222; --warn-bg: #3a3020; --warn: #e0b45c;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --ground: #15171b; --surface: #1f2228; --surface-2: #272b33; --ink: #f2f3f5; --ink-2: #a7adb8; --ink-3: #737b88; --rule: #2e333b;
  --arm-A: #3987e5; --arm-B: #d95926; --arm-C: #199e70; --arm-D: #9085e9;
  --good: #4fbf4f; --bad: #e66767; --good-bg: #1d2e1d; --bad-bg: #3a2222; --warn-bg: #3a3020; --warn: #e0b45c;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 16px/1.5 var(--body); padding-block: 32px 64px; padding-inline: 20px; }
a { color: inherit; }
.wrap { max-width: 1280px; margin: 0 auto; display: flex; flex-direction: column; gap: 40px; }
h1, h2, h3 { font-family: var(--display); font-weight: 500; margin: 0; text-wrap: balance; letter-spacing: -0.01em; }
h1 { font-size: clamp(30px, 4vw, 44px); line-height: 1.05; }
h2 { font-size: 24px; }
h3 { font-size: 17px; font-weight: 600; font-family: var(--body); }
.eyebrow { font: 600 12px/1 var(--body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
.mono { font-family: var(--mono); font-size: 0.86em; }
.tabnum { font-variant-numeric: tabular-nums; }

header .lede { color: var(--ink-2); max-width: 65ch; margin-top: 10px; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px 24px; margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--rule); }
.facts dt { font-size: 12px; color: var(--ink-3); letter-spacing: 0.04em; text-transform: uppercase; }
.facts dd { margin: 2px 0 0; font-family: var(--mono); font-size: 14px; }
.arms { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 14px; }
.arm-key { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--ink-2); }
.swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.swatch.A { background: var(--arm-A); } .swatch.B { background: var(--arm-B); } .swatch.C { background: var(--arm-C); } .swatch.D { background: var(--arm-D); }

/* background */
.bg { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.bg .panel { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 16px 18px; font-size: 14px; min-width: 0; }
.bg .panel.wide { grid-column: 1 / -1; }
.bg h3 { margin-bottom: 8px; }
.bg .prose { color: var(--ink-2); max-width: 70ch; } .bg .prose p { margin: 0 0 8px; } .bg .prose b { color: var(--ink); }
.bg ul { margin: 0; padding-left: 18px; color: var(--ink-2); } .bg li { margin: 3px 0; }
.bg .pill-row { display: flex; flex-wrap: wrap; gap: 6px; }
.bg .rubric { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 13px; }
.bg .rubric .k { font-family: var(--mono); font-size: 12px; color: var(--ink); white-space: nowrap; }
.bg .rubric .d { color: var(--ink-2); }
.howto { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 22px; font-size: 14px; color: var(--ink-2); }
.howto b { color: var(--ink); }
/* scoreboard */
.board { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; overflow-x: auto; }
.board table { width: 100%; border-collapse: collapse; min-width: 720px; }
.board th, .board td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--rule); vertical-align: top; }
.board thead th { font: 600 12px/1.2 var(--body); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); background: var(--surface-2); }
.board tbody tr:last-child td { border-bottom: 0; }
.board td.case { width: 26%; }
.board td.case .q { color: var(--ink-2); font-size: 14px; margin-top: 2px; }
.meter { display: flex; gap: 2px; height: 10px; width: 100%; max-width: 220px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }
.meter span { display: block; height: 100%; opacity: 0.9; }
.meter span:nth-child(1) { opacity: 1; } .meter span:nth-child(2) { opacity: .8; } .meter span:nth-child(3) { opacity: .6; } .meter span:nth-child(4) { opacity: .42; }
.score-line { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.score-line b { font-family: var(--mono); font-size: 18px; font-weight: 500; }
.chip { display: inline-flex; align-items: center; gap: 5px; font: 600 11px/1 var(--body); letter-spacing: 0.04em; text-transform: uppercase; padding: 4px 8px; border-radius: 999px; }
.chip.pass { background: var(--good-bg); color: var(--good); } .chip.fail { background: var(--bad-bg); color: var(--bad); } .chip.hf { background: var(--warn-bg); color: var(--warn); text-transform: none; letter-spacing: 0; font-weight: 600; }
.chip.neutral { background: var(--surface-2); color: var(--ink-2); }

/* case sections */
.case-head { display: grid; grid-template-columns: 1fr; gap: 10px; }
.case-head .q { font-family: var(--display); font-size: 22px; line-height: 1.3; font-weight: 500; max-width: 70ch; }
.case-head .fu { color: var(--ink-2); max-width: 70ch; }
.contract { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 16px 18px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px 28px; font-size: 14px; }
.contract h4 { margin: 0 0 6px; font: 600 12px/1 var(--body); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); }
.contract ul { margin: 0; padding-left: 18px; color: var(--ink-2); } .contract li { margin: 2px 0; }
.arms-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
@media (max-width: 1000px) { .arms-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .arms-grid { grid-template-columns: 1fr; } }
.arm { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 0 16px 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; border-top: 4px solid var(--arm-color); }
.arm .title { display: flex; justify-content: space-between; align-items: baseline; padding-top: 12px; }
.arm .title h3 { color: var(--arm-color); }
.arm .title .composite { font-family: var(--mono); font-size: 22px; font-weight: 500; }
.dims { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: center; font-size: 13px; }
.dims .lbl { color: var(--ink-2); }
.dims .bar { height: 8px; background: var(--surface-2); border-radius: 3px; overflow: hidden; } .dims .bar i { display: block; height: 100%; background: var(--arm-color); }
.dims .v { font-family: var(--mono); font-size: 12px; }
.bins { display: flex; flex-wrap: wrap; gap: 6px; }
.tools { font-family: var(--mono); font-size: 12px; color: var(--ink-2); display: flex; flex-direction: column; gap: 2px; }
.tools .t { display: flex; gap: 8px; align-items: baseline; } .tools .turn { color: var(--ink-3); width: 2ch; } .tools .inert { color: var(--warn); font-size: 11px; }
.tools .write { color: var(--ink); font-weight: 500; }
details { border-top: 1px solid var(--rule); padding-top: 10px; }
details summary { cursor: pointer; font: 600 13px/1.4 var(--body); color: var(--ink-2); list-style: none; display: flex; justify-content: space-between; }
details summary::after { content: "+"; font-family: var(--mono); color: var(--ink-3); } details[open] summary::after { content: "–"; }
details summary:focus-visible { outline: 2px solid var(--arm-color); outline-offset: 2px; border-radius: 4px; }
.answer { font-size: 14px; line-height: 1.55; color: var(--ink); margin-top: 8px; max-width: 65ch; }
.answer p { margin: 0 0 10px; } .answer ul, .answer ol { margin: 0 0 10px; padding-left: 20px; } .answer h1, .answer h2, .answer h3, .answer h4 { font: 600 14px/1.4 var(--body); margin: 14px 0 6px; letter-spacing: 0; } .answer code { font-family: var(--mono); font-size: 0.9em; background: var(--surface-2); padding: 0 4px; border-radius: 3px; } .answer blockquote { margin: 0 0 10px; padding-left: 12px; border-left: 2px solid var(--rule); color: var(--ink-2); }
.reasons { font-size: 13px; color: var(--ink-2); margin-top: 8px; display: grid; gap: 8px; } .reasons b { color: var(--ink); font-weight: 600; }
.small { font-size: 13px; color: var(--ink-3); }
.note { background: var(--surface-2); border-radius: 8px; padding: 12px 16px; font-size: 14px; color: var(--ink-2); max-width: 80ch; }
@media (prefers-reduced-motion: no-preference) { details .answer { animation: fade .18s ease-out; } @keyframes fade { from { opacity: .4 } to { opacity: 1 } } }
</style>
<div class="wrap" id="app"></div>
<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>
const D = JSON.parse(document.getElementById("data").textContent);
const ARMS = ["A","B","C","D"];
const ARM_NAME = { A: "A · prompt only", B: "B · client plane", C: "C · knowledge plane", D: "D · full Edge" };
const SCALED = ["decision_quality","client_specificity","expert_stance_fidelity","stage_calibration"];
const DIM_LABEL = { decision_quality: "Decision quality", client_specificity: "Client specificity", expert_stance_fidelity: "Stance fidelity", stage_calibration: "Stage calibration", grounding: "Grounded", actionability: "Actionable", decisiveness: "Decisive", first_turn_quality: "Turn 1 short" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const inline = (s) => esc(s).replace(/\\*\\*(.+?)\\*\\*/g, "<b>$1</b>").replace(/\\*(.+?)\\*/g, "<i>$1</i>").replace(/\`([^\`]+)\`/g, "<code>$1</code>");
function md(text) {
  const lines = String(text ?? "").split("\\n"); const out = []; let list = null; let para = [];
  const flushP = () => { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } };
  const flushL = () => { if (list) { out.push("<" + list.tag + ">" + list.items.map((i) => "<li>" + inline(i) + "</li>").join("") + "</" + list.tag + ">"); list = null; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!l.trim()) { flushP(); flushL(); continue; }
    const h = /^(#{1,4})\\s+(.*)/.exec(l); if (h) { flushP(); flushL(); out.push("<h" + Math.min(4, h[1].length + 2) + ">" + inline(h[2]) + "</h" + Math.min(4, h[1].length + 2) + ">"); continue; }
    const ul = /^\\s*[-*•]\\s+(.*)/.exec(l); const ol = /^\\s*\\d+[.)]\\s+(.*)/.exec(l);
    if (ul || ol) { flushP(); const tag = ul ? "ul" : "ol"; if (!list || list.tag !== tag) { flushL(); list = { tag, items: [] }; } list.items.push((ul || ol)[1]); continue; }
    if (/^>\\s?/.test(l)) { flushP(); flushL(); out.push("<blockquote>" + inline(l.replace(/^>\\s?/, "")) + "</blockquote>"); continue; }
    if (list && /^\\s{2,}/.test(raw)) { list.items[list.items.length - 1] += " " + l.trim(); continue; }
    flushL(); para.push(l.trim());
  }
  flushP(); flushL(); return out.join("");
}
const cellOf = (id, v) => D.cells.find((c) => c.case_id === id && c.variant === v);
const judgOf = (id, v) => D.judgments.find((j) => j.case_id === id && j.variant === v);
const money = (n) => n == null ? "–" : "$" + n.toFixed(2);
const secs = (ms) => ms == null ? "–" : (ms / 1000).toFixed(0) + "s";
const chip = (cls, text) => '<span class="chip ' + cls + '">' + esc(text) + "</span>";
const meter = (j, arm) => { if (!j) return '<div class="meter"></div>'; return '<div class="meter" title="' + SCALED.map((d) => DIM_LABEL[d] + " " + (j.scores[d] ?? "–") + "/3").join(" · ") + '">' + SCALED.map((d) => '<span style="width:' + ((j.scores[d] ?? 0) / 12 * 100) + '%;background:var(--arm-' + arm + ')"></span>').join("") + "</div>"; };

function header() {
  const s = D.summary || {}; const js = D.judgeSummary || {};
  const cost = D.cells.reduce((a, c) => a + (c.turn1.cost || 0) + (c.turn2.cost || 0), 0);
  const plane = s.horizontal_ctx_version || {};
  return '<header>' +
    '<div class="eyebrow">Edge Eval v0 · run ' + esc(D.run) + '</div>' +
    '<h1 style="margin-top:8px">Edge Ablation Bench</h1>' +
    '<p class="lede">The same question asked four ways: a prompt-only advisor, the client context plane alone, the knowledge plane alone, and the full Edge. Each cell is two turns — the question, then the canned follow-up — scored by Judge v0 against the case contract. Writes were attempted and left inert; the client workspace hash was identical before and after.</p>' +
    '<div class="arms">' + ARMS.map((a) => '<span class="arm-key"><span class="swatch ' + a + '"></span>' + esc(ARM_NAME[a]) + '</span>').join("") + '</div>' +
    '<dl class="facts">' +
      fact("app model", s.model) + fact("judge", js.judge_model) + fact("cells", D.cells.length + " · " + (s.reps || 1) + " rep") + fact("run cost", money(cost)) +
      fact("client plane", plane.unchanged === false ? "CHANGED" : (plane.before || "").slice(0, 12) + (plane.unchanged ? " · unchanged" : "")) +
      fact("prompts", ARMS.map((a) => a + ":" + ((s.variants || {})[a] || {}).prompt_sha8).join(" ")) +
    '</dl></header>';
}
const fact = (k, v) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v ?? "–") + '</dd></div>';

function board() {
  return '<section><div class="eyebrow">Scoreboard</div><h2 style="margin:6px 0 14px">Composite by case and arm</h2>' +
    '<div class="board"><table><thead><tr><th>Case</th>' + ARMS.map((a) => '<th><span class="swatch ' + a + '" style="vertical-align:-1px;margin-right:6px"></span>' + esc(ARM_NAME[a]) + '</th>').join("") + '</tr></thead><tbody>' +
    D.cases.map((k) => '<tr><td class="case"><a href="#case-' + esc(k.id) + '" class="mono" style="text-decoration:none;font-weight:500">' + esc(k.id) + '</a><div class="q">' + esc(k.question) + '</div></td>' +
      ARMS.map((a) => { const j = judgOf(k.id, a); const c = cellOf(k.id, a);
        if (!c) return '<td class="small">not run</td>';
        return '<td><div class="score-line"><b class="tabnum">' + (j ? j.composite : "–") + '<span class="small">/12</span></b>' + (j ? chip(j.overall_pass ? "pass" : "fail", j.overall_pass ? "pass" : "fail") : "") + '</div>' + meter(j, a) +
          (j && j.hard_failure !== "none" ? '<div style="margin-top:8px">' + chip("hf", j.hard_failure.replace(/_/g, " ")) + '</div>' : "") + '</td>'; }).join("") + '</tr>').join("") +
    '</tbody></table></div>' +
    '<p class="small" style="margin:10px 2px 0">Bar = the four 0–3 dimensions stacked (decision quality, client specificity, stance fidelity, stage calibration), 12 max. Pass = all binaries pass, every dimension ≥ 2, no hard failure.</p></section>';
}

function caseSection(k) {
  const con = k.contract;
  return '<section id="case-' + esc(k.id) + '"><div class="case-head"><div class="eyebrow">' + esc(k.category) + ' · ' + esc(k.id) + ' · asked by ' + esc(k.author) + (con ? ' · persona ' + esc(con.persona) : "") + '</div>' +
    '<div class="q">' + esc(k.question) + '</div><div class="fu"><span class="eyebrow" style="margin-right:8px">follow-up</span>' + esc(k.followup) + '</div></div>' +
    (con ? '<div class="contract" style="margin-top:14px"><div style="grid-column:1/-1"><h4>Why this case exists</h4><div style="color:var(--ink-2)">' + esc(con.why_this_case_exists) + '</div></div>' +
      cl("Required client facts", con.required_client_facts) + cl("Required expert ideas", con.required_expert_ideas) + cl("Expected shape", con.expected_recommendation_shape) + cl("Forbidden", con.forbidden_behaviors) + '</div>' : '<p class="note">No contract for this case (pilot-only question): judged on the rubric alone.</p>') +
    '<div class="arms-grid" style="margin-top:14px">' + ARMS.map((a) => armCard(k, a)).join("") + '</div></section>';
}
const cl = (title, items) => '<div><h4>' + esc(title) + '</h4><ul>' + items.map((i) => '<li>' + esc(i) + '</li>').join("") + '</ul></div>';

function armCard(k, a) {
  const c = cellOf(k.id, a); const j = judgOf(k.id, a);
  if (!c) return '<div class="arm" style="--arm-color:var(--arm-' + a + ')"><div class="title"><h3>' + esc(ARM_NAME[a]) + '</h3></div><p class="small">not run</p></div>';
  const tools = c.tool_calls.map((t) => { const isWrite = /_(create|edit_file|write_db|add_comment|add_link|share_file)$/.test(t.tool); return '<div class="t"><span class="turn">t' + t.turn + '</span><span class="' + (isWrite ? "write" : "") + '">' + esc(t.tool) + '</span>' + (t.blocked ? '<span class="inert">inert</span>' : "") + '</div>'; }).join("") || '<div class="t small">no tool calls</div>';
  const bins = j ? ["grounding","actionability","decisiveness","first_turn_quality"].map((d) => chip(j.passes[d] ? "pass" : "fail", DIM_LABEL[d])).join("") : "";
  return '<div class="arm" style="--arm-color:var(--arm-' + a + ')">' +
    '<div class="title"><h3>' + esc(ARM_NAME[a]) + '</h3>' + (j ? '<span class="composite tabnum">' + j.composite + '<span class="small">/12</span></span>' : "") + '</div>' +
    (j ? '<div class="dims">' + SCALED.map((d) => '<span class="lbl">' + DIM_LABEL[d] + '</span><span class="bar"><i style="width:' + ((j.scores[d] ?? 0) / 3 * 100) + '%"></i></span><span class="v tabnum">' + (j.scores[d] ?? "–") + '/3</span>').join("") + '</div>' : '<p class="small">not judged</p>') +
    (j ? '<div class="bins">' + bins + (j.hard_failure !== "none" ? chip("hf", "hard: " + j.hard_failure.replace(/_/g, " ")) : chip("neutral", "no hard failure")) + '</div>' : "") +
    '<div class="small mono tabnum">' + secs((c.turn1.latencyMs || 0) + (c.turn2.latencyMs || 0)) + ' · ' + money((c.turn1.cost || 0) + (c.turn2.cost || 0)) + ' · ' + ((c.turn1.usage?.inputTokens || 0) + (c.turn2.usage?.inputTokens || 0)).toLocaleString() + ' in / ' + ((c.turn1.usage?.outputTokens || 0) + (c.turn2.usage?.outputTokens || 0)).toLocaleString() + ' out</div>' +
    '<div><div class="eyebrow" style="margin-bottom:6px">Tool calls</div><div class="tools">' + tools + '</div></div>' +
    '<details open><summary>Turn 1 — clarifier</summary><div class="answer">' + md(c.turn1.answer) + '</div></details>' +
    '<details><summary>Turn 2 — recommendation <span class="small">' + c.turn2.answerChars.toLocaleString() + ' chars</span></summary><div class="answer">' + md(c.turn2.answer) + '</div></details>' +
    (j ? '<details><summary>Judge reasons</summary><div class="reasons">' + Object.entries(j.reasons).map(([d, r]) => '<div><b>' + esc(DIM_LABEL[d] || d) + '</b> — ' + esc(r) + '</div>').join("") + '</div></details>' : "") +
    '</div>';
}

function background() {
  const B = D.background;
  const howto = '<section><div class="eyebrow">How to read this</div><h2 style="margin:6px 0 14px">One question, four advisors, one judge</h2><div class="howto">' +
    '<div><b>The four arms</b> share the same model, prompt craft and settings. They differ only in which planes they can reach and the prompt sections that go with them: A has neither, B the client context, C the knowledge plane, D both plus the gap inbox.</div>' +
    '<div><b>Two turns per cell.</b> Edge answers a first question with a short clarifier, then gets the same canned follow-up ("yes, that direction — full recommendation now"). The recommendation is what is judged; the clarifier is judged separately for brevity.</div>' +
    '<div><b>Writes are inert.</b> Memory notes and gap notes are attempted (you can see the calls) but never reach a workspace; the client plane is hashed before and after every sweep.</div>' +
    '<div><b>Judge v0</b> is a Claude model, one call per rubric dimension, given the client plane, the category pillar, the peer catalog and the case contract. It is not yet calibrated against human reviewers.</div>' +
    '</div></section>';
  if (!B) return howto;
  const prose = (t) => '<div class="prose">' + md(t) + '</div>';
  return howto + '<section><div class="eyebrow">What the answers are grounded against</div><h2 style="margin:6px 0 14px">The client, the knowledge plane, the memory</h2><div class="bg">' +
    '<div class="panel wide"><h3>' + esc(B.client.name) + ' — the client (horizontal plane)</h3>' + prose(B.client.what) + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px 24px;margin-top:8px">' +
      '<div><div class="eyebrow" style="margin-bottom:4px">Placement</div>' + prose(B.client.summary) + '</div>' +
      '<div><div class="eyebrow" style="margin-bottom:4px">Market</div>' + prose(B.client.market) + '</div>' +
      '<div><div class="eyebrow" style="margin-bottom:4px">Constraints</div>' + prose(B.client.constraints) + '</div>' +
      '<div><div class="eyebrow" style="margin-bottom:4px">AI strategy</div>' + prose(B.client.aiStrategy) + '</div>' +
      '<div style="grid-column:1/-1"><div class="eyebrow" style="margin-bottom:4px">The named next rung</div>' + prose(B.client.nextRung) + '</div></div></div>' +
    B.pillars.map((p) => '<div class="panel"><h3>' + esc(p.category) + ' → <span class="mono">' + esc(p.pillar) + '</span></h3><div class="small" style="margin-bottom:6px">Stances of IF (knowledge plane, Tier 1)</div><ul>' + p.stances.map((st) => '<li>' + esc(st) + '</li>').join("") + '</ul></div>').join("") +
    '<div class="panel"><h3>Peer examples the advisor may cite</h3><ul>' + B.peers.map((x) => '<li>' + esc(x) + '</li>').join("") + '</ul></div>' +
    '<div class="panel"><h3>Engagement memory (Tier 3)</h3><div class="small" style="margin-bottom:6px">Prior exchanges on file — only B and D can read these</div><ul>' + B.memory.map((x) => '<li>' + esc(x) + '</li>').join("") + '</ul></div>' +
    '<div class="panel wide"><h3>The rubric</h3><div class="rubric">' + B.rubric.map((r) => '<span class="k">' + esc(r.name) + ' <span class="small">' + (r.kind === "scaled" ? "0–3" : r.kind === "binary" ? "pass/fail" : "category") + (r.target === "turn1" ? " · turn 1" : "") + '</span></span><span class="d">' + esc(r.criterion) + '</span>').join("") + '</div></div>' +
    '</div></section>';
}

document.getElementById("app").innerHTML = header() + background() + board() + D.cases.map(caseSection).join("") +
  '<p class="small">Generated from edge-eval-runs/' + esc(D.run) + ' · scores are Judge v0 (uncalibrated) · answers verbatim from the agents.</p>';
</script>
`;
// Guard: the page's script must at least parse — a stray apostrophe inside a JS string
// literal once shipped a blank page (demo-3 v2). `new Function` compiles without running.
const script = /<script>\n([\s\S]*?)<\/script>\s*$/.exec(html)?.[1];
if (!script) throw new Error("report template: page script not found");
try {
  new Function(script.replace('JSON.parse(document.getElementById("data").textContent)', "{}"));
} catch (e) {
  throw new Error(`report template: page script does not parse — ${(e as Error).message}`);
}
writeFileSync(OUT, html);
console.log(`[report] ${cells.length} cells, ${judgments.length} judgments, ${caseIds.length} cases${background ? " + background" : ""} → ${OUT}`);
}

main()
  .catch((e) => {
    console.error("[report] failed:", e);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
