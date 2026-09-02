import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramStore, migrateTelegram } from "@/lib/telegram-store";
import { createSlackStore, migrateSlack } from "@/lib/slack-store";
import type { Principal } from "@/lib/session";

/**
 * The harness schedule tools, against the REAL delivery gate and real stores —
 * only the runtime is faked, so what these assert is the wiring: which target a
 * created schedule ends up carrying.
 *
 * The case that matters most is a WEB chat: it implies no channel, so before
 * `deliver_to` existed an agent could schedule itself but had nowhere to report,
 * and the model had to tell the user "this app only".
 */

const members = new Set<string>();
vi.mock("@/lib/auth", () => ({
  isOrgMember: async (userId: string, orgId: string) => members.has(`${userId}@${orgId}`),
}));

let client: Client;
let telegramStore: ReturnType<typeof createTelegramStore>;
let slackStore: ReturnType<typeof createSlackStore>;
let created: Record<string, unknown>[] = [];

const runtime = {
  listSchedules: async () => [],
  schedule: async (input: Record<string, unknown>) => {
    created.push(input);
    return { id: "sch1", nextRunAt: 1_800_000_000_000, ...input };
  },
};

vi.mock("@/lib/latch", () => ({
  getLatch: async () => ({
    runtime,
    telegramStore,
    slackStore,
    credentials: { get: async () => undefined },
  }),
}));

const { appTools } = await import("./tools");
const create_schedule = appTools.create_schedule as {
  execute: (args: unknown, options: unknown) => Promise<Record<string, unknown>>;
};
const list_delivery_channels = appTools.list_delivery_channels as {
  execute: (args: unknown, options: unknown) => Promise<Record<string, unknown>>;
};

const principal: Principal = { orgId: "org1", userId: "u1" };
const bot = { id: "b1", agent: "todo", orgId: "org1", handle: "todo-bot" };
/** A turn in the web app: no channel, so nothing to derive a target from. */
const webRun = { id: "r1", chatId: "chat_abc", agent: "todo" };
// The runtime rides on the tool context now (what the real runtime supplies
// as `options.context.runtime`), not on a host-global.
const ctx = (run: typeof webRun) => ({ context: { principal, run, runtime } });

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrateTelegram(client);
  await migrateSlack(client);
  telegramStore = createTelegramStore(client);
  slackStore = createSlackStore(client);
  members.clear();
  members.add("u1@org1");
  created = [];
});

afterEach(() => {
  client.close();
  vi.restoreAllMocks();
});

async function linkedBot() {
  await telegramStore.create(bot);
  await telegramStore.linkIdentity({
    botId: "b1",
    telegramUserId: "555",
    userId: "u1",
    orgId: "org1",
  });
}

const spec = { cron: "0 9 * * *", timezone: "Europe/Helsinki", prompt: "Morning brief" };

describe("list_delivery_channels", () => {
  it("offers the user's linked bot for this agent", async () => {
    await linkedBot();
    expect(await list_delivery_channels.execute({}, ctx(webRun))).toEqual({
      channels: [{ kind: "telegram", ref: "b1", label: "todo-bot" }],
      note: undefined,
    });
  });

  it("explains an empty list rather than just returning one", async () => {
    const out = await list_delivery_channels.execute({}, ctx(webRun));
    expect(out.channels).toEqual([]);
    expect(out.note).toMatch(/linked this agent's bot/i);
  });
});

describe("create_schedule from a web chat", () => {
  it("delivers to Telegram when the model passes an offered deliver_to", async () => {
    await linkedBot();
    const out = await create_schedule.execute(
      { ...spec, deliver_to: { kind: "telegram", ref: "b1" } },
      ctx(webRun),
    );
    expect(created[0]).toMatchObject({
      agent: "todo",
      cron: "0 9 * * *",
      delivery: { kind: "telegram", botId: "b1" },
    });
    // The label, not the bare kind — the model reads this back to the user.
    expect(out.deliversTo).toBe("todo-bot");
  });

  it("still schedules app-only with no deliver_to, and says how to fix that", async () => {
    await linkedBot();
    const out = await create_schedule.execute(spec, ctx(webRun));
    expect(created[0].delivery).toBeUndefined();
    expect(out.deliversTo).toMatch(/list_delivery_channels/);
  });

  it("refuses an unoffered target instead of quietly downgrading to app-only", async () => {
    await telegramStore.create(bot); // exists, never linked → not offerable
    const out = await create_schedule.execute(
      { ...spec, deliver_to: { kind: "telegram", ref: "b1" } },
      ctx(webRun),
    );
    expect(out.error).toMatch(/list_delivery_channels/);
    expect(created).toHaveLength(0);
  });

  it("surfaces the gate's own message when entitlement has lapsed", async () => {
    await linkedBot();
    members.clear(); // offered by discovery, refused by resolveDelivery
    const out = await create_schedule.execute(
      { ...spec, deliver_to: { kind: "telegram", ref: "b1" } },
      ctx(webRun),
    );
    expect(out.error).toMatch(/no longer a member/i);
    expect(created).toHaveLength(0);
  });
});

describe("create_schedule from a channel chat", () => {
  it("keeps deriving the target from the chat when deliver_to is omitted", async () => {
    await linkedBot();
    const out = await create_schedule.execute(spec, {
      context: { principal, run: { ...webRun, chatId: "telegram_b1_555" }, runtime },
    });
    expect(created[0]).toMatchObject({ delivery: { kind: "telegram", botId: "b1" } });
    expect(out.deliversTo).toBe("telegram");
  });
});
