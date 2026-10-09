import type { Experimental_DownloadFunction as DownloadFunction } from "ai";

/**
 * How the model gets a file part's URL it can't fetch itself: Latch downloads
 * it and sends the bytes. This replaces the AI SDK's default download, whose
 * private-address check only reads the URL: a public hostname that resolves to
 * an internal address (a cloud metadata service, a database on the private
 * network) passes it. Here each hop is fetched through `@intentface/latch-net`,
 * which checks the address the connection actually goes to, and every
 * redirect is checked again before it is followed.
 *
 * A URL the model fetches itself (`isUrlSupportedByModel`) is passed through
 * untouched, as the SDK does by default: the provider downloads it, not us.
 */

/** The most bytes one file may have. */
export const MAX_FILE_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 4;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

let pinned: Promise<FetchLike | null> | undefined;
let warned = false;

/**
 * `@intentface/latch-net` is an optional peer: loaded on first use, so a
 * runtime that never meets a file URL never loads it. Without it, downloads
 * fall back to the AI SDK's own (URL-only) check, once, with a warning.
 */
async function pinnedFetch(): Promise<FetchLike | null> {
  pinned ??= import("@intentface/latch-net/pinned")
    .then((m) => m.pinnedFetch as FetchLike)
    .catch(() => null);
  return pinned;
}

/** Read a response body, refusing one larger than `maxBytes`. */
async function readCapped(res: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`file at ${url} is ${declared} bytes, over the ${maxBytes}-byte limit`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`file at ${url} is over the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function download(fetch: FetchLike, start: URL, maxBytes: number): Promise<{ data: Uint8Array; mediaType: string | undefined }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`file URL must be http or https, got ${url.protocol}`);
    }
    // Redirects are followed here, one hop at a time, so each target is
    // checked by the pinned fetch before anything connects to it.
    const res = await fetch(url, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects downloading ${start.href}`);
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`downloading ${url.href} failed: ${res.status} ${res.statusText}`);
    }
    return { data: await readCapped(res, url.href, maxBytes), mediaType: res.headers.get("content-type") ?? undefined };
  }
}

/** The download function every turn's agent uses (`experimental_download`). */
export function safeFileDownload(opts: { maxBytes?: number } = {}): DownloadFunction {
  const maxBytes = opts.maxBytes ?? MAX_FILE_DOWNLOAD_BYTES;
  return async (requests) => {
    if (requests.every((r) => r.isUrlSupportedByModel)) return requests.map(() => null);
    const fetch = await pinnedFetch();
    if (!fetch) {
      if (!warned) {
        warned = true;
        console.warn(
          "[latch] @intentface/latch-net is not installed: file URLs the model can't fetch itself are downloaded with the AI SDK's URL-only address check. Install it to check resolved addresses too.",
        );
      }
      const { createDownload } = await import("ai");
      const fallback = createDownload({ maxBytes });
      return Promise.all(requests.map((r) => (r.isUrlSupportedByModel ? null : fallback({ url: r.url }))));
    }
    return Promise.all(requests.map((r) => (r.isUrlSupportedByModel ? null : download(fetch, r.url, maxBytes))));
  };
}
