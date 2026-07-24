import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWhatsappStore, migrateWhatsapp, type WhatsappStore } from "./whatsapp-store";

// Slimmer than the Telegram suite — the store mirrors it; this covers the
// WhatsApp-specific bits and the shared behaviors' wiring.

let client: Client;
let store: WhatsappStore;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrateWhatsapp(client);
  store = createWhatsappStore(client);
});

afterEach(() => {
  client.close();
});

describe("whatsapp store", () => {
  it("creates a bot and mirrors the validated phone number id", async () => {
    await store.create({ id: "w1", agent: "support", orgId: "org1", handle: "wa-support" });
    await store.setPhoneNumberId("w1", "555000");
    expect((await store.get("w1"))!.phoneNumberId).toBe("555000");
  });

  it("applies the cross-user link conflict rule on wa_id", async () => {
    await store.linkIdentity({ botId: "w1", waId: "35840123", userId: "u1", orgId: "org1" });
    expect(
      await store.linkIdentity({ botId: "w1", waId: "35840123", userId: "u2", orgId: "org1" }),
    ).toBe("conflict");
    expect(await store.resolveIdentity("w1", "35840123")).toEqual({
      userId: "u1",
      orgId: "org1",
    });
  });

  it("dedupes wamid delivery keys and replays pendings once", async () => {
    expect(await store.seenDelivery("wb1:35840123:wamid.1")).toBe(false);
    expect(await store.seenDelivery("wb1:35840123:wamid.1")).toBe(true);

    await store.setPending({ botId: "w1", waId: "35840123", text: "held" });
    expect(await store.takePending("w1", "35840123")).toEqual({ text: "held" });
    expect(await store.takePending("w1", "35840123")).toBeNull();
  });
});
