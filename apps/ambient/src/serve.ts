import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { DAY_MS, defineContext } from "@intentface/latch-core";
import { createSqliteAdapter, createSqliteLimitStore, migrate, schema } from "@intentface/latch-drizzle";
import { createLatchHonoApp } from "@intentface/latch-server/hono";
import { createWatcher, STATE_SCHEMA, TICK_PROMPT, type Ctx } from "./agent.js";
import { owner, type Principal } from "./principal.js";
import { createSlack } from "./slack.js";
import { createCanvas } from "./canvas.js";
import { createEventsHandler } from "./events.js";
import { createCanvasStateStore } from "./canvas-state.js";
import { createStateStore } from "./state.js";
import { createTools } from "./tools.js";
import { createWatchlist } from "./watchlist.js";

/**
 * Ambient channel agents on Latch, the simple version: one agent per Slack
 * channel, woken by a Latch schedule, pulling what is new, keeping a state
 * document, speaking only through a tool. No Slack events, no public URL.
 *
 *   pnpm --filter @intentface/latch-ambient serve
 *
 * Needs SLACK_BOT_TOKEN and a model key (see .env.example). It watches every
 * channel the bot is a member of: /invite it to start, /kick it to stop.
 */
const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env ${name}`);
  return v;
};

const config = {
  slackToken: env("SLACK_BOT_TOKEN"),
  /** Enables POST /slack/events (app_mention → immediate tick). Needs a public URL. */
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  /** How often to re-list the channels the bot is a member of. */
  discoveryMs: Number(env("AMBIENT_DISCOVERY_MS", String(5 * 60_000))),
  model: env("AMBIENT_MODEL", "claude-sonnet-4-6"),
  every: env("AMBIENT_EVERY", "*/10 * * * *"),
  maxPostsPerDay: Number(env("AMBIENT_MAX_POSTS_PER_DAY", "5")),
  tokensPerDay: Number(env("AMBIENT_TOKENS_PER_DAY", "500000")),
  adminToken: process.env.AMBIENT_ADMIN_TOKEN,
  /** Where the state document lives: the channel canvas (humans can edit it) or SQLite only. */
  stateIn: env("AMBIENT_STATE", "sqlite") as "sqlite" | "canvas",
  db: env("AMBIENT_DB", "file:./ambient.db"),
  port: Number(env("PORT", "8790")),
};

// Storage: Latch's tables and the app's two host tables in the same file.
const client = createClient({ url: config.db });
await migrate(client);
const sqliteState = createStateStore(client);
await sqliteState.migrate();
const state =
  config.stateIn === "canvas"
    ? createCanvasStateStore({
        base: sqliteState,
        canvas: createCanvas(config.slackToken),
        initial: `# Channel notes\n\nKept by the ambient agent. Edit freely — it reads this before every tick.\n\n${STATE_SCHEMA}`,
        onError: (channel, e) => console.warn(`[ambient] ${channel}: canvas unreadable, using last written copy:`, e),
      })
    : sqliteState;
const db = drizzle(client, { schema });

const slack = createSlack(config.slackToken);
const tools = createTools({ slack, state, maxPostsPerDay: config.maxPostsPerDay });


const { app: latch, runtime, stop } = await createLatchHonoApp<Principal, Ctx>({
  storage: createSqliteAdapter<Principal>(db, { owner }),
  // Latch's own HTTP surface is for operators here: the caller names a watched
  // channel. Locked behind AMBIENT_ADMIN_TOKEN when set; local-only otherwise.
  resolveContext: (req) => {
    if (!authorized(req)) return null;
    const channel = req.headers.get("x-channel");
    return channel && isWatched(channel) ? { channel } : null;
  },
  // Every turn — scheduled or not — starts from the channel's state as written.
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
      store: createSqliteLimitStore(db),
      limitsFor: ({ principal }) => [
        {
          key: `channel:${principal.channel}`,
          windowMs: DAY_MS,
          max: { tokens: config.tokensPerDay },
          label: "this channel's daily token budget",
        },
      ],
      onRefused: ({ principal, retryAfterMs }) =>
        console.warn(`[ambient] ${principal.channel}: tick refused, budget resets in ${Math.ceil(retryAfterMs / 60_000)} min`),
    },
    telemetry: {
      onRunFinished: (run, outcome) => {
        console.log(
          `[ambient] ${run.principal.channel}: run ${run.runId} ${outcome.status} (${run.trigger}) ` +
            `${outcome.usage.inputTokens + outcome.usage.outputTokens} tokens`,
        );
      },
    },
  },
  handler: { basePath: "/latch" },
  cronIntervalMs: 30_000,
});

