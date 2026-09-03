import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { DAY_MS, defineContext, isChatBusyError } from "@intentface/latch-core";
import { createSqliteAdapter, createSqliteLimitStore, migrate, schema } from "@intentface/latch-drizzle";
import { createLatchHonoApp } from "@intentface/latch-server/hono";
import { createWatcher, HEARTBEAT_PROMPT, STATE_SCHEMA, TICK_PROMPT, type Ctx } from "./agent.js";
import { createCanvas } from "./canvas.js";
import { createCanvasStateStore } from "./canvas-state.js";
import { createEventsHandler } from "./events.js";
import { owner, type Principal } from "./principal.js";
import { createSlack } from "./slack.js";
import { createStateStore } from "./state.js";
import { createTicker } from "./ticker.js";
import { createTriage } from "./triage.js";
import { createTools } from "./tools.js";

/**
 * Ambient channel agents on Latch. One agent per Slack channel the bot is a
 * member of; Slack events land in an inbox; after a quiet period (or at once
 * for a mention) the channel's tick runs as one more turn of ONE long-lived
 * chat — the agent's continuous monologue — which reads the inbox, updates the
 * channel's state document and speaks only through a tool.
 *
 *   pnpm --filter @intentface/latch-ambient serve
 *
 * Needs SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, a model key and a public URL
 * for /slack/events (see .env.example). /invite the bot to start watching.
 */
const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env ${name}`);
  return v;
};

const config = {
  slackToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
  model: env("AMBIENT_MODEL", "claude-sonnet-4-6"),
  /** Quiet period after the last event before a tick runs. */
  quietMs: Number(env("AMBIENT_QUIET_MS", "90000")),
  /** Heartbeat for quiet channels (overdue checks); 0 disables. */
  heartbeatMs: Number(env("AMBIENT_HEARTBEAT_MS", String(60 * 60_000))),
  /** A cheap model that decides whether a batch is worth waking the agent now; empty = rules only. */
  triageModel: process.env.AMBIENT_TRIAGE_MODEL ?? "",
  /** Deferred events are read regardless after this long. */
  maxDeferMs: Number(env("AMBIENT_MAX_DEFER_MS", String(30 * 60_000))),
  /** Compact the monologue once it holds this many messages. */
  compactAfter: Number(env("AMBIENT_COMPACT_AFTER", "80")),
  maxPostsPerDay: Number(env("AMBIENT_MAX_POSTS_PER_DAY", "5")),
  tokensPerDay: Number(env("AMBIENT_TOKENS_PER_DAY", "500000")),
  adminToken: process.env.AMBIENT_ADMIN_TOKEN,
  /** Where the state document lives: the channel canvas (humans can edit it) or SQLite only. */
  stateIn: env("AMBIENT_STATE", "sqlite") as "sqlite" | "canvas",
  db: env("AMBIENT_DB", "file:./ambient.db"),
  port: Number(env("PORT", "8790")),
};

// Storage: Latch's tables and the app's host tables in the same file.
const client = createClient({ url: config.db });
await migrate(client);
const sqliteState = createStateStore(client);
await sqliteState.migrate();
const db = drizzle(client, { schema });

const slack = createSlack(config.slackToken);
const state =
  config.stateIn === "canvas"
    ? createCanvasStateStore({
        base: sqliteState,
        canvas: createCanvas(config.slackToken),
        initial: `# Channel notes\n\nKept by the ambient agent. Edit freely — it reads this before every tick.\n\n${STATE_SCHEMA}`,
        onError: (channel, e) => console.warn(`[ambient] ${channel}: canvas unreadable, using last written copy:`, e),
      })
    : sqliteState;
const tools = createTools({ slack, state, maxPostsPerDay: config.maxPostsPerDay });

/** The channel's one long-lived chat: its monologue. */
const chatIdOf = (channel: string) => `ambient_${channel}`;

const limitStore = createSqliteLimitStore(db);
const policiesFor = (channel: string) => [
  { key: `channel:${channel}`, windowMs: DAY_MS, max: { tokens: config.tokensPerDay }, label: "this channel's daily token budget" },
];

