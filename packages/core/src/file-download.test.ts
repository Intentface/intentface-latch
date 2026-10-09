import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeFileDownload } from "./file-download.js";

/**
 * File URLs the model can't fetch itself are downloaded by the server: on
 * Node through the AI SDK's address-checked download, capped in size and
 * time; on runtimes that can't check addresses, refused.
 */

const req = (url: string, isUrlSupportedByModel = false) => ({ url: new URL(url), isUrlSupportedByModel });

describe("safeFileDownload", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes through a URL the model fetches itself", async () => {
    expect(await safeFileDownload()([req("https://example.com/a.png", true)])).toEqual([null]);
  });

  it("refuses a file on a private address, for real", async () => {
    const server = createServer((_q, r) => r.end("secret"));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(safeFileDownload()([req(`http://127.0.0.1:${port}/secret.png`)])).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it("downloads through the SDK with a size cap and a deadline", async () => {
    const calls: Array<{ url: string; signal?: AbortSignal }> = [];
    const download = async ({ url, abortSignal }: { url: URL; abortSignal?: AbortSignal }) => {
      calls.push({ url: url.href, signal: abortSignal });
      return { data: new Uint8Array([1, 2, 3]), mediaType: "image/png" };
    };
    const files = await safeFileDownload({ download })([req("https://files.example.com/a.png"), req("https://cdn.example.com/b.png", true)]);
    expect(files).toEqual([{ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }, null]);
    expect(calls.map((c) => c.url)).toEqual(["https://files.example.com/a.png"]);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up on a file that takes too long", async () => {
    const download = ({ abortSignal }: { url: URL; abortSignal?: AbortSignal }) =>
      new Promise<never>((_ok, fail) => abortSignal?.addEventListener("abort", () => fail(abortSignal.reason)));
    const started = Date.now();
    await expect(safeFileDownload({ download, timeoutMs: 50 })([req("https://files.example.com/slow")])).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses to download where addresses can't be checked (edge, Bun, Deno)", async () => {
    vi.stubGlobal("EdgeRuntime", "edge-runtime");
    const download = vi.fn();
    await expect(safeFileDownload({ download })([req("https://files.example.com/a.png")])).rejects.toThrow(/can't check/);
    expect(download).not.toHaveBeenCalled();
    // A URL the model fetches itself still goes through: the provider fetches it.
    expect(await safeFileDownload({ download })([req("https://cdn.example.com/b.png", true)])).toEqual([null]);
  });
});

describe("safeFileDownload and its run", () => {
  it("stops a download when the run aborts", async () => {
    const run = new AbortController();
    const download = ({ abortSignal }: { url: URL; abortSignal?: AbortSignal }) =>
      new Promise<never>((_ok, fail) => abortSignal?.addEventListener("abort", () => fail(abortSignal.reason)));
    const pending = safeFileDownload({ download, signal: run.signal, timeoutMs: 60_000 })([req("https://files.example.com/a.png")]);
    run.abort(new Error("lease lost"));
    await expect(pending).rejects.toThrow("lease lost");
  });
});
