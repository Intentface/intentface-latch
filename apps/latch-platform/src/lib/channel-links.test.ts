import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChannelLinkUrl, verifyChannelLink, type ChannelLinkRef } from "./channel-link";
import { renderLinkConfirmPage } from "./channel-link-confirm";
import {
  channelLinkCsrfToken,
  verifyChannelLinkCsrf,
} from "./channel-link-csrf";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Pull the signed fields back out of a link URL. */
function parts(url: string) {
  const u = new URL(url);
  return {
    path: u.pathname,
    ref: u.searchParams.get("ref")!,
    user: u.searchParams.get("user")!,
    meta: u.searchParams.get("meta") ?? "",
    exp: Number(u.searchParams.get("exp")),
    sig: u.searchParams.get("sig")!,
  };
}
const tg: ChannelLinkRef = { kind: "telegram", botRef: "b1", externalId: "5" };
const wa: ChannelLinkRef = { kind: "whatsapp", botRef: "w1", externalId: "35840123" };
const sl: ChannelLinkRef = { kind: "slack", botRef: "A1", externalId: "U1", meta: "T1" };

describe("channel link tokens", () => {
  it("round-trips a signed link per kind, on the shared /link/<kind> route", () => {
    for (const ref of [tg, wa, sl]) {
      const p = parts(buildChannelLinkUrl("https://x.example", ref));
      expect(p.path).toBe(`/link/${ref.kind}`);
      expect(p.ref).toBe(ref.botRef);
      expect(p.user).toBe(ref.externalId);
      expect(verifyChannelLink({ ...ref, ...(p.meta ? { meta: p.meta } : {}) }, p.exp, p.sig)).toBe(true);
    }
  });

  it("rejects tampered identities, expiries and signatures", () => {
    const p = parts(buildChannelLinkUrl("https://x.example", tg));
    expect(verifyChannelLink({ ...tg, externalId: "6" }, p.exp, p.sig)).toBe(false);
    expect(verifyChannelLink({ ...tg, botRef: "b2" }, p.exp, p.sig)).toBe(false);
    expect(verifyChannelLink(tg, p.exp + 1, p.sig)).toBe(false);
    expect(verifyChannelLink(tg, p.exp, "0".repeat(p.sig.length))).toBe(false);
  });

  it("expires: 10 minutes for DM links, 30 for Slack", () => {
    const t = parts(buildChannelLinkUrl("https://x.example", tg));
    const s = parts(buildChannelLinkUrl("https://x.example", sl));
    expect(t.exp - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(s.exp - Date.now()).toBeGreaterThan(20 * 60_000);
    vi.useFakeTimers();
    vi.setSystemTime(t.exp + 1);
    expect(verifyChannelLink(tg, t.exp, t.sig)).toBe(false);
  });

  it("is not interchangeable across kinds for the same ids", () => {
    // Domain-separated signatures: all kinds share the signing key, so a token
    // for (ref, user) on one channel must not verify on another.
    const p = parts(buildChannelLinkUrl("https://x.example", tg));
    expect(verifyChannelLink({ ...tg, kind: "whatsapp" }, p.exp, p.sig)).toBe(false);
    expect(verifyChannelLink({ ...tg, kind: "slack", meta: "" }, p.exp, p.sig)).toBe(false);
  });

  it("binds the meta into the signature (a Telegram @username, a Slack team id)", () => {
    // The username exists only so the confirm page can show "@who" — but it must
    // be HMAC-covered, or a phisher could relabel their own link with the
    // victim's handle. For Slack the team id is the identity key itself.
    const url = buildChannelLinkUrl("https://x.example", { ...tg, meta: "klaus" });
    const p = parts(url);
    expect(p.meta).toBe("klaus");
    expect(verifyChannelLink({ ...tg, meta: "klaus" }, p.exp, p.sig)).toBe(true);
    expect(verifyChannelLink(tg, p.exp, p.sig)).toBe(false);
    expect(verifyChannelLink({ ...tg, meta: "aleksi" }, p.exp, p.sig)).toBe(false);
    const s = parts(buildChannelLinkUrl("https://x.example", sl));
    expect(verifyChannelLink({ ...sl, meta: "T2" }, s.exp, s.sig)).toBe(false);
    expect(verifyChannelLink({ ...sl, botRef: "A2" }, s.exp, s.sig)).toBe(false);
  });

  it("cannot be forged by shifting field boundaries with a colon", () => {
    const exp = Date.now() + 60_000;
    const a = parts(buildChannelLinkUrl("https://x.example", { ...tg, botRef: "b", externalId: "1:x" }));
    expect(verifyChannelLink({ ...tg, botRef: "b:1", externalId: "x" }, a.exp, a.sig)).toBe(false);
    void exp;
  });
});

describe("link token signing secret", () => {
  it("fails closed in production when BETTER_AUTH_SECRET is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    // Never fall back to a committed default: with a known secret, anyone could
    // forge a link for an arbitrary platform identity.
    for (const ref of [tg, wa, sl]) {
      expect(() => buildChannelLinkUrl("https://x.example", ref)).toThrow(/BETTER_AUTH_SECRET/);
    }
  });

  it("refuses (not throws) verification of inbound links without the secret", () => {
    // The link route calls verify directly — a misconfigured production must
    // refuse the link (302 to link_error), never 500.
    const p = parts(buildChannelLinkUrl("https://x.example", tg));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(verifyChannelLink(tg, p.exp, p.sig)).toBe(false);
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
      csrfToken: "tok-abc",
    });
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    // Both sides of the link are visible — the whole point of the page.
    expect(html).toContain("@klaus (id 5)");
    expect(html).toContain("aleksi@example.com");
    // The mutation is an explicit POST, never the GET that rendered this.
    expect(html).toMatch(/<form method="post"/);
    // ...and the POST carries the CSRF token, so it can't be driven from
    // another origin even if the session cookie were sent.
    expect(html).toContain('name="csrf" value="tok-abc"');
  });

  it("refuses framing, so the button can't be clickjacked", async () => {
    // The page turns one click into an identity-binding write. Framed and
    // overlaid, a victim could be induced to confirm the ATTACKER's link.
    const res = renderLinkConfirmPage({
      channelLabel: "Telegram",
      externalIdentity: "@klaus (id 5)",
      account: { name: "Aleksi" },
      actionUrl: "/telegram/link?bot=b1&user=5",
      switchAccountUrl: "/login",
      csrfToken: "tok",
    });
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // The signed link (and its token) must not leak via Referer either.
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("offers no Confirm button when the identity is linked elsewhere", async () => {
    // `linkIdentity` is fenced and would return "conflict", so a button here
    // would promise something that cannot succeed.
    const res = renderLinkConfirmPage({
      channelLabel: "Telegram",
      externalIdentity: "@klaus (id 5)",
      account: { name: "Aleksi", email: "aleksi@example.com" },
      actionUrl: "/telegram/link?bot=b1&user=5",
      switchAccountUrl: "/login?next=x",
      csrfToken: "tok-abc",
      alreadyLinkedElsewhere: true,
    });
    const html = await res.text();
    expect(html).not.toMatch(/<form method="post"/);
    expect(html).not.toContain("tok-abc");
    expect(html).toContain("already linked to a different Latch");
    // The recovery route stays available.
    expect(html).toContain("Sign in as someone else");
  });

  it("escapes attacker-influenced fields", async () => {
    const res = renderLinkConfirmPage({
      channelLabel: "Telegram",
      externalIdentity: `<script>alert(1)</script>`,
      account: { name: `"><img src=x>` },
      actionUrl: `/telegram/link?un="><script>`,
      switchAccountUrl: "/login",
      csrfToken: "tok",
    });
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`"><img src=x>`);
  });
});

