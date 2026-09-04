import { describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { canvasHtmlToMarkdown, createCanvas, lineDiff, type Canvas } from "./canvas.js";
import { createCanvasStateStore } from "./canvas-state.js";
import { createStateStore } from "./state.js";
import { instructionsFor } from "./agent.js";

const DOC = "## Open questions\n- who owns the deploy?\n\n## Commitments\n- bob will write the runbook by Friday";

async function build(canvasDoc: { current: string }) {
  const base = createStateStore(createClient({ url: ":memory:" }));
  await base.migrate();
  const canvas: Canvas = {
    ensure: vi.fn(async () => ({ id: "F123", how: "created" as const })),
    read: vi.fn(async () => canvasDoc.current),
    replace: vi.fn(async (_id, md) => void (canvasDoc.current = md)),
  };
  const store = createCanvasStateStore({ base, canvas, initial: "# notes" });
  return { store, base, canvas };
}

describe("canvas-backed state", () => {
  it("writes go to the canvas and the shadow; reads come from the canvas", async () => {
    const doc = { current: "" };
    const { store, base, canvas } = await build(doc);
    await store.saveDoc("C1", DOC);
    expect(canvas.replace).toHaveBeenCalledWith("F123", DOC);
    expect((await base.load("C1")).doc).toBe(DOC);
    const state = await store.load("C1");
    expect(state.doc).toBe(DOC);
    expect(state.humanEdits).toBeUndefined();
    expect(canvas.ensure).toHaveBeenCalledTimes(1); // id cached per channel
  });

  it("the canvas id is persisted: a fresh store over the same database reuses it instead of creating", async () => {
    const doc = { current: "" };
    const { store, base, canvas } = await build(doc);
    await store.saveDoc("C1", DOC);
    expect(await base.getCanvasId("C1")).toBe("F123");
    const again = createCanvasStateStore({ base, canvas, initial: "# notes" }); // "restart"
    await again.saveDoc("C1", DOC + "\n- more");
    expect(canvas.ensure).toHaveBeenCalledTimes(1);
    expect(canvas.replace).toHaveBeenLastCalledWith("F123", DOC + "\n- more");
  });

  it("a human edit shows up as a diff against the shadow, and the instructions carry it", async () => {
    const doc = { current: "" };
    const { store } = await build(doc);
    await store.saveDoc("C1", DOC);
    doc.current = "## Open questions\n- who owns the deploy?\n\n## Commitments\n- bob will write the runbook by Monday";
    const state = await store.load("C1");
    expect(state.doc).toBe(doc.current);
    expect(state.humanEdits).toEqual({
      added: ["- bob will write the runbook by Monday"],
      removed: ["- bob will write the runbook by Friday"],
    });
    const text = instructionsFor({ state, channelName: "general" });
    expect(text).toContain("someone in the channel edited it");
    expect(text).toContain("- removed: - bob will write the runbook by Friday");
    expect(text).toContain("+ added: - bob will write the runbook by Monday");
  });

  it("falls back to the last written copy when the canvas cannot be read", async () => {
    const doc = { current: "" };
    const { store, canvas } = await build(doc);
    await store.saveDoc("C1", DOC);
    (canvas.read as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("slack:files.info failed: ratelimited"));
    const onError = vi.fn();
    const state = await store.load("C1");
    void onError;
    expect(state.doc).toBe(DOC);
  });

  it("inbox, bootstrap flag and post log stay in sqlite", async () => {
    const { store, base } = await build({ current: "" });
    await store.push("C1", "e1", { kind: "message", ts: "100.1", text: "hi" });
    await store.markBootstrapped("C1");
    await store.recordPost("C1", "1.0", "unprompted");
    expect(await store.pending("C1")).toBe(1);
    expect((await base.load("C1")).bootstrappedAt).not.toBeNull();
    expect(await store.unpromptedPostsSince("C1", 0)).toBe(1);
  });
});

describe("canvas plumbing", () => {
  it("html → markdown keeps headings and bullets, drops zero-width junk", () => {
    const html = "<h2>Open questions</h2><ul><li>who owns​ the deploy?</li></ul><p></p><p></p><h2>Decisions</h2><p>none</p>";
    expect(canvasHtmlToMarkdown(html)).toBe("## Open questions\n\n- who owns the deploy?\n\n## Decisions\n\nnone");
  });

  it("ensure creates when the channel has no canvas, and recovers the existing one on an already-exists error", async () => {
    let hasCanvas = false;
    const fetchImpl = vi.fn(async (url: string) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (url.startsWith("https://slack.com/api/conversations.info")) return json({ ok: true, channel: hasCanvas ? { properties: { canvas: { file_id: "F1" } } } : {} });
      if (url === "https://slack.com/api/conversations.canvases.create") {
        if (hasCanvas) return json({ ok: false, error: "channel_canvas_already_exists" });
        hasCanvas = true;
        return json({ ok: true, canvas_id: "F1" });
      }
      return json({ ok: false, error: `unexpected ${url}` });
    }) as unknown as typeof fetch;
    const canvas = createCanvas("xoxb-t", fetchImpl);
    expect(await canvas.ensure("C1", "# init")).toEqual({ id: "F1", how: "created" });
    // Info lags behind: a second ensure before info catches up hits the conflict and recovers.
    hasCanvas = true;
    const lagging = createCanvas("xoxb-t", (async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://slack.com/api/conversations.info")) {
        // First lookup: nothing; after the conflict: the canvas.
        const n = (lagging as unknown as { n?: number }).n ?? 0;
        (lagging as unknown as { n?: number }).n = n + 1;
        return new Response(JSON.stringify({ ok: true, channel: n === 0 ? {} : { properties: { canvas: { file_id: "F1" } } } }));
      }
      return fetchImpl(url, init);
    }) as unknown as typeof fetch);
    expect(await lagging.ensure("C1", "# init")).toEqual({ id: "F1", how: "found-after-conflict" });
  });

  it("lineDiff reports added and removed lines only", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual({ added: ["d"], removed: ["b"] });
    expect(lineDiff("a\n\n b ", "a\nb")).toEqual({ added: [], removed: [] });
  });

  it("ensure reuses the channel canvas, read follows files.info to the download, replace edits the whole canvas", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (url.startsWith("https://slack.com/api/conversations.info")) return json({ ok: true, channel: { properties: { canvas: { file_id: "F9" } } } });
      if (url.startsWith("https://slack.com/api/files.info")) return json({ ok: true, file: { url_private_download: "https://files.slack.com/x" } });
      if (url === "https://files.slack.com/x") return new Response("<h2>Hi</h2><ul><li>one</li></ul>");
      if (url === "https://slack.com/api/canvases.edit") return json({ ok: true });
      return json({ ok: false, error: `unexpected ${url}` });
    }) as unknown as typeof fetch;
    const canvas = createCanvas("xoxb-t", fetchImpl);
    expect(await canvas.ensure("C1", "# init")).toEqual({ id: "F9", how: "existing" });
    expect(await canvas.read("F9")).toBe("## Hi\n\n- one");
    expect(calls.find((c) => c.url === "https://files.slack.com/x")?.init?.headers).toEqual({ authorization: "Bearer xoxb-t" });
    await canvas.replace("F9", "## New");
    const edit = calls.find((c) => c.url === "https://slack.com/api/canvases.edit")!;
    expect(JSON.parse(edit.init!.body as string)).toEqual({
      canvas_id: "F9",
      changes: [{ operation: "replace", document_content: { type: "markdown", markdown: "## New" } }],
    });
  });
});
