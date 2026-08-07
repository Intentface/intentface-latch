import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramStore, migrateTelegram } from "./telegram-store";
import { createSlackStore, migrateSlack } from "./slack-store";
import type { Principal } from "./session";

/**
 * The delivery gate. This is the only thing standing between a cron tick and
 * someone's DM, so every refusal has its own case — an outbound push has no
 * inbound message to imply the recipient wanted it.
 */

const members = new Set<string>();
vi.mock("./auth", () => ({
  isOrgMember: async (userId: string, orgId: string) => members.has(`${userId}@${orgId}`),
}));

let client: Client;
let telegramStore: ReturnType<typeof createTelegramStore>;
let slackStore: ReturnType<typeof createSlackStore>;

vi.mock("./latch", () => ({
  getLatch: async () => ({
    telegramStore,
    slackStore,
    // Only reached by listAgentChannels' Slack branch.
    credentials: { get: async () => undefined },
  }),
}));

const {
  DeliveryError,
  deliveryOptions,
  listAgentChannels,
  parseScheduleDelivery,
  resolveDelivery,
  resolveOfferedDelivery,
} = await import("./schedule-delivery");

const owner: Principal = { orgId: "org1", userId: "u1" };
const bot = { id: "b1", agent: "todo", orgId: "org1", handle: "todo-bot" };

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrateTelegram(client);
  await migrateSlack(client);
  telegramStore = createTelegramStore(client);
  slackStore = createSlackStore(client);
  members.clear();
  members.add("u1@org1");
});

afterEach(() => {
  client.close();
  vi.restoreAllMocks();
});

/** The happy path everything else is a deviation from. */
async function linkedBot() {
  await telegramStore.create(bot);
  await telegramStore.linkIdentity({
    botId: "b1",
    telegramUserId: "555",
    userId: "u1",
    orgId: "org1",
  });
}

describe("parseScheduleDelivery", () => {
  it("accepts the two shapes and rejects anything else", () => {
    expect(parseScheduleDelivery({ kind: "telegram", botId: "b1" })).toEqual({
      kind: "telegram",
      botId: "b1",
    });
    expect(parseScheduleDelivery({ kind: "slack", appId: "A1", channel: "C1" })).toEqual({
      kind: "slack",
      appId: "A1",
      channel: "C1",
    });
    expect(parseScheduleDelivery(null)).toBeNull();
    expect(parseScheduleDelivery({ kind: "telegram" })).toBeNull(); // no botId
    expect(parseScheduleDelivery({ kind: "slack", appId: "A1" })).toBeNull(); // no channel
    expect(parseScheduleDelivery({ kind: "email", to: "a@b.c" })).toBeNull();
  });
});

