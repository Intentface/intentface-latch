import type * as LatchNet from "@intentface/latch-net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The DNS backstop is stubbed out so these tests exercise the *gating* logic
 * (which hops get checked) against the real string blocklist, without needing a
 * resolver. `isBlockedResolved` is asserted separately to be wired in at all.
 */
const isBlockedResolved = vi.fn(async (_host: string) => false);

vi.mock("@intentface/latch-net", async (importOriginal) => ({
  ...(await importOriginal<typeof LatchNet>()),
  isBlockedResolved: (host: string) => isBlockedResolved(host),
}));

// The DNS-pinned fetch would vet fake hostnames at connect time (real
// network); route it to the stubbed global so tests stay hermetic.
vi.mock("@intentface/latch-net/pinned", () => ({
  pinnedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  createPinnedFetch: () => (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init),
}));

const { webFetch } = await import("./web-fetch");

/** A redirect response; `fetch` is called with `redirect: "manual"` so we see these. */
const redirectTo = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

const page = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/plain" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  isBlockedResolved.mockClear();
  isBlockedResolved.mockResolvedValue(false);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Hosts the request actually reached, in order. */
const attempted = () => fetchMock.mock.calls.map((c) => new URL(c[0]).hostname);

describe("web_fetch SSRF gate", () => {
  it("fetches a public URL", async () => {
    fetchMock.mockResolvedValue(page("hello"));
    const res = await webFetch({ url: "https://example.com/a", format: "text" });
    expect(res).toMatchObject({ ok: true, content: "hello" });
  });

  it("blocks a private/loopback target before any request", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1/",
      "http://localhost/",
      "http://[::1]/",
      "http://2130706433/",
      "http://10.0.0.5/",
      "http://100.64.0.1/",
      "http://foo.localhost/",
    ]) {
      expect(await webFetch({ url })).toEqual({ ok: false, error: "Host is not allowed." });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) schemes", async () => {
    expect(await webFetch({ url: "file:///etc/passwd" })).toEqual({
      ok: false,
      error: "Only http(s) URLs are allowed.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-validates redirects: a public URL may not redirect to cloud metadata", async () => {
    fetchMock.mockResolvedValueOnce(redirectTo("http://169.254.169.254/latest/meta-data/"));
    expect(await webFetch({ url: "https://evil.example/x" })).toEqual({
      ok: false,
      error: "Host is not allowed.",
    });
    // The first hop was fetched; the internal target never was.
    expect(attempted()).toEqual(["evil.example"]);
  });

  it("re-validates redirects across multiple hops", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo("https://hop2.example/y"))
      .mockResolvedValueOnce(redirectTo("http://127.0.0.1:8080/admin"));
    expect(await webFetch({ url: "https://hop1.example/x" })).toEqual({
      ok: false,
      error: "Host is not allowed.",
    });
    expect(attempted()).toEqual(["hop1.example", "hop2.example"]);
  });

  it("follows a public redirect chain to its body", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo("https://b.example/2"))
      .mockResolvedValueOnce(page("landed"));
    const res = await webFetch({ url: "https://a.example/1", format: "text" });
    expect(res).toMatchObject({ ok: true, content: "landed" });
    expect(attempted()).toEqual(["a.example", "b.example"]);
  });

  it("caps the redirect chain", async () => {
    fetchMock.mockImplementation(async (u: URL) =>
      redirectTo(`https://next.example/${new URL(u).pathname.length + 1}`),
    );
    expect(await webFetch({ url: "https://start.example/1" })).toEqual({
      ok: false,
      error: "Too many redirects.",
    });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("applies the DNS backstop to every hop, not just the first", async () => {
    // A name that resolves to a private address must be refused even though the
    // string blocklist sees nothing wrong with it.
    isBlockedResolved.mockImplementation(async (h: string) => h === "internal.example");
    fetchMock.mockResolvedValueOnce(redirectTo("https://internal.example/secret"));
    expect(await webFetch({ url: "https://public.example/x" })).toEqual({
      ok: false,
      error: "Host is not allowed.",
    });
    expect(isBlockedResolved.mock.calls.map((c) => c[0])).toEqual([
      "public.example",
      "internal.example",
    ]);
    expect(attempted()).toEqual(["public.example"]);
  });

  it("re-validates the Cloudflare-challenge retry too", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 403, headers: { "cf-mitigated": "challenge" } }),
      )
      .mockResolvedValueOnce(redirectTo("http://169.254.169.254/"));
    expect(await webFetch({ url: "https://cf.example/x" })).toEqual({
      ok: false,
      error: "Host is not allowed.",
    });
    expect(attempted()).toEqual(["cf.example", "cf.example"]);
  });
});
