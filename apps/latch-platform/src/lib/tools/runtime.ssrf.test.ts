import type * as LatchNet from "@intentface/latch-net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The authored-tool sandbox's host `fetch` is gated by the tool's `allowedHosts`
 * PLUS the SSRF blocklist. `allowedHosts` is not a security boundary — it is
 * supplied by whoever saves or tests the tool, and is an input of the
 * LLM-callable `test_tool` — so these tests allowlist the target on purpose and
 * assert the blocklist/DNS backstop still refuses it.
 */
const isBlockedResolved = vi.fn(async (_host: string) => false);

vi.mock("@intentface/latch-net", async (importOriginal) => ({
  ...(await importOriginal<typeof LatchNet>()),
  isBlockedResolved: (host: string) => isBlockedResolved(host),
}));

const { runTool } = await import("./runtime");

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  isBlockedResolved.mockClear();
  isBlockedResolved.mockResolvedValue(false);
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fetchTool = (url: string) => `
  const r = await fetch(${JSON.stringify(url)});
  return r;
`;

describe("authored-tool fetch: SSRF gate", () => {
  it("fetches an allowlisted public host", async () => {
    const res = await runTool(fetchTool("https://api.example.com/v1"), {
      allowedHosts: ["api.example.com"],
    });
    expect(res.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a private literal even when the caller allowlists it", async () => {
    const res = await runTool(fetchTool("http://169.254.169.254/latest/meta-data/"), {
      allowedHosts: ["169.254.169.254"],
    });
    expect(res).toMatchObject({ status: "error" });
    expect(String((res as { error: string }).error)).toMatch(/private\/loopback/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an allowlisted NAME that resolves to a private address", async () => {
    // The gap CodeRabbit flagged: the allowlist is caller-controlled, so without
    // the DNS backstop a caller could allowlist a host they own that points at
    // cloud metadata.
    isBlockedResolved.mockImplementation(async (h: string) => h === "rebind.example");
    const res = await runTool(fetchTool("https://rebind.example/x"), {
      allowedHosts: ["rebind.example"],
    });
    expect(res).toMatchObject({ status: "error" });
    expect(String((res as { error: string }).error)).toMatch(/private\/loopback/);
    expect(isBlockedResolved).toHaveBeenCalledWith("rebind.example");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-validates redirect hops against the DNS backstop too", async () => {
    isBlockedResolved.mockImplementation(async (h: string) => h === "internal.example");
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://internal.example/secret" } }),
    );
    const res = await runTool(fetchTool("https://start.example/x"), {
      // Both hosts allowlisted, so only the DNS backstop can refuse the second.
      allowedHosts: ["start.example", "internal.example"],
    });
    expect(res).toMatchObject({ status: "error" });
    expect(String((res as { error: string }).error)).toMatch(/private\/loopback/);
    expect(fetchMock.mock.calls.map((c) => new URL(c[0]).hostname)).toEqual(["start.example"]);
  });

  it("still enforces the allowlist for public hosts", async () => {
    const res = await runTool(fetchTool("https://elsewhere.example/x"), {
      allowedHosts: ["api.example.com"],
    });
    expect(res).toMatchObject({ status: "error" });
    expect(String((res as { error: string }).error)).toMatch(/allowedHosts/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
