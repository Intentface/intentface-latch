import TurndownService from "turndown";

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

// Browser-like UA so servers return full content, not bot-degraded pages.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const HONEST_UA = "intentface-latch-agent";

export type WebFetchFormat = "markdown" | "text" | "html";

export type WebFetchResult =
  | { ok: true; status: number; contentType: string; content: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Block private/loopback hosts (SSRF guard). Covers the common bypass vectors:
 * trailing-dot, bracketed IPv6 (loopback/ULA/link-local + IPv4-mapped), bare
 * integer / hex encodings of IPv4 (e.g. 2130706433 = 127.0.0.1), and short
 * dotted forms (127.1). Best-effort but conservative — strictly more blocking.
 */
export function isBlockedHost(host: string): boolean {
  let h = host.toLowerCase().replace(/\.$/, ""); // drop a trailing dot
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // unwrap IPv6 literal
  if (h === "localhost" || h.endsWith(".local") || h === "::1" || h === "::") return true;
  if (h.includes(":")) {
    // IPv6 loopback / ULA (fc00::/7) / link-local (fe80::/10).
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || /^fe[89ab]/.test(h)) return true;
    // IPv4-mapped (::ffff:127.0.0.1) → fall through to the IPv4 check.
    const mapped = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) h = mapped[1];
    else return false;
  }
  // Bare integer or hex host = an encoded IPv4 (e.g. 2130706433, 0x7f000001).
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return true;
  // Dotted IPv4, including short forms (127.1, 10.0.1).
  const parts = h.split(".");
  if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const a = Number(parts[0]);
    const b = Number(parts[1] ?? 0);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
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
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "Only http(s) URLs are allowed." };
  }
  if (isBlockedHost(u.hostname)) return { ok: false, error: "Host is not allowed." };

  const timeoutMs = Math.min(
    args.timeout != null ? args.timeout * 1000 : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = buildHeaders(format);

  let response: Response;
  try {
    const initial = await fetch(u, { headers, signal, redirect: "follow" });
    // Cloudflare may block browser UAs from non-browser TLS; retry honestly.
    response =
      initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
        ? await fetch(u, { headers: { ...headers, "User-Agent": HONEST_UA }, signal, redirect: "follow" })
        : initial;
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