describe("channel-link CSRF tokens", () => {
  const base = {
    channel: "telegram",
    scopeId: "b1",
    externalId: "5",
    sessionUserId: "u-aleksi",
    exp: 1_800_000_000_000,
  };

  it("round-trips a token for the same identities", () => {
    expect(verifyChannelLinkCsrf(channelLinkCsrfToken(base), base)).toBe(true);
  });

  it("rejects a token minted for a DIFFERENT Latch account", () => {
    // The attack the token exists to stop: an attacker holding their own valid
    // signed link cannot produce a token for the victim's session, so a
    // cross-site auto-submitted POST fails even if the cookie were sent.
    const attackers = channelLinkCsrfToken({ ...base, sessionUserId: "u-klaus" });
    expect(verifyChannelLinkCsrf(attackers, base)).toBe(false);
  });

  it("rejects a token bound to a different channel identity, bot, or expiry", () => {
    const token = channelLinkCsrfToken(base);
    expect(verifyChannelLinkCsrf(token, { ...base, externalId: "6" })).toBe(false);
    expect(verifyChannelLinkCsrf(token, { ...base, scopeId: "b2" })).toBe(false);
    expect(verifyChannelLinkCsrf(token, { ...base, exp: base.exp + 1 })).toBe(false);
  });

  it("does not let one channel's token be replayed on another", () => {
    const token = channelLinkCsrfToken(base);
    expect(verifyChannelLinkCsrf(token, { ...base, channel: "slack" })).toBe(false);
  });

  it("rejects a missing or empty token", () => {
    expect(verifyChannelLinkCsrf(undefined, base)).toBe(false);
    expect(verifyChannelLinkCsrf("", base)).toBe(false);
  });

  it("cannot be forged by shifting field boundaries with a colon", () => {
    // Payload fields are length-prefixed, so an id containing the separator
    // must not be able to impersonate a different (id, user) split.
    const a = channelLinkCsrfToken({ ...base, externalId: "5", sessionUserId: "x:u" });
    const b = channelLinkCsrfToken({ ...base, externalId: "5:x", sessionUserId: "u" });
    expect(a).not.toBe(b);
  });
});
