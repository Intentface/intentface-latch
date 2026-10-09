import { createDownload, type Experimental_DownloadFunction as DownloadFunction } from "ai";

/**
 * How the model gets a file part's URL it can't fetch itself: the server
 * downloads it and sends the bytes. That request comes from our server, to an
 * address a user can choose, so it must not reach anything private.
 *
 * On Node the AI SDK's own download already guards that: it checks the URL and
 * every redirect, and connects through a DNS lookup that refuses private and
 * loopback addresses, so a public hostname resolving to an internal one fails
 * too. Outside Node (Bun, Deno, edge runtimes) it can only check the URL text
 * before an ordinary `fetch`, which a hostname resolving to a private address
 * gets past. There, Latch refuses the download instead.
 *
 * On top of the SDK's download this adds a size cap (the SDK allows 2 GiB) and
 * one deadline for the whole file, redirects and body included.
 *
 * A URL the model fetches itself (`isUrlSupportedByModel`) is passed through
 * untouched, as the SDK does by default: the provider downloads it, not us.
 */

/** The most bytes one file may have. */
export const MAX_FILE_DOWNLOAD_BYTES = 50 * 1024 * 1024;
/** The longest one file's download may take, redirects and body included. */
export const FILE_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Whether the AI SDK's address-checked download is available: Node itself,
 * not Bun, Deno, workerd or an edge runtime (the SDK's own test).
 */
function addressCheckedRuntime(): boolean {
  const p = (globalThis as { process?: { release?: { name?: string }; versions?: Record<string, unknown>; title?: string } }).process;
  return (
    p?.release?.name === "node" &&
    p.versions?.bun == null &&
    p.versions?.deno == null &&
    p.title !== "workerd" &&
    (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime == null
  );
}

/** The download function every turn's agent and compaction use (`experimental_download`). */
export function safeFileDownload(
  opts: { maxBytes?: number; timeoutMs?: number; download?: ReturnType<typeof createDownload> } = {},
): DownloadFunction {
  const maxBytes = opts.maxBytes ?? MAX_FILE_DOWNLOAD_BYTES;
  const timeoutMs = opts.timeoutMs ?? FILE_DOWNLOAD_TIMEOUT_MS;
  const download = opts.download ?? createDownload({ maxBytes });
  return async (requests) => {
    if (requests.every((r) => r.isUrlSupportedByModel)) return requests.map(() => null);
    if (!addressCheckedRuntime()) {
      const url = requests.find((r) => !r.isUrlSupportedByModel)!.url;
      throw new Error(
        `can't download ${url.href} for the model: this runtime can't check which address a URL resolves to. Send the file inline, or use a model that fetches URLs itself.`,
      );
    }
    return Promise.all(
      requests.map((r) => (r.isUrlSupportedByModel ? null : download({ url: r.url, abortSignal: AbortSignal.timeout(timeoutMs) }))),
    );
  };
}
