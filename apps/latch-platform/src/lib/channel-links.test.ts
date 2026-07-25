import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTelegramLinkUrl, verifyTelegramLink } from "./telegram-link";
import { buildWhatsappLinkUrl, verifyWhatsappLink } from "./whatsapp-link";
import { buildLinkUrl, verifyLink } from "./slack-link";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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

/** Slack links carry (team, user) rather than (bot, user). */
function slackParts(url: string) {
  const u = new URL(url);
  return {
    path: u.pathname,
    team: u.searchParams.get("team")!,
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

describe("link token signing secret", () => {
  it("fails closed in production when BETTER_AUTH_SECRET is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(() => buildTelegramLinkUrl("https://x.example", "b1", "5")).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => buildWhatsappLinkUrl("https://x.example", "w1", "35840123")).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    // Slack must not fall back to a committed default: with a known secret,
    // anyone could forge a link for an arbitrary Slack identity.
    expect(() => buildLinkUrl("https://x.example", "T1", "U1")).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("refuses (not throws) verification of inbound links without the secret", () => {
    // The link routes call verify directly — a misconfigured production must
    // refuse the link (302 to link_error), never 500.
    const t = parts(buildTelegramLinkUrl("https://x.example", "b1", "5"));
    const w = parts(buildWhatsappLinkUrl("https://x.example", "w1", "35840123"));
    const s = slackParts(buildLinkUrl("https://x.example", "T1", "U1"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(verifyTelegramLink(t.bot, t.user, t.exp, t.sig)).toBe(false);
    expect(verifyWhatsappLink(w.bot, w.user, w.exp, w.sig)).toBe(false);
    expect(verifyLink(s.team, s.user, s.exp, s.sig)).toBe(false);
  });
});

describe("slack link tokens", () => {
  it("round-trips a signed link", () => {
    const p = slackParts(buildLinkUrl("https://x.example", "T1", "U1"));
    expect(p.path).toBe("/slack/link");
    expect(verifyLink(p.team, p.user, p.exp, p.sig)).toBe(true);
  });

  it("rejects tampered identities and expiries", () => {
    const p = slackParts(buildLinkUrl("https://x.example", "T1", "U1"));
    expect(verifyLink(p.team, "U2", p.exp, p.sig)).toBe(false);
    expect(verifyLink("T2", p.user, p.exp, p.sig)).toBe(false);
    expect(verifyLink(p.team, p.user, p.exp + 1, p.sig)).toBe(false);
  });

  it("expires", () => {
    const p = slackParts(buildLinkUrl("https://x.example", "T1", "U1"));
    vi.useFakeTimers();
    vi.setSystemTime(p.exp + 1);
    expect(verifyLink(p.team, p.user, p.exp, p.sig)).toBe(false);
  });

  it("is not interchangeable with the other channels' tokens for the same ids", () => {
    // Domain-separated signatures: all three share the signing key, so a token
    // for (id, id) on one channel must not verify on another.
    const s = slackParts(buildLinkUrl("https://x.example", "b1", "5"));
    expect(verifyTelegramLink("b1", "5", s.exp, s.sig)).toBe(false);
    expect(verifyWhatsappLink("b1", "5", s.exp, s.sig)).toBe(false);
    const t = parts(buildTelegramLinkUrl("https://x.example", "b1", "5"));
    expect(verifyLink("b1", "5", t.exp, t.sig)).toBe(false);
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
