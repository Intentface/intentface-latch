import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeFileDownload } from "./file-download.js";

/**
 * File URLs the model can't fetch itself are downloaded by Latch: every hop
 * through latch-net's pinned fetch, which checks the address the connection
 * really goes to, with redirects followed one checked hop at a time.
 */

const req = (url: string, isUrlSupportedByModel = false) => ({ url: new URL(url), isUrlSupportedByModel });

describe("safeFileDownload", () => {
  afterEach(() => vi.doUnmock("@intentface/latch-net/pinned"));

  it("passes through a URL the model fetches itself", async () => {
    const download = safeFileDownload();
    expect(await download([req("https://example.com/a.png", true)])).toEqual([null]);
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

  it("follows a redirect only through the checked fetch, one hop at a time", async () => {
    const seen: string[] = [];
    vi.doMock("@intentface/latch-net/pinned", () => ({
      pinnedFetch: async (url: URL, init?: RequestInit) => {
        seen.push(`${url} ${init?.redirect}`);
        if (url.pathname === "/start") return new Response(null, { status: 302, headers: { location: "/final" } });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      },
    }));
    vi.resetModules();
    const { safeFileDownload: fresh } = await import("./file-download.js");
    const [file] = await fresh()([req("https://files.example.com/start")]);
    expect(seen).toEqual(["https://files.example.com/start manual", "https://files.example.com/final manual"]);
    expect(file).toEqual({ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" });
  });

  it("refuses a file over the size limit", async () => {
    vi.doMock("@intentface/latch-net/pinned", () => ({
      pinnedFetch: async () => new Response(new Uint8Array(100)),
    }));
    vi.resetModules();
    const { safeFileDownload: fresh } = await import("./file-download.js");
    await expect(fresh({ maxBytes: 10 })([req("https://files.example.com/big")])).rejects.toThrow(/limit/);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    vi.doMock("@intentface/latch-net/pinned", () => ({
      pinnedFetch: async () => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }),
    }));
    vi.resetModules();
    const { safeFileDownload: fresh } = await import("./file-download.js");
    await expect(fresh()([req("https://files.example.com/start")])).rejects.toThrow(/http or https/);
  });
});