/** One schedule per watched channel; idempotent across restarts and cadence changes. */
async function ensureSchedule(channel: string): Promise<void> {
  const principal: Principal = { channel };
  const existing = await runtime.listSchedules({ principal });
  const mine = existing.filter((s) => s.agent === "watcher" && s.enabled);
  if (mine.some((s) => s.cron === config.every)) return;
  for (const s of mine) await runtime.unschedule({ principal, id: s.id }); // cadence changed
  const created = await runtime.schedule({
    principal,
    agent: "watcher",
    cron: config.every,
    prompt: TICK_PROMPT,
    // Nobody is here to answer a parked question; every tick still matters.
    onParked: "fire",
  });
  console.log(`[ambient] ${channel}: scheduled ${created.id} (${config.every})`);
}

async function dropSchedules(channel: string): Promise<void> {
  const principal: Principal = { channel };
  for (const s of await runtime.listSchedules({ principal })) await runtime.unschedule({ principal, id: s.id });
}

// Watched channels = channels the bot is in. State and history stay when it
// leaves (the principal partition is still there if it is invited back).
const watchlist = createWatchlist({
  list: () => slack.myChannels(),
  onAdd: async (ch) => {
    console.log(`[ambient] watching #${ch.name} (${ch.id})`);
    await ensureSchedule(ch.id);
  },
  onRemove: async (id) => {
    console.log(`[ambient] left ${id}: schedule dropped`);
    await dropSchedules(id);
  },
  onError: (e) => console.error("[ambient] channel discovery failed:", e),
});
await watchlist.refresh();
const discovery = setInterval(() => void watchlist.refresh(), config.discoveryMs);
discovery.unref();

const isWatched = (channel: string): boolean => watchlist.has(channel);

// ---- Operator routes -------------------------------------------------------
// The app's own routes first, then Latch's HTTP surface under /latch (its
// Hono app is a catch-all, so it has to mount last).
const app = new Hono();

function authorized(req: Request): boolean {
  if (!config.adminToken) return true;
  return req.headers.get("authorization") === `Bearer ${config.adminToken}`;
}

app.use("/channels/*", async (c, next) => {
  if (!authorized(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  // Wildcard middleware sees no route params; the channel is the second segment.
  const channel = c.req.path.split("/")[2];
  if (channel && !isWatched(channel)) return c.json({ error: "not a watched channel" }, 404);
  await next();
});

/** The state document as the agent last wrote it. */
app.get("/channels/:id/state", async (c) => c.json(await state.load(c.req.param("id"))));

/** Recent runs: status, usage, cost. */
app.get("/channels/:id/runs", async (c) => {
  const principal: Principal = { channel: c.req.param("id") };
  return c.json(await runtime.listRuns({ principal, limit: 20 }));
});

/** The monologue of the most recent tick: what it read, thought, and did. */
app.get("/channels/:id/monologue", async (c) => {
  const principal: Principal = { channel: c.req.param("id") };
  const [chat] = await runtime.listChats({ principal, limit: 1 });
  if (!chat) return c.json({ chatId: null, messages: [] });
  const history = await runtime.loadHistory({ chatId: chat.id, principal });
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
  return c.json({ chatId: chat.id, messages });
});

/** Make the channel's schedule due and run the cron pass now — the same path the cadence uses. */
async function tickNow(channel: string) {
  const principal: Principal = { channel };
  const schedules = await runtime.listSchedules({ principal });
  const s = schedules.find((x) => x.agent === "watcher" && x.enabled);
  if (!s) return null;
  await runtime.runScheduleNow({ principal, id: s.id });
  return runtime.cron();
}

/** Fire the channel's schedule now. */
app.post("/channels/:id/tick", async (c) => {
  const result = await tickNow(c.req.param("id"));
  return result ? c.json(result) : c.json({ error: "no schedule" }, 404);
});

// Slack Events API: app_mention only. Acknowledged at once; the tick runs after.
if (config.signingSecret) {
  const events = createEventsHandler({
    signingSecret: config.signingSecret,
    // A mention from a channel we have not listed yet means we were just invited.
    isWatched: async (channel) => {
      if (!watchlist.has(channel)) await watchlist.refresh();
      return watchlist.has(channel);
    },
    state,
    botUserId: () => slack.botUserId(),
    wake: (channel) => {
      void tickNow(channel).catch((e) => console.error(`[ambient] ${channel}: wake failed:`, e));
    },
  });
  app.post("/slack/events", (c) => events(c.req.raw));
} else {
  console.log("[ambient] SLACK_SIGNING_SECRET unset — @-mentions are seen on the next tick, not immediately");
}

app.route("/latch", latch);

serve({ fetch: app.fetch, port: config.port });
console.log(`👁  ambient listening on http://localhost:${config.port}`);
const first = watchlist.ids()[0] ?? "<channel id>";
console.log(`   watching ${watchlist.ids().length} channel(s) every "${config.every}" with ${config.model}; state in ${config.stateIn}`);
console.log(`   /invite the bot to a channel to watch it; discovery every ${Math.round(config.discoveryMs / 1000)}s`);
console.log(`   curl http://localhost:${config.port}/channels/${first}/state`);
console.log(`   curl -X POST http://localhost:${config.port}/channels/${first}/tick`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void stop().finally(() => process.exit(0));
  });
}
