import { chromium, type Browser, type Page } from "playwright";

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

/** Scroll to the bottom in increments so lazy-loaded content fires, then settle. */
async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let y = 0;
      const step = () => {
        window.scrollTo(0, y);
        y += 800;
        if (y < document.body.scrollHeight) setTimeout(step, 150);
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
    result.jsonLd = await page.evaluate(() =>
      [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((s) => {
        try {
          return [JSON.parse(s.textContent ?? "")];
        } catch {
          return [];
        }
      }),
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
      const out: { kind: "button" | "link" | "input"; text: string; id: string }[] = [];
      const label = (el: Element) =>
        ((el as HTMLElement).innerText || el.getAttribute("aria-label") || el.getAttribute("value") || el.getAttribute("placeholder") || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
      for (const b of document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
        out.push({ kind: "button", text: label(b), id: b.id });
      for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]"))
        out.push({ kind: "link", text: label(a), id: a.id });
      for (const i of document.querySelectorAll("input:not([type=submit]):not([type=button]), select, textarea"))
        out.push({ kind: "input", text: label(i) || i.getAttribute("name") || "", id: i.id });
      return out;
    });
    const seen = new Set<string>();
    const clickables: Clickable[] = [];
    for (const e of els) {
      if (!e.text && !e.id) continue;
      const selector = e.id ? `#${e.id}` : `text=${e.text}`;
      if (seen.has(selector)) continue;
      seen.add(selector);
      clickables.push({ kind: e.kind, text: e.text, selector });
      if (clickables.length >= MAX_CLICKABLES) break;
    }
    result.clickables = clickables;
  }
  if (include.has("html")) {
    let html = await page.content();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
      html = html.slice(0, MAX_HTML_BYTES);
      result.truncated = true;
    }
    result.html = html;
  }
  if (include.has("text")) {
    let text = await page.evaluate(() => document.body?.innerText ?? "");
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
      text = text.slice(0, MAX_TEXT_BYTES);
      result.truncated = true;
    }
    result.text = text;
  }
}

export async function render(url: string, opts: RenderOptions): Promise<RenderResult> {
  const browser = await getBrowser();
  const context = await browser.newContext({ locale: "fi-FI", viewport: { width: 1280, height: 2000 } });
  try {
    const page = await context.newPage();
    const warnings: string[] = [];
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
