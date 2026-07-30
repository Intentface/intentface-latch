import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTelegramLinkUrl, verifyTelegramLink } from "./telegram-link";
import { buildWhatsappLinkUrl, verifyWhatsappLink } from "./whatsapp-link";
import { buildLinkUrl, verifyLink } from "./slack-link";
import { renderLinkConfirmPage } from "./channel-link-confirm";

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

  it("binds the display username into the signature", () => {
    // The username exists only so the confirm page can show "@who" — but it
    // must be HMAC-covered, or a phisher could relabel their own link with
    // the victim's handle.
    const url = buildTelegramLinkUrl("https://x.example", "b1", "5", "klaus");
    const u = new URL(url);
    expect(u.searchParams.get("un")).toBe("klaus");
    const p = parts(url);
    expect(verifyTelegramLink(p.bot, p.user, p.exp, p.sig, "klaus")).toBe(true);
    // Stripping or swapping the username invalidates the link.
    expect(verifyTelegramLink(p.bot, p.user, p.exp, p.sig)).toBe(false);
    expect(verifyTelegramLink(p.bot, p.user, p.exp, p.sig, "aleksi")).toBe(false);
    // And a username-less link stays verifiable without one (back-compat shape).
    const bare = parts(buildTelegramLinkUrl("https://x.example", "b1", "5"));
    expect(verifyTelegramLink(bare.bot, bare.user, bare.exp, bare.sig)).toBe(true);
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

describe("link confirmation page", () => {
  it("shows both identities and only links via POST", async () => {
    const res = renderLinkConfirmPage({
      channelLabel: "Telegram",
      externalIdentity: "@klaus (id 5)",
      account: { name: "Aleksi", email: "aleksi@example.com" },
      actionUrl: "/telegram/link?bot=b1&user=5",
      switchAccountUrl: "/login?next=x",
    });
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    // Both sides of the link are visible — the whole point of the page.
    expect(html).toContain("@klaus (id 5)");
    expect(html).toContain("aleksi@example.com");
    // The mutation is an explicit POST, never the GET that rendered this.
    expect(html).toMatch(/<form method="post"/);
  });

  it("escapes attacker-influenced fields", async () => {
    const res = renderLinkConfirmPage({
      channelLabel: "Telegram",
      externalIdentity: `<script>alert(1)</script>`,
      account: { name: `"><img src=x>` },
      actionUrl: `/telegram/link?un="><script>`,
      switchAccountUrl: "/login",
    });
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`"><img src=x>`);
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
