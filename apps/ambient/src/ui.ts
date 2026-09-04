/**
 * The operator page: one HTML file over the JSON routes. No build step, no
 * framework — this is a debugging surface for the person running the bot.
 */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ambient</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: oklch(0.975 0.004 250); --card: oklch(1 0 0); --ink: oklch(0.22 0.02 250); --mute: oklch(0.55 0.02 250);
    --line: oklch(0 0 0 / 0.08); --accent: oklch(0.55 0.17 260); --accent-ink: oklch(1 0 0);
    --ok: oklch(0.62 0.15 155); --warn: oklch(0.72 0.15 70); --bad: oklch(0.6 0.2 25);
    --shadow: 0 0 0 1px oklch(0 0 0 / 0.06), 0 1px 2px -1px oklch(0 0 0 / 0.06), 0 2px 4px 0 oklch(0 0 0 / 0.04);
    --shadow-hover: 0 0 0 1px oklch(0 0 0 / 0.08), 0 1px 2px -1px oklch(0 0 0 / 0.08), 0 2px 4px 0 oklch(0 0 0 / 0.06);
    --ease: cubic-bezier(0.2, 0, 0, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: oklch(0.19 0.01 250); --card: oklch(0.24 0.012 250); --ink: oklch(0.93 0.01 250); --mute: oklch(0.65 0.015 250);
      --line: oklch(1 0 0 / 0.08); --accent: oklch(0.68 0.14 260); --accent-ink: oklch(0.15 0.02 260);
      --shadow: 0 0 0 1px oklch(1 0 0 / 0.08); --shadow-hover: 0 0 0 1px oklch(1 0 0 / 0.13);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); -webkit-font-smoothing: antialiased; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--card); position: sticky; top: 0; z-index: 1; }
  header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  header .mute { color: var(--mute); font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .actions { margin-left: auto; display: flex; gap: 8px; }
  .btn { border: 0; background: var(--card); padding: 7px 12px; border-radius: 8px; box-shadow: var(--shadow); transition-property: box-shadow, scale, background-color; transition-duration: 150ms; transition-timing-function: var(--ease); }
  .btn:hover { box-shadow: var(--shadow-hover); }
  .btn:active { scale: 0.96; }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .btn.primary { background: var(--accent); color: var(--accent-ink); box-shadow: none; }

  main { display: grid; grid-template-columns: 288px minmax(0, 1fr); min-height: calc(100vh - 45px); }
  nav { border-right: 1px solid var(--line); background: var(--card); padding: 8px; overflow: auto; }
  nav .item { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 10px 12px; border-radius: 10px; transition-property: background-color, scale; transition-duration: 150ms; transition-timing-function: var(--ease); }
  nav .item:hover { background: var(--bg); }
  nav .item:active { scale: 0.98; }
  nav .item.on { background: var(--accent); color: var(--accent-ink); }
  nav .item.on .mute { color: var(--accent-ink); opacity: 0.8; }
  nav .name { font-weight: 600; letter-spacing: -0.005em; }
  nav .mute { color: var(--mute); font-size: 12px; font-variant-numeric: tabular-nums; }
  .bar { height: 4px; background: oklch(0 0 0 / 0.08); border-radius: 2px; margin-top: 8px; overflow: hidden; }
  @media (prefers-color-scheme: dark) { .bar { background: oklch(1 0 0 / 0.1); } }
  .bar i { display: block; height: 100%; background: var(--ok); border-radius: 2px; transition-property: width; transition-duration: 300ms; transition-timing-function: var(--ease); }
  .bar i.warn { background: var(--warn); } .bar i.bad { background: var(--bad); }
  nav .item.on .bar { background: oklch(1 0 0 / 0.25); } nav .item.on .bar i { background: var(--accent-ink); }

  section { padding: 16px; overflow: auto; min-width: 0; }
  .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .stat { background: var(--card); border-radius: 12px; padding: 12px 14px; box-shadow: var(--shadow); }
  .stat b { display: block; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .stat span { color: var(--mute); font-size: 12px; display: block; margin-top: 2px; }

  .tabs { display: inline-flex; gap: 2px; padding: 3px; background: var(--card); border-radius: 11px; box-shadow: var(--shadow); margin: 2px 0 12px; }
  .tabs button { border: 0; background: transparent; padding: 5px 12px; border-radius: 8px; color: var(--mute); transition-property: background-color, color, scale; transition-duration: 150ms; transition-timing-function: var(--ease); }
  .tabs button:hover { color: var(--ink); }
  .tabs button:active { scale: 0.96; }
  .tabs button.on { background: var(--ink); color: var(--bg); }

  .card { background: var(--card); border-radius: 12px; padding: 14px; box-shadow: var(--shadow); }
  .card.flush { padding: 4px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  th { color: var(--mute); font-weight: 500; font-size: 12px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--line); color: var(--mute); }
  .pill.ok { background: oklch(from var(--ok) l c h / 0.15); color: oklch(from var(--ok) 0.4 c h); }
  .pill.bad { background: oklch(from var(--bad) l c h / 0.15); color: oklch(from var(--bad) 0.45 c h); }
  .pill.warn { background: oklch(from var(--warn) l c h / 0.18); color: oklch(from var(--warn) 0.45 c h); }
  @media (prefers-color-scheme: dark) {
    .pill.ok { color: oklch(from var(--ok) 0.8 c h); } .pill.bad { color: oklch(from var(--bad) 0.8 c h); } .pill.warn { color: oklch(from var(--warn) 0.85 c h); }
  }

  .msg { border-left: 2px solid var(--line); padding: 8px 12px; margin: 10px 0; border-radius: 0 8px 8px 0; }
  .msg.assistant { border-color: var(--accent); } .msg.user { border-color: var(--mute); }
  .msg .who { font-size: 11.5px; color: var(--mute); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
  .tool { font-size: 12px; color: var(--mute); background: var(--bg); border-radius: 8px; padding: 6px 10px; margin: 6px 0; }
  .tool summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; }
  .tool summary::before { content: ""; width: 0; height: 0; border-left: 5px solid currentColor; border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent; translate: 1px 0; transition-property: rotate; transition-duration: 150ms; transition-timing-function: var(--ease); }
  .tool[open] summary::before { rotate: 90deg; }
  .tool pre { margin-top: 6px; }
  .empty { color: var(--mute); padding: 32px; text-align: center; }
  .stamp { color: var(--mute); font-size: 12px; margin-bottom: 8px; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0ms !important; } }
</style>
</head>
<body>
<header>
  <h1>👁 Ambient</h1>
  <span class="mute" id="meta"></span>
  <div class="actions">
    <button class="btn" id="newmono" title="Start a fresh monologue chat; the state document stays">New monologue</button>
    <button class="btn" id="refresh">Refresh</button>
    <button class="btn primary" id="tick" title="Run this channel's tick now (a heartbeat if nothing is queued)">Tick now</button>
  </div>
</header>
<main>
  <nav id="channels"><div class="empty">Loading…</div></nav>
  <section id="detail"><div class="empty">Pick a channel</div></section>
</main>
<script>
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const token = new URLSearchParams(location.search).get("token") || localStorage.getItem("ambient.token") || "";
if (token) localStorage.setItem("ambient.token", token);
const api = async (path, init) => {
  const r = await fetch(path, { ...init, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(init && init.headers) } });
  if (r.status === 401) { const t = prompt("Admin token"); if (t) { localStorage.setItem("ambient.token", t); location.reload(); } throw new Error("unauthorized"); }
  return r.json();
};
const ago = (ms) => { if (!ms) return "never"; const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
const money = (n) => "$" + (n ?? 0).toFixed(n >= 1 ? 2 : 3);
const num = (n) => (n ?? 0).toLocaleString();

let channels = [], current = localStorage.getItem("ambient.channel") || null, tab = localStorage.getItem("ambient.tab") || "state";

async function loadChannels() {
  channels = await api("/channels");
  $("#meta").textContent = channels.length + " channel(s) · " + new Date().toLocaleTimeString();
  if (!current || !channels.some((c) => c.id === current)) current = channels[0] && channels[0].id;
  $("#channels").innerHTML = channels.length ? channels.map((c) => {
    const pct = c.budget && c.budget.max ? Math.min(100, Math.round(100 * c.budget.used / c.budget.max)) : 0;
    const cls = pct >= 90 ? "bad" : pct >= 60 ? "warn" : "";
    return '<button data-id="' + esc(c.id) + '" class="item ' + (c.id === current ? "on" : "") + '">' +
      '<div class="name">#' + esc(c.name) + '</div>' +
      '<div class="mute">' + (c.pending ? c.pending + " queued · " : "") + "last tick " + ago(c.lastRunAt) + '</div>' +
      (c.budget && c.budget.max ? '<div class="bar"><i class="' + cls + '" style="width:' + pct + '%"></i></div><div class="mute">' + (c.budget.unit === "cost" ? money(c.budget.used) + " of " + money(c.budget.max) : num(c.budget.used) + " of " + num(c.budget.max) + " tokens") + " today</div>" : "") +
      '</button>';
  }).join("") : '<div class="empty">No channels yet — /invite the bot somewhere.</div>';
  $("#channels").querySelectorAll(".item").forEach((b) => b.onclick = () => { current = b.dataset.id; localStorage.setItem("ambient.channel", current); loadChannels(); loadDetail(); });
}

async function loadDetail() {
  if (!current) return;
  const c = channels.find((x) => x.id === current) || { id: current, name: current };
  const [state, runs, triage, mono] = await Promise.all([
    api("/channels/" + current + "/state"), api("/channels/" + current + "/runs"), api("/channels/" + current + "/triage"), api("/channels/" + current + "/monologue"),
  ]);
  const today = Date.now() - 86400000;
  const runsToday = runs.filter((r) => r.startedAt >= today);
  const tokens = (r) => (r.usageInputTokens || 0) + (r.usageOutputTokens || 0);
  const stats = [
    ["Queued", c.pending || 0, "events waiting"],
    ["Ticks", runsToday.length, "last 24 h"],
    ["Tokens", num(runsToday.reduce((a, r) => a + tokens(r), 0)), "last 24 h"],
    ["Cost", money(runsToday.reduce((a, r) => a + (r.costTotal || 0), 0)), "last 24 h"],
    ["Deferred", triage.filter((v) => !v.act && v.at >= today).length + "/" + triage.filter((v) => v.at >= today).length, "verdicts, last 24 h"],
    ["Judge tokens", num(triage.filter((v) => v.at >= today).reduce((a, v) => a + (v.inputTokens || 0) + (v.outputTokens || 0), 0)), "last 24 h"],
  ];
  const tabs = ["state", "triage", "runs", "monologue"];
  let body = "";
  if (tab === "state") body = '<div class="card"><div class="stamp">Updated ' + ago(state.updatedAt) + (state.bootstrappedAt ? " · first read " + ago(state.bootstrappedAt) : "") + (state.humanEdits ? ' · <span class="pill warn">edited by a human</span>' : "") + '</div><pre>' + esc(state.doc || "(empty — nothing written yet)") + '</pre></div>';
  if (tab === "triage") body = triage.length ? '<div class="card flush"><table><tr><th>When</th><th>Verdict</th><th>Stage</th><th>Reason</th><th class="num">Events</th><th class="num">Judge tokens</th></tr>' + triage.map((v) => '<tr><td>' + ago(v.at) + '</td><td><span class="pill ' + (v.act ? "ok" : "") + '">' + (v.act ? "act" : "defer") + '</span></td><td>' + v.stage + '</td><td>' + esc(v.reason) + '</td><td class="num">' + v.events + '</td><td class="num">' + (v.inputTokens != null ? num(v.inputTokens + (v.outputTokens || 0)) : "–") + '</td></tr>').join("") + '</table></div>' : '<div class="empty">No verdicts yet.</div>';
  if (tab === "runs") body = runs.length ? '<div class="card flush"><table><tr><th>Started</th><th>Status</th><th class="num">In</th><th class="num">Out</th><th class="num">Cached</th><th class="num">Cost</th><th>Took</th><th>Error</th></tr>' + runs.map((r) => '<tr><td>' + ago(r.startedAt) + '</td><td><span class="pill ' + (r.status === "completed" ? "ok" : r.status === "errored" ? "bad" : "warn") + '">' + r.status + '</span></td><td class="num">' + num(r.usageInputTokens) + '</td><td class="num">' + num(r.usageOutputTokens) + '</td><td class="num">' + num(r.usageCacheReadTokens) + '</td><td class="num">' + money(r.costTotal) + '</td><td>' + (r.endedAt ? Math.round((r.endedAt - r.startedAt) / 1000) + "s" : "…") + '</td><td class="mute">' + esc(r.error || "") + '</td></tr>').join("") + '</table></div>' : '<div class="empty">No runs yet.</div>';
  if (tab === "monologue") body = mono.messages.length ? '<div class="card">' + mono.messages.map((m) => '<div class="msg ' + m.role + '"><div class="who">' + (m.role === "user" ? "tick" : "agent") + '</div>' + m.parts.map((p) => p.text != null ? '<div>' + esc(p.text).replace(/\\n/g, "<br>") + '</div>' : p.tool ? '<details class="tool"><summary>🔧 ' + esc(p.tool) + '</summary><pre>' + esc(JSON.stringify({ input: p.input, output: p.output }, null, 2)) + '</pre></details>' : "").join("") + '</div>').join("") + '</div>' : '<div class="empty">No monologue yet.</div>';
  $("#detail").innerHTML = '<div class="row">' + stats.map(([k, v, s]) => '<div class="stat"><b>' + v + '</b><span>' + k + " · " + s + '</span></div>').join("") + '</div>' +
    '<div class="tabs">' + tabs.map((t) => '<button data-tab="' + t + '" class="' + (t === tab ? "on" : "") + '">' + t[0].toUpperCase() + t.slice(1) + '</button>').join("") + '</div>' + body;
  $("#detail").querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { tab = b.dataset.tab; localStorage.setItem("ambient.tab", tab); loadDetail(); });
}

$("#refresh").onclick = () => { loadChannels().then(loadDetail); };
$("#newmono").onclick = async () => { if (!current || !confirm("Start a fresh monologue for this channel? Its notes (state) are kept.")) return; await api("/channels/" + current + "/new-monologue", { method: "POST" }); tab = "monologue"; loadDetail(); };
$("#tick").onclick = async () => { if (!current) return; $("#tick").disabled = true; $("#tick").textContent = "Ticking…"; try { await api("/channels/" + current + "/tick", { method: "POST" }); } finally { $("#tick").disabled = false; $("#tick").textContent = "Tick now"; loadChannels().then(loadDetail); } };
loadChannels().then(loadDetail).catch((e) => { $("#channels").innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
setInterval(() => { loadChannels().then(loadDetail).catch(() => {}); }, 15000);
</script>
</body>
</html>`;