const { app: latch, runtime, stop, models } = await createLatchHonoApp<Principal, Ctx>({
  storage: createSqliteAdapter<Principal>(db, { owner }),
  // Latch's own HTTP surface is for operators here: the caller names a watched
  // channel. Locked behind AMBIENT_ADMIN_TOKEN when set; local-only otherwise.
  resolveContext: (req) => {
    if (!authorized(req)) return null;
    const channel = req.headers.get("x-channel");
    return channel && watched.has(channel) ? { channel } : null;
  },
  // Every turn starts from the channel's state as written.
  context: defineContext<Principal, Ctx>({
    build: async ({ principal }) => ({
      state: await state.load(principal.channel),
      channelName: await slack.channelName(principal.channel),
    }),
  }),
  agents: (models) => ({ watcher: createWatcher({ model: models.modelFor(config.model), tools }) }),
  runtime: {
    // A chatty channel cannot run away: one token budget per channel per day.
    limits: {
      store: limitStore,
      limitsFor: ({ principal }) => policiesFor(principal.channel),
      onRefused: ({ principal, retryAfterMs }) =>
        console.warn(`[ambient] ${principal.channel}: tick refused, budget resets in ${Math.ceil(retryAfterMs / 60_000)} min`),
    },
    telemetry: {
      onRunFinished: (run, outcome) => {
        console.log(
          `[ambient] ${run.principal.channel}: ${outcome.status} in ${(outcome.usage.inputTokens + outcome.usage.outputTokens).toLocaleString()} tokens`,
        );
      },
    },
  },
  handler: { basePath: "/latch" },
  cronIntervalMs: 30_000, // durability sweep: a tick interrupted by a restart resumes
});

// ---- The tick ----------------------------------------------------------------

// Triage: rules, then (optionally) a cheap model. Its tokens hit the same budget as the agent's.
const triage = createTriage({
  model: config.triageModel ? models.modelFor(config.triageModel) : undefined,
  limits: { store: limitStore, policiesFor },
  maxDeferMs: config.maxDeferMs,
});

/**
 * One more turn of the channel's monologue: a tick when the inbox has events
 * worth it, a heartbeat when the ticker fires on an empty inbox. Returns true
 * when more arrived meanwhile. Every caller goes through the ticker, so a
 * channel never runs two at once.
 */
async function tick(channel: string): Promise<boolean> {
  const principal: Principal = { channel };
  const { events, oldestReceivedAt } = await state.peek(channel);
  let prompt = HEARTBEAT_PROMPT;
  if (events.length > 0) {
    const verdict = await triage.decide({ channel, events, stateDoc: (await state.load(channel)).doc, oldestAgeMs: oldestReceivedAt ? Date.now() - oldestReceivedAt : 0 });
    await state.logTriage(channel, { ...verdict, events: events.length, ...verdict.usage });
    if (!verdict.act) {
      console.log(`[ambient] ${channel}: deferred ${events.length} event(s) — ${verdict.reason}`);
      return false;
    }
    prompt = TICK_PROMPT;
  }
  await runtime.runAgent({ principal, agent: "watcher", prompt, threadId: chatIdOf(channel), blockGated: false });
  // Keep the monologue bounded: fold old thinking into a summary; the state document carries the facts.
  const history = await runtime.loadHistory({ chatId: chatIdOf(channel), principal });
  if (history.length >= config.compactAfter) {
    const r = await runtime.compactChat({ chatId: chatIdOf(channel), principal, focus: "Keep what you were watching and why; the state document holds the facts." });
    if (r) console.log(`[ambient] ${channel}: monologue compacted (${r.compacted} messages)`);
  }
  return (await state.pending(channel)) > 0;
}

const ticker = createTicker({
  quietMs: config.quietMs,
  run: tick,
  onError: (channel, e) => {
    if (isChatBusyError(e)) return console.log(`[ambient] ${channel}: tick already running, will retry`);
    console.error(`[ambient] ${channel}: tick failed:`, e);
  },
});

// ---- Which channels: the ones the bot is in --------------------------------------

