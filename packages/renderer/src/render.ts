import { chromium, type Browser, type Page } from "playwright";
import { isBlockedHost, isBlockedResolved } from "./ssrf.js";

/**
 * The render core: one stateless pass over a page in headless Chromium —
 * navigate, run optional pre-extraction interactions (waitFor/click/steps/
 * scroll), then extract the requested parts. The browser process is cached per
 * instance and reused while warm; each request gets a fresh context.
 */

const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 2_000;
const INTERACT_TIMEOUT_MS = 5_000;
const MAX_TEXT_BYTES = 100 * 1024;
const MAX_HTML_BYTES = 300 * 1024;
const MAX_LINKS = 100;
const MAX_CLICKABLES = 80;
const MAX_JSONLD_BLOCKS = 50;
const MAX_JSONLD_BYTES = 300 * 1024;

/** Truncate a string to at most `maxBytes` UTF-8 bytes (not UTF-16 code units),
 * without splitting a multi-byte character. Returns whether it was cut. */
function truncateBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s) <= maxBytes) return { text: s, truncated: false };
  const buf = Buffer.from(s, "utf8").subarray(0, maxBytes);
  // Drop a trailing partial multi-byte sequence.
  let end = buf.length;
  while (end > 0 && (buf[end - 1]! & 0b1100_0000) === 0b1000_0000) end--;
  if (end > 0 && (buf[end - 1]! & 0b1000_0000) !== 0) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** Max scripted actions per request (request-contract constant; server validates). */
export const MAX_STEPS = 10;
export const INCLUDE_PARTS = ["text", "jsonLd", "links", "clickables", "html"] as const;
/** Default set when `include` is omitted — the lean, cheap parts. `clickables` and `html` are opt-in. */
export const DEFAULT_INCLUDE = ["text", "jsonLd", "links"] as const;

export type IncludePart = (typeof INCLUDE_PARTS)[number];

/**
 * One scripted action performed in the single render run, before extraction.
 * All run in the same stateless browser context — NOT a persistent session,
 * just a short sequence within one request.
 */
export interface Step {
  /** Playwright selector to click (CSS or `text=Label` — labels appear in `clickables`/`text`). */
  click?: string;
  /** Playwright selector to wait for before continuing. */
  waitFor?: string;
  /** Scroll to the bottom to trigger lazy-loaded content. */
  scroll?: boolean;
  /** Fixed pause in ms (capped), e.g. to let an animation/XHR settle. */
  waitMs?: number;
}

export interface RenderOptions {
  include: ReadonlySet<IncludePart>;
  waitFor?: string;
  clickSelector?: string;
  steps?: Step[];
  scroll?: boolean;
}

export interface PageLink {
  text: string;
  href: string;
}

/** A clickable/interactive element the agent can target in a later `click` step. */
export interface Clickable {
  kind: "button" | "link" | "input";
  text: string;
  /** Best-effort selector to reuse: `#id` when present, else a `text=` selector. */
  selector: string;
}

export interface RenderResult {
  ok: true;
  url: string;
  title: string;
  truncated: boolean;
  jsonLd?: unknown[];
  links?: PageLink[];
  clickables?: Clickable[];
  html?: string;
  text?: string;
  warnings?: string[];
}

let browserPromise: Promise<Browser> | undefined;

async function getBrowser(): Promise<Browser> {
  const existing = await browserPromise?.catch(() => undefined);
  if (existing?.isConnected()) return existing;
  browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

/** Close the cached browser (SIGTERM cleanup). */
export async function closeBrowser(): Promise<void> {
  await (await browserPromise?.catch(() => undefined))?.close().catch(() => {});
}

/** Scroll to the bottom in increments so lazy-loaded content fires, then settle.
 * Bounded by iteration count AND elapsed time so an infinite-scroll page (whose
 * scrollHeight keeps growing) can't keep the evaluate pending forever. */
async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const MAX_STEPS = 60; // ~48k px of scroll
    const MAX_MS = 8_000;
    await new Promise<void>((resolve) => {
      const start = Date.now();
      let y = 0;
      let steps = 0;
      const step = () => {
        window.scrollTo(0, y);
        y += 800;
        steps += 1;
        if (y < document.body.scrollHeight && steps < MAX_STEPS && Date.now() - start < MAX_MS)
          setTimeout(step, 150);
        else resolve();
      };
      step();
    });
  });
  await page.waitForTimeout(500);
}

