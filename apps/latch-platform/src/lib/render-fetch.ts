import { isBlockedHost } from "./web-fetch";

/**
 * `renderFetch()` — client for the in-repo render service (packages/renderer):
 * render-once fetch of a JS page in headless Chromium, returning rendered text
 * + schema.org JSON-LD + links. The JS-page rung of the fetch ladder, sibling
 * of `webFetch()`; exposed to agents as the `render_fetch` app tool.
 *
 * The service is a separate container deployment (Chromium can't run in this
 * serverless bundle): RENDER_FETCH_URL points at it, RENDER_FETCH_TOKEN is
 * sent as both Bearer and x-vercel-protection-bypass. Runs in the app process;
 * the same SSRF guard as web_fetch is applied to the target url before the
 * request leaves (the service enforces its own guard too).
 */

const DEFAULT_TIMEOUT_MS = 90_000; // a render can be slow: real browser + network idle
const MAX_RESULT_BYTES = 60_000; // cap rendered text handed to the model

/** One scripted pre-extraction action (mirrors the service's Step). */
export interface RenderStep {
  /** CSS or `text=Label` selector to click. */
  click?: string;
  /** Selector to wait for before continuing. */
  waitFor?: string;
  /** Scroll to the bottom to trigger lazy-loaded content. */
  scroll?: boolean;
  /** Fixed pause in ms (capped service-side). */
  waitMs?: number;
}

export interface RenderFetchArgs {
  url: string;
  /** Comma-separated subset of: text, jsonLd, links, clickables, html. Default text,jsonLd,links. */
  include?: string;
  /** CSS selector to wait for before extracting. */
  waitFor?: string;
  /** CSS selector to click once before extracting (e.g. cookie consent). */
  clickSelector?: string;
  /** Ordered actions run in the single render pass, before extraction. */
  steps?: RenderStep[];
  /** Auto-scroll to the bottom before extracting (lazy-loaded content). */
  scroll?: boolean;
}

interface Clickable {
  kind: "button" | "link" | "input";
  text: string;
  selector: string;
}

export type RenderFetchResult =
  | {
      ok: true;
      url?: string;
      title?: string;
      jsonLd?: unknown[];
      text?: string;
      links?: { text?: string; href?: string }[];
      clickables?: Clickable[];
      html?: string;
      truncated: boolean;
      warnings?: string[];
    }
  | { ok: false; status?: number; error: string };

interface ServiceResponse {
  ok?: boolean;
  url?: string;
  title?: string;
  jsonLd?: unknown[];
  text?: string;
  links?: { text?: string; href?: string }[];
  clickables?: Clickable[];
  html?: string;
  truncated?: boolean;
  warnings?: string[];
  error?: string;
}

/**
 * Where the renderer lives. Prod (Vercel): RENDER_FETCH_URL must point at the
 * deployed container — there is no sane default. Local dev: defaults to the
 * renderer's dev port (`pnpm --filter @intentface/latch-renderer dev` → :8787)
 * so the tool works with zero .env setup; a dead local renderer just surfaces
 * as a tool error ("fetch failed"), not a platform failure.
 */
function renderBaseUrl(): string | undefined {
  const configured = process.env.RENDER_FETCH_URL?.replace(/\/$/, "");
  if (configured) return configured;
  return process.env.VERCEL ? undefined : "http://localhost:8787";
}

/** True when the render service is configured (the tool is only registered then). */
export function renderFetchConfigured(): boolean {
  return Boolean(renderBaseUrl());
}

function capText(s: string, maxBytes: number): { text: string; capped: boolean } {
  if (Buffer.byteLength(s) <= maxBytes) return { text: s, capped: false };
  let out = s;
  while (Buffer.byteLength(out) > maxBytes) out = out.slice(0, Math.floor(out.length * 0.9));
  return { text: out, capped: true };
}

export async function renderFetch(args: RenderFetchArgs): Promise<RenderFetchResult> {
  const base = renderBaseUrl();
  if (!base) return { ok: false, error: "Render service not configured (RENDER_FETCH_URL unset)." };
  const token = process.env.RENDER_FETCH_TOKEN;

  let target: URL;
  try {
    target = new URL(args.url);
  } catch {
    return { ok: false, error: `Malformed url: ${JSON.stringify(args.url)}` };
  }
  if (target.protocol !== "https:") return { ok: false, error: "Only https URLs can be rendered." };
  if (isBlockedHost(target.hostname)) {
    return { ok: false, error: "URL blocked (private/loopback hosts are not allowed)." };
  }

  let endpoint: URL;
  try {
    endpoint = new URL(base + "/render");
  } catch {
    return { ok: false, error: `Render service URL is malformed (RENDER_FETCH_URL=${JSON.stringify(base)}).` };
  }
  endpoint.searchParams.set("url", target.href);
  if (args.include) endpoint.searchParams.set("include", args.include);
  if (args.waitFor) endpoint.searchParams.set("waitFor", args.waitFor);
  if (args.clickSelector) endpoint.searchParams.set("clickSelector", args.clickSelector);
  if (args.steps?.length) endpoint.searchParams.set("steps", JSON.stringify(args.steps));
  if (args.scroll) endpoint.searchParams.set("scroll", "true");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        ...(token
          ? { authorization: `Bearer ${token}`, "x-vercel-protection-bypass": token }
          : {}),
      },
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as ServiceResponse | null;
    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        status: res.status,
        error: data?.error ?? `Render service returned HTTP ${res.status}`,
      };
    }
    const text = data.text ? capText(data.text, MAX_RESULT_BYTES) : undefined;
    const html = data.html ? capText(data.html, MAX_RESULT_BYTES) : undefined;
    return {
      ok: true,
      url: data.url,
      title: data.title,
      ...(data.jsonLd?.length ? { jsonLd: data.jsonLd } : {}),
      ...(text ? { text: text.text } : {}),
      ...(data.links?.length ? { links: data.links } : {}),
      ...(data.clickables?.length ? { clickables: data.clickables } : {}),
      ...(html ? { html: html.text } : {}),
      truncated: Boolean(data.truncated || text?.capped || html?.capped),
      ...(data.warnings?.length ? { warnings: data.warnings } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error && e.name === "AbortError"
          ? `Render timed out after ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s`
          : e instanceof Error
            ? e.message
            : "render request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