const watched = new Set<string>();
async function join(channel: string) {
  if (watched.has(channel)) return;
  watched.add(channel);
  console.log(`[ambient] watching #${await slack.channelName(channel)} (${channel})`);
  if ((await state.pending(channel)) > 0) ticker.wake(channel, { now: true }); // queued before a restart
}
async function leave(channel: string) {
  if (watched.delete(channel)) console.log(`[ambient] left ${channel}`);
}
try {
  for (const ch of await slack.myChannels()) await join(ch.id);
} catch (e) {
  console.error("[ambient] could not list channels (bad token?):", e);
}

if (config.heartbeatMs > 0) {
  const heartbeat = setInterval(() => {
    for (const channel of watched) ticker.wake(channel, { now: true });
  }, config.heartbeatMs);
  heartbeat.unref();
}

// ---- HTTP --------------------------------------------------------------------------
// The app's own routes first, then Latch's HTTP surface under /latch (its
// Hono app is a catch-all, so it has to mount last).

function authorized(req: Request): boolean {
  if (!config.adminToken) return true;
  return req.headers.get("authorization") === `Bearer ${config.adminToken}`;
}

const app = new Hono();

// Slack Events API → inbox → wake. Acknowledged at once; the tick runs after.
const events = createEventsHandler({
  signingSecret: config.signingSecret,
  state,
  isWatched: (c) => watched.has(c),
  wake: (channel, opts) => ticker.wake(channel, opts),
  onJoin: join,
  onLeave: leave,
  botUserId: () => slack.botUserId(),
});
app.post("/slack/events", (c) => events(c.req.raw));

app.use("/channels/*", async (c, next) => {
  if (!authorized(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const channel = c.req.path.split("/")[2];
  if (channel && !watched.has(channel)) return c.json({ error: "not a watched channel" }, 404);
  await next();
});

/** Watched channels and what is queued for each. */
app.get("/channels", async (c) => {
  if (!authorized(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const out = [];
  for (const id of watched) out.push({ id, name: await slack.channelName(id), pending: await state.pending(id) });
  return c.json(out);
});

/** The state document as the agent last wrote it. */
app.get("/channels/:id/state", async (c) => c.json(await state.load(c.req.param("id"))));

/** Why it did or did not wake: every triage verdict, newest first. */
app.get("/channels/:id/triage", async (c) => c.json(await state.listTriage(c.req.param("id"))));

/** Recent runs: status, usage, cost. */
app.get("/channels/:id/runs", async (c) => c.json(await runtime.listRuns({ principal: { channel: c.req.param("id") }, limit: 20 })));

/** The monologue: what it read, thought, and did — the whole long-lived chat, compacted as it grows. */
app.get("/channels/:id/monologue", async (c) => {
  const channel = c.req.param("id");
  const history = await runtime.loadHistory({ chatId: chatIdOf(channel), principal: { channel } }).catch(() => []);
  const messages = history.map((m) => ({
    role: m.role,
    parts: m.parts.map((p) => {
      if (p.type === "text") return { text: p.text };
      if (p.type.startsWith("tool-")) {
        const t = p as { type: string; input?: unknown; output?: unknown };
        return { tool: t.type.slice("tool-".length), input: t.input, output: t.output };
      }
      return { type: p.type };
    }),
  }));
  return c.json({ chatId: chatIdOf(channel), messages });
});

/** Run the channel's tick now (a heartbeat if nothing is queued) and wait for it. */
app.post("/channels/:id/tick", async (c) => {
  const channel = c.req.param("id");
  const queued = await state.pending(channel);
  ticker.wake(channel, { now: true });
  await ticker.idle(channel);
  const [run] = await runtime.listRuns({ principal: { channel }, limit: 1 });
  return c.json({ queued, run: run ? { id: run.id, status: run.status, error: run.error ?? null } : null });
});

app.route("/latch", latch);

serve({ fetch: app.fetch, port: config.port });
console.log(`👁  ambient listening on http://localhost:${config.port}`);
console.log(`   ${watched.size} channel(s); quiet ${config.quietMs / 1000}s; heartbeat ${config.heartbeatMs / 60_000} min; model ${config.model}; triage ${config.triageModel || "rules only"}; state in ${config.stateIn}`);
console.log(`   /invite the bot to a channel to watch it — Slack events at POST /slack/events`);
console.log(`   curl http://localhost:${config.port}/channels`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    ticker.stop();
    void stop().finally(() => process.exit(0));
  });
}