/** Run the optional pre-extraction interactions in order, collecting warnings. */
async function interact(page: Page, opts: RenderOptions, warnings: string[]): Promise<void> {
  if (opts.waitFor) {
    await page.waitForSelector(opts.waitFor, { timeout: INTERACT_TIMEOUT_MS }).catch(() => {
      warnings.push(`waitFor: selector "${opts.waitFor}" did not appear within ${INTERACT_TIMEOUT_MS} ms`);
    });
  }
  if (opts.clickSelector) {
    const clicked = await page.click(opts.clickSelector, { timeout: INTERACT_TIMEOUT_MS }).then(() => true).catch(() => false);
    if (clicked) {
      await page.waitForLoadState("networkidle", { timeout: INTERACT_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(1_000);
    } else {
      warnings.push(`clickSelector: could not click "${opts.clickSelector}" within ${INTERACT_TIMEOUT_MS} ms`);
    }
  }
  for (const [i, step] of (opts.steps ?? []).entries()) {
    if (step.click) {
      const ok = await page.click(step.click, { timeout: INTERACT_TIMEOUT_MS }).then(() => true).catch(() => false);
      if (!ok) warnings.push(`steps[${i}].click: could not click "${step.click}"`);
      else await page.waitForLoadState("networkidle", { timeout: INTERACT_TIMEOUT_MS }).catch(() => {});
    } else if (step.waitFor) {
      await page.waitForSelector(step.waitFor, { timeout: INTERACT_TIMEOUT_MS }).catch(() => {
        warnings.push(`steps[${i}].waitFor: "${step.waitFor}" did not appear`);
      });
    } else if (step.scroll) {
      await autoScroll(page);
    } else if (step.waitMs != null) {
      await page.waitForTimeout(Math.min(Math.max(step.waitMs, 0), INTERACT_TIMEOUT_MS));
    }
  }
  if (opts.scroll) await autoScroll(page);
}

/** Extract the requested parts from the settled page into `result`. */
async function extract(page: Page, opts: RenderOptions, result: RenderResult, warnings: string[]): Promise<void> {
  const { include } = opts;
  if (include.has("jsonLd")) {
    // Bound how much JSON-LD a page can push at us: cap the number of blocks
    // and the cumulative source bytes parsed, so a hostile/broken page with
    // hundreds of huge ld+json scripts can't blow memory or the response.
    result.jsonLd = await page.evaluate(
      ({ maxBlocks, maxBytes }) => {
        const out: unknown[] = [];
        let bytes = 0;
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          if (out.length >= maxBlocks) break;
          const src = s.textContent ?? "";
          bytes += src.length;
          if (bytes > maxBytes) break;
          try {
            out.push(JSON.parse(src));
          } catch {
            /* skip invalid JSON */
          }
        }
        return out;
      },
      { maxBlocks: MAX_JSONLD_BLOCKS, maxBytes: MAX_JSONLD_BYTES },
    );
  }
  if (include.has("links")) {
    const links = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => ({
        text: (a.innerText ?? "").trim().slice(0, 120),
        href: a.href,
      })),
    );
    const seen = new Set<string>();
    result.links = links
      .filter((l) => /^https?:/.test(l.href) && l.text)
      .filter((l) => !seen.has(l.href) && seen.add(l.href));
    if (result.links.length > MAX_LINKS) {
      result.links = result.links.slice(0, MAX_LINKS);
      warnings.push(`links: capped at ${MAX_LINKS}`);
    }
  }
  if (include.has("clickables")) {
    const els = await page.evaluate(() => {
      // Build the id selector here, in the page, where CSS.escape exists — a
      // bare `#${id}` breaks on valid ids with :, ., spaces, or leading digits,
      // which would make the clickables → steps.click workflow fail.
      const idSel = (el: Element) => (el.id ? `#${CSS.escape(el.id)}` : "");
      const out: { kind: "button" | "link" | "input"; text: string; idSel: string }[] = [];
      const label = (el: Element) =>
        ((el as HTMLElement).innerText || el.getAttribute("aria-label") || el.getAttribute("value") || el.getAttribute("placeholder") || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
      for (const b of document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
        out.push({ kind: "button", text: label(b), idSel: idSel(b) });
      for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]"))
        out.push({ kind: "link", text: label(a), idSel: idSel(a) });
      for (const i of document.querySelectorAll("input:not([type=submit]):not([type=button]), select, textarea"))
        out.push({ kind: "input", text: label(i) || i.getAttribute("name") || "", idSel: idSel(i) });
      return out;
    });
    const seen = new Set<string>();
    const clickables: Clickable[] = [];
    for (const e of els) {
      if (!e.text && !e.idSel) continue;
      // Prefer the (escaped) id selector; else a text= selector Playwright can use.
      const selector = e.idSel || `text=${e.text}`;
      if (seen.has(selector)) continue;
      seen.add(selector);
      clickables.push({ kind: e.kind, text: e.text, selector });
      if (clickables.length >= MAX_CLICKABLES) break;
    }
    result.clickables = clickables;
  }
  if (include.has("html")) {
    // Byte-aware cap: `.slice(n)` counts UTF-16 units, so multi-byte chars
    // (e.g. Finnish ä/ö = 2 bytes) let a char-sliced string exceed the byte
    // limit the check just measured. truncateBytes cuts on the real byte count.
    const { text: html, truncated } = truncateBytes(await page.content(), MAX_HTML_BYTES);
    result.html = html;
    if (truncated) result.truncated = true;
  }
  if (include.has("text")) {
    const { text, truncated } = truncateBytes(
      await page.evaluate(() => document.body?.innerText ?? ""),
      MAX_TEXT_BYTES,
    );
    result.text = text;
    if (truncated) result.truncated = true;
  }
}

