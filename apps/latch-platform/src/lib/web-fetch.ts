import TurndownService from "turndown";
import { isBlockedHost, isBlockedResolved } from "@intentface/latch-net";
import { pinnedFetch } from "@intentface/latch-net/pinned";

/**
 * Robust URL fetching for the `web_fetch` tool — mirrors eve's implementation
 * so pages come back as clean markdown/text instead of raw HTML, with a
 * browser User-Agent, content negotiation, a timeout, a Cloudflare-challenge
 * retry, a size cap, and head-truncation. Runs in the app process (not the
 * sandbox); private/loopback hosts are blocked (SSRF).
 */

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_REDIRECTS = 4;

// Browser-like UA so servers return full content, not bot-degraded pages.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const HONEST_UA = "intentface-latch-agent";

export type WebFetchFormat = "markdown" | "text" | "html";

export type WebFetchResult =
  | { ok: true; status: number; contentType: string; content: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Full SSRF gate for one hop: protocol, the string-level blocklist, and the DNS
 * backstop (a public NAME that resolves to a private address — the string check
 * alone cannot see that). Applied to the initial URL AND every redirect target.
 */
async function blockedReason(t: URL): Promise<string | null> {
  if (t.protocol !== "http:" && t.protocol !== "https:") {
    return "Only http(s) URLs are allowed.";
  }
  if (isBlockedHost(t.hostname) || (await isBlockedResolved(t.hostname))) {
    return "Host is not allowed.";
  }
  return null;
}

function buildHeaders(format: WebFetchFormat): Record<string, string> {
  const accept =
    format === "markdown"
      ? "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
      : format === "text"
        ? "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        : "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";
  return { Accept: accept, "Accept-Language": "en-US,en;q=0.9", "User-Agent": BROWSER_USER_AGENT };
}

/** HTML → Markdown (Turndown), dropping script/style/meta/link noise. */
export function convertHtmlToMarkdown(html: string): string {
  const service = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    headingStyle: "atx",
    hr: "---",
  });
  service.remove(["script", "style", "meta", "link"]);
  return service.turndown(html);
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&gt;": ">",
  "&lt;": "<",
  "&nbsp;": " ",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&#x2f;": "/",
};

/** Strip HTML to readable text (no Turndown) — for `format: "text"`. */
export function extractTextFromHtml(html: string): string {
  let text = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(
    /<\/(p|div|br|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|aside|main|figure|figcaption|details|summary)>/gi,
    "\n",
  );
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&[a-z#0-9]+;/gi, (m) => ENTITY_MAP[m.toLowerCase()] ?? m);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Keep the HEAD of long content (the start = the article, not the footer). */
function headTruncate(text: string): { text: string; truncated: boolean } {
  let out = text;
  let truncated = false;
  const lines = out.split("\n");
  if (lines.length > MAX_OUTPUT_LINES) {
    out = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(out) > MAX_OUTPUT_BYTES) {
    out = out.slice(0, MAX_OUTPUT_BYTES);
    truncated = true;
  }
  return { text: out, truncated };
}

export async function webFetch(args: {
  url: string;
  format?: WebFetchFormat;
  timeout?: number;
}): Promise<WebFetchResult> {
  const format = args.format ?? "markdown";
  let u: URL;
  try {
    u = new URL(args.url);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
  const timeoutMs = Math.min(
    args.timeout != null ? args.timeout * 1000 : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = buildHeaders(format);

  /**
   * Follow redirects MANUALLY so each hop is re-gated: with `redirect: "follow"`
   * a public URL that 302s to an internal address (e.g. cloud metadata) would be
   * fetched transparently, and only the first host would ever be checked.
   */
  const fetchGuarded = async (
    start: URL,
    reqHeaders: Record<string, string>,
  ): Promise<Response | { error: string }> => {
    let current = start;
    for (let hop = 0; ; hop++) {
      const bad = await blockedReason(current);
      if (bad) return { error: bad };
      // Pinned fetch: the SSRF vetting also runs inside the connection's own
      // DNS lookup, so `blockedReason` above is the well-messaged pre-check,
      // not the last line of defense against rebinding.
      const res = await pinnedFetch(current, { headers: reqHeaders, signal, redirect: "manual" });
      const location =
        res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      if (hop >= MAX_REDIRECTS) return { error: "Too many redirects." };
      try {
        current = new URL(location, current);
      } catch {
        return { error: "Invalid redirect location." };
      }
    }
  };

  let response: Response;
  try {
    const initial = await fetchGuarded(u, headers);
    if ("error" in initial) return { ok: false, error: initial.error };
    // Cloudflare may block browser UAs from non-browser TLS; retry honestly.
    if (initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge") {
      const retry = await fetchGuarded(u, { ...headers, "User-Agent": HONEST_UA });
      if ("error" in retry) return { ok: false, error: retry.error };
      response = retry;
    } else {
      response = initial;
    }
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.name === "TimeoutError" || e.name === "AbortError"
          ? `Request timed out after ${timeoutMs / 1000}s`
          : e.message
        : "Fetch failed";
    return { ok: false, error: msg };
  }

  if (!response.ok) return { ok: false, error: `Request failed with status ${response.status}` };

  const declared = response.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > MAX_RESPONSE_SIZE) {
    return { ok: false, error: "Response too large (exceeds 5 MB)." };
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_SIZE) {
    return { ok: false, error: "Response too large (exceeds 5 MB)." };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");
  const body = new TextDecoder().decode(buffer);
  const raw =
    format === "markdown" && isHtml
      ? convertHtmlToMarkdown(body)
      : format === "text" && isHtml
        ? extractTextFromHtml(body)
        : body;

  const { text: content, truncated } = headTruncate(raw);
  return { ok: true, status: response.status, contentType, content, truncated };
}
