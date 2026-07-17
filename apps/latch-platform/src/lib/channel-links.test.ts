import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTelegramLinkUrl, verifyTelegramLink } from "./telegram-link";
import { buildWhatsappLinkUrl, verifyWhatsappLink } from "./whatsapp-link";

afterEach(() => {
  vi.useRealTimers();
});

function parts(url: string) {
  const u = new URL(url);
  return {
    path: u.pathname,
    bot: u.searchParams.get("bot")!,
    user: u.searchParams.get("user")!,
    exp: Number(u.searchParams.get("exp")),
    sig: u.searchParams.get("sig")!,
  };
}

describe("telegram link tokens", () => {
  it("round-trips a signed link", () => {
    const p = parts(buildTelegramLinkUrl("https://x.example", "b1", "5"));
    expect(p.path).toBe("/telegram/link");
    expect(verifyTelegramLink(p.bot, p.user, p.exp, p.sig)).toBe(true);
  });

  it("rejects tampered identities", () => {
    const p = parts(buildTelegramLinkUrl("https://x.example", "b1", "5"));
    expect(verifyTelegramLink(p.bot, "6", p.exp, p.sig)).toBe(false);
    expect(verifyTelegramLink("b2", p.user, p.exp, p.sig)).toBe(false);
    expect(verifyTelegramLink(p.bot, p.user, p.exp + 1, p.sig)).toBe(false);
  });

  it("expires after 10 minutes", () => {
    const p = parts(buildTelegramLinkUrl("https://x.example", "b1", "5"));
    vi.useFakeTimers();
    vi.setSystemTime(p.exp + 1);
    expect(verifyTelegramLink(p.bot, p.user, p.exp, p.sig)).toBe(false);
  });

  it("is not interchangeable with a WhatsApp token for the same ids", () => {
    // Domain-separated signatures: same (bot, user) must not verify cross-channel.
    const p = parts(buildTelegramLinkUrl("https://x.example", "b1", "5"));
    expect(verifyWhatsappLink(p.bot, p.user, p.exp, p.sig)).toBe(false);
  });
});

describe("whatsapp link tokens", () => {
  it("round-trips a signed link", () => {
    const p = parts(buildWhatsappLinkUrl("https://x.example", "w1", "35840123"));
    expect(p.path).toBe("/whatsapp/link");
    expect(verifyWhatsappLink(p.bot, p.user, p.exp, p.sig)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const p = parts(buildWhatsappLinkUrl("https://x.example", "w1", "35840123"));
    expect(verifyWhatsappLink(p.bot, p.user, p.exp, "0".repeat(p.sig.length))).toBe(false);
  });
});