export async function render(url: string, opts: RenderOptions): Promise<RenderResult> {
  const browser = await getBrowser();
  const context = await browser.newContext({ locale: "fi-FI", viewport: { width: 1280, height: 2000 } });
  try {
    const page = await context.newPage();
    const warnings: string[] = [];

    // SSRF, everywhere — not just the initial URL. The server validates the
    // FIRST host, but a public page can 3xx-redirect, script-navigate, or pull
    // subresources toward a private/loopback/metadata address (169.254.169.254).
    // Intercept EVERY request the browser makes: string blocklist on all (cheap,
    // catches literal private IPs incl. cloud metadata), DNS-resolution backstop
    // on navigations (defeats a public name that resolves private, incl. after a
    // redirect). A blocked request is aborted, not followed.
    await context.route("**/*", async (route) => {
      const req = route.request();
      let host: string;
      try {
        host = new URL(req.url()).hostname;
      } catch {
        return route.continue(); // data:/about: etc. — no host to attack
      }
      if (!host) return route.continue();
      if (isBlockedHost(host)) return route.abort("blockedbyclient");
      if (req.isNavigationRequest() && (await isBlockedResolved(host))) {
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS); // let late JS (price widgets) settle

    await interact(page, opts, warnings);

    const result: RenderResult = { ok: true, url: page.url(), title: await page.title(), truncated: false };
    await extract(page, opts, result, warnings);
    if (warnings.length) result.warnings = warnings;
    return result;
  } finally {
    await context.close().catch(() => {});
  }
}
