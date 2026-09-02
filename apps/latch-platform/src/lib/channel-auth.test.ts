import { describe, expect, it, vi } from "vitest";
import type { ChannelBot, ChannelStore } from "./channel-store";

/**
 * The one identity rule for DM bots, as the inbound gate applies it. The same
 * function backs scheduled delivery (see schedule-delivery.test.ts), so what is
 * pinned here is the refusal wording and the link hand-off.
 */

const members = new Set<string>();
vi.mock("./auth", () => ({
  isOrgMember: async (userId: string, orgId: string) => members.has(`${userId}@${orgId}`),
}));
vi.mock("./base-url", () => ({ baseUrl: () => "https://x.example" }));

const { dmIdentityGate, refusalForLinkedUser } = await import("./channel-auth");

const bot: ChannelBot = { kind: "telegram", id: "b1", agent: "todo", orgId: "org1", userId: "owner", handle: "h", status: "active" };
const storeWith = (rows: Record<string, { userId: string; orgId: string }>) =>
  ({
    resolveIdentity: async (_k: string, _b: string, externalId: string) => rows[externalId] ?? null,
  }) as unknown as ChannelStore;

describe("dmIdentityGate", () => {
  it("mints the linked member's principal", async () => {
    members.add("u1@org1");
    const gate = dmIdentityGate({ kind: "telegram", bot, channelStore: storeWith({ "5": { userId: "u1", orgId: "org1" } }) });
    expect(await gate("5")).toEqual({ allowed: true, principal: { orgId: "org1", userId: "u1" } });
  });

  it("refuses a linked user who left the org, and a non-owner on a personal-agent bot", async () => {
    members.clear();
    const store = storeWith({ "5": { userId: "u1", orgId: "org1" } });
    expect(await dmIdentityGate({ kind: "telegram", bot, channelStore: store })("5")).toMatchObject({
      allowed: false,
      message: expect.stringMatching(/no longer a member/),
    });
    members.add("u1@org1");
    const personal = { ...bot, agentScope: "user" as const };
    expect(await dmIdentityGate({ kind: "telegram", bot: personal, channelStore: store })("5")).toMatchObject({
      allowed: false,
      message: expect.stringMatching(/only its owner/),
    });
    members.add("owner@org1");
    expect(await refusalForLinkedUser(personal, "owner")).toBeNull();
  });

  it("hands an unlinked user a signed link for this bot, carrying the display meta", async () => {
    const gate = dmIdentityGate({ kind: "telegram", bot, channelStore: storeWith({}) });
    const res = await gate("5", "klaus");
    expect(res.allowed).toBe(false);
    const url = new URL(res.linkUrl!);
    expect(url.pathname).toBe("/link/telegram");
    expect(url.searchParams.get("ref")).toBe("b1");
    expect(url.searchParams.get("user")).toBe("5");
    expect(url.searchParams.get("meta")).toBe("klaus");
  });
});