describe("resolveDelivery: telegram", () => {
  it("resolves the DM from the identity row, not from the caller", async () => {
    await linkedBot();
    await expect(
      resolveDelivery(owner, "todo", { kind: "telegram", botId: "b1" }),
    ).resolves.toEqual({ kind: "telegram", botId: "b1", telegramUserId: "555" });
  });

  it("accepts a scope-pinned agent ref (what a run carries)", async () => {
    await linkedBot();
    await expect(
      resolveDelivery(owner, "user:todo", { kind: "telegram", botId: "b1" }),
    ).resolves.toMatchObject({ telegramUserId: "555" });
  });

  it("refuses an unlinked user — there is no DM to push into", async () => {
    await telegramStore.create(bot);
    await expect(
      resolveDelivery(owner, "todo", { kind: "telegram", botId: "b1" }),
    ).rejects.toThrow(/haven't linked/i);
  });

  it("refuses another user's link on the same bot", async () => {
    await linkedBot();
    members.add("u2@org1");
    await expect(
      resolveDelivery({ orgId: "org1", userId: "u2" }, "todo", { kind: "telegram", botId: "b1" }),
    ).rejects.toThrow(/haven't linked/i);
  });

  it("refuses a bot in another org", async () => {
    await linkedBot();
    members.add("u1@org2");
    await expect(
      resolveDelivery({ orgId: "org2", userId: "u1" }, "todo", { kind: "telegram", botId: "b1" }),
    ).rejects.toThrow(/isn't in your org/i);
  });

  it("refuses a bot bound to a different agent", async () => {
    await linkedBot();
    await expect(
      resolveDelivery(owner, "weekly", { kind: "telegram", botId: "b1" }),
    ).rejects.toThrow(/serves "todo"/);
  });

  it("refuses a disabled bot", async () => {
    await linkedBot();
    await telegramStore.setStatus("b1", "disabled");
    await expect(
      resolveDelivery(owner, "todo", { kind: "telegram", botId: "b1" }),
    ).rejects.toThrow(/isn't active/i);
  });

  it("refuses a personal-agent bot for anyone but its owner", async () => {
    await telegramStore.create({ ...bot, agentScope: "user", userId: "u1" });
    await telegramStore.linkIdentity({
      botId: "b1",
      telegramUserId: "777",
      userId: "u2",
      orgId: "org1",
    });
    members.add("u2@org1");
    await expect(
      resolveDelivery({ orgId: "org1", userId: "u2" }, "todo", { kind: "telegram", botId: "b1" }),
    ).rejects.toThrow(/only its owner/i);
  });

  it("refuses a linked user who has since left the org", async () => {
    await linkedBot();
    members.clear(); // removed from the org, identity row survives
    await expect(
      resolveDelivery(owner, "todo", { kind: "telegram", botId: "b1" }),
    ).rejects.toThrow(/no longer a member/i);
  });

  it("refuses an unknown bot id", async () => {
    await expect(
      resolveDelivery(owner, "todo", { kind: "telegram", botId: "nope" }),
    ).rejects.toThrow(DeliveryError);
  });
});

describe("resolveDelivery: slack", () => {
  const app = {
    appId: "A1",
    teamId: "T1",
    agent: "todo",
    orgId: "org1",
    userId: "u1",
    botName: "Todo",
  };

  it("resolves for the app owner", async () => {
    await slackStore.bind(app);
    await expect(
      resolveDelivery(owner, "todo", { kind: "slack", appId: "A1", channel: "C1" }),
    ).resolves.toEqual({ kind: "slack", appId: "A1", channel: "C1", ownerUserId: "u1" });
  });

  it("refuses a non-owner, even an org member", async () => {
    await slackStore.bind(app);
    members.add("u2@org1");
    await expect(
      resolveDelivery({ orgId: "org1", userId: "u2" }, "todo", {
        kind: "slack",
        appId: "A1",
        channel: "C1",
      }),
    ).rejects.toThrow(/only the slack app's owner/i);
  });

  it("refuses an app bound to a different agent", async () => {
    await slackStore.bind(app);
    await expect(
      resolveDelivery(owner, "weekly", { kind: "slack", appId: "A1", channel: "C1" }),
    ).rejects.toThrow(/serves "todo"/);
  });

  it("refuses an empty channel", async () => {
    await slackStore.bind(app);
    await expect(
      resolveDelivery(owner, "todo", { kind: "slack", appId: "A1", channel: "" }),
    ).rejects.toThrow(/pick a slack channel/i);
  });
});

describe("listAgentChannels", () => {
  it("offers only linked bots for the right agent", async () => {
    await linkedBot();
    // Same org + agent, but never linked → not offerable.
    await telegramStore.create({ ...bot, id: "b2", handle: "other-bot" });
    // Linked, but a different agent.
    await telegramStore.create({ ...bot, id: "b3", agent: "weekly", handle: "weekly-bot" });
    await telegramStore.linkIdentity({
      botId: "b3",
      telegramUserId: "555",
      userId: "u1",
      orgId: "org1",
    });

    const channels = await listAgentChannels(owner, "todo");
    expect(channels).toEqual([{ kind: "telegram", ref: "b1", label: "todo-bot" }]);
  });

  it("returns nothing for an agent with no bindings", async () => {
    expect(await listAgentChannels(owner, "todo")).toEqual([]);
  });
});

describe("deliveryOptions", () => {
  it("fans a slack app out per channel and leaves telegram as one row", () => {
    expect(
      deliveryOptions([
        { kind: "telegram", ref: "b1", label: "@todobot" },
        {
          kind: "slack",
          ref: "A1",
          label: "Todo",
          channels: [
            { id: "C1", name: "general" },
            { id: "C2", name: "briefs" },
          ],
        },
        // An app whose channels couldn't be listed contributes nothing — this is
        // why callers count entries, not apps, before saying "no channels".
        { kind: "slack", ref: "A2", label: "Broken", channels: [] },
      ]),
    ).toEqual([
      { kind: "telegram", ref: "b1", label: "@todobot" },
      { kind: "slack", ref: "A1", channel: "C1", label: "#general" },
      { kind: "slack", ref: "A1", channel: "C2", label: "#briefs" },
    ]);
  });
});

/**
 * The model-supplied path (builder `deliverTo`, harness `deliver_to`). The two
 * failure modes must stay distinguishable: not-offered is the caller's input
 * being wrong, a throw is the entitlement being gone.
 */
describe("resolveOfferedDelivery", () => {
  it("accepts an offered target and echoes discovery's label", async () => {
    await linkedBot();
    await expect(
      resolveOfferedDelivery(owner, "todo", { kind: "telegram", ref: "b1" }),
    ).resolves.toEqual({ delivery: { kind: "telegram", botId: "b1" }, label: "todo-bot" });
  });

  it("returns null for a ref discovery never offered", async () => {
    await linkedBot();
    expect(await resolveOfferedDelivery(owner, "todo", { kind: "telegram", ref: "b9" })).toBeNull();
  });

  it("returns null for a real bot the caller hasn't linked", async () => {
    await telegramStore.create(bot);
    expect(await resolveOfferedDelivery(owner, "todo", { kind: "telegram", ref: "b1" })).toBeNull();
  });

  it("ignores a stray channel on a telegram target", async () => {
    await linkedBot();
    await expect(
      resolveOfferedDelivery(owner, "todo", { kind: "telegram", ref: "b1", channel: "C1" }),
    ).resolves.toMatchObject({ delivery: { kind: "telegram", botId: "b1" } });
  });

  it("throws — not null — when the target is offered but the gate refuses it", async () => {
    await linkedBot();
    // Discovery doesn't re-check org membership; `resolveDelivery` does. So this
    // is offered and then refused, which must surface as the gate's message.
    members.clear();
    await expect(
      resolveOfferedDelivery(owner, "todo", { kind: "telegram", ref: "b1" }),
    ).rejects.toThrow(DeliveryError);
  });
});
