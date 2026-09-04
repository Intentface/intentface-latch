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
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --ink: #1c2530; --mute: #6b7684; --line: #e3e7ec; --ok: #2f9e6e; --warn: #d98c1f; --bad: #d64545; --accent: #3b6ee8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14181d; --card: #1c2229; --ink: #e6ebf0; --mute: #8a96a3; --line: #2b333c; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--ink); }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--card); }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .2px; }
  header .mute { color: var(--mute); font-size: 12px; }
  main { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 45px); }
  nav { border-right: 1px solid var(--line); background: var(--card); padding: 8px; overflow: auto; }
  nav button { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: inherit; padding: 10px; border-radius: 8px; cursor: pointer; font: inherit; }
  nav button:hover { background: var(--bg); }
  nav button.on { background: var(--accent); color: #fff; }
  nav button.on .mute, nav button.on .bar i { color: #dfe7ff; background: #dfe7ff; }
  nav .name { font-weight: 600; }
  nav .mute { color: var(--mute); font-size: 12px; }
  .bar { height: 4px; background: var(--line); border-radius: 2px; margin-top: 6px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--ok); }
  .bar i.warn { background: var(--warn); } .bar i.bad { background: var(--bad); }
  section { padding: 16px; overflow: auto; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  .stat { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; min-width: 130px; }
  .stat b { display: block; font-size: 18px; }
  .stat span { color: var(--mute); font-size: 12px; }
  .tabs { display: flex; gap: 4px; margin: 8px 0 12px; }
  .tabs button { border: 1px solid var(--line); background: var(--card); color: inherit; padding: 6px 12px; border-radius: 999px; cursor: pointer; font: inherit; }
  .tabs button.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--mute); font-weight: 500; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: var(--line); }
  .pill.ok { background: #dff3ea; color: #1d6b49; } .pill.bad { background: #fbe1e1; color: #8f2626; } .pill.warn { background: #fbedd5; color: #7a4d0c; }
  @media (prefers-color-scheme: dark) { .pill.ok { background: #1e3b30; color: #9fe0c1; } .pill.bad { background: #4a2020; color: #f2a5a5; } .pill.warn { background: #4a3a1c; color: #f0cb8a; } }
  .msg { border-left: 3px solid var(--line); padding: 6px 10px; margin: 8px 0; }
  .msg.assistant { border-color: var(--accent); } .msg.user { border-color: var(--mute); }
  .msg .who { font-size: 12px; color: var(--mute); margin-bottom: 4px; }
  .tool { font-size: 12px; color: var(--mute); background: var(--bg); border-radius: 6px; padding: 6px 8px; margin: 6px 0; }
  .tool summary { cursor: pointer; }
  .actions { margin-left: auto; display: flex; gap: 8px; }
  .actions button { border: 1px solid var(--line); background: var(--card); color: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer; font: inherit; }
  .empty { color: var(--mute); padding: 24px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>👁 Ambient</h1>
  <span class="mute" id="meta"></span>
  <div class="actions">
    <button id="tick" title="Run this channel's tick now (a heartbeat if nothing is queued)">Tick now</button>
    <button id="refresh">Refresh</button>
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
    return '<button data-id="' + esc(c.id) + '" class="' + (c.id === current ? "on" : "") + '">' +
      '<div class="name">#' + esc(c.name) + '</div>' +
      '<div class="mute">' + (c.pending ? c.pending + " queued · " : "") + "last tick " + ago(c.lastRunAt) + '</div>' +
      (c.budget && c.budget.max ? '<div class="bar"><i class="' + cls + '" style="width:' + pct + '%"></i></div><div class="mute">' + (c.budget.unit === "cost" ? money(c.budget.used) + " of " + money(c.budget.max) : num(c.budget.used) + " of " + num(c.budget.max) + " tokens") + " today</div>" : "") +
      '</button>';
  }).join("") : '<div class="empty">No channels yet — /invite the bot somewhere.</div>';
  $("#channels").querySelectorAll("button").forEach((b) => b.onclick = () => { current = b.dataset.id; localStorage.setItem("ambient.channel", current); loadChannels(); loadDetail(); });
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
  if (tab === "state") body = '<div class="card"><div class="mute" style="margin-bottom:8px">Updated ' + ago(state.updatedAt) + (state.bootstrappedAt ? " · first read " + ago(state.bootstrappedAt) : "") + (state.humanEdits ? ' · <span class="pill warn">edited by a human</span>' : "") + '</div><pre>' + esc(state.doc || "(empty — nothing written yet)") + '</pre></div>';
  if (tab === "triage") body = triage.length ? '<div class="card"><table><tr><th>When</th><th>Verdict</th><th>Stage</th><th>Reason</th><th class="num">Events</th><th class="num">Judge tokens</th></tr>' + triage.map((v) => '<tr><td>' + ago(v.at) + '</td><td><span class="pill ' + (v.act ? "ok" : "") + '">' + (v.act ? "act" : "defer") + '</span></td><td>' + v.stage + '</td><td>' + esc(v.reason) + '</td><td class="num">' + v.events + '</td><td class="num">' + (v.inputTokens != null ? num(v.inputTokens + (v.outputTokens || 0)) : "–") + '</td></tr>').join("") + '</table></div>' : '<div class="empty">No verdicts yet.</div>';
  if (tab === "runs") body = runs.length ? '<div class="card"><table><tr><th>Started</th><th>Status</th><th class="num">In</th><th class="num">Out</th><th class="num">Cached</th><th class="num">Cost</th><th>Took</th><th>Error</th></tr>' + runs.map((r) => '<tr><td>' + ago(r.startedAt) + '</td><td><span class="pill ' + (r.status === "completed" ? "ok" : r.status === "errored" ? "bad" : "warn") + '">' + r.status + '</span></td><td class="num">' + num(r.usageInputTokens) + '</td><td class="num">' + num(r.usageOutputTokens) + '</td><td class="num">' + num(r.usageCacheReadTokens) + '</td><td class="num">' + money(r.costTotal) + '</td><td>' + (r.endedAt ? Math.round((r.endedAt - r.startedAt) / 1000) + "s" : "…") + '</td><td class="mute">' + esc(r.error || "") + '</td></tr>').join("") + '</table></div>' : '<div class="empty">No runs yet.</div>';
  if (tab === "monologue") body = mono.messages.length ? '<div class="card">' + mono.messages.map((m) => '<div class="msg ' + m.role + '"><div class="who">' + (m.role === "user" ? "tick" : "agent") + '</div>' + m.parts.map((p) => p.text != null ? '<div>' + esc(p.text).replace(/\\n/g, "<br>") + '</div>' : p.tool ? '<details class="tool"><summary>🔧 ' + esc(p.tool) + '</summary><pre>' + esc(JSON.stringify({ input: p.input, output: p.output }, null, 2)) + '</pre></details>' : "").join("") + '</div>').join("") + '</div>' : '<div class="empty">No monologue yet.</div>';
  $("#detail").innerHTML = '<div class="row">' + stats.map(([k, v, s]) => '<div class="stat"><b>' + v + '</b><span>' + k + " · " + s + '</span></div>').join("") + '</div>' +
    '<div class="tabs">' + tabs.map((t) => '<button data-tab="' + t + '" class="' + (t === tab ? "on" : "") + '">' + t[0].toUpperCase() + t.slice(1) + '</button>').join("") + '</div>' + body;
  $("#detail").querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { tab = b.dataset.tab; localStorage.setItem("ambient.tab", tab); loadDetail(); });
}

$("#refresh").onclick = () => { loadChannels().then(loadDetail); };
$("#tick").onclick = async () => { if (!current) return; $("#tick").disabled = true; $("#tick").textContent = "Ticking…"; try { await api("/channels/" + current + "/tick", { method: "POST" }); } finally { $("#tick").disabled = false; $("#tick").textContent = "Tick now"; loadChannels().then(loadDetail); } };
loadChannels().then(loadDetail).catch((e) => { $("#channels").innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
setInterval(() => { loadChannels().then(loadDetail).catch(() => {}); }, 15000);
</script>
</body>
</html>`;
