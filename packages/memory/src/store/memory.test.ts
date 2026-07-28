import { describe, expect, it } from "vitest";
import { createInMemoryStore, keywordSearch } from "./memory.js";
import { IndexValidationError } from "../index-file.js";
import type { ScopeRef } from "../types.js";

const scope: ScopeRef = {
  key: "mem:_memory/coach/u-1",
  connection: "mem",
  root: "_memory/coach/u-1",
};
const P = {};

describe("createInMemoryStore", () => {
  it("round-trips the index and snapshots the previous version on rewrite", async () => {
    const store = createInMemoryStore();
    expect(await store.readIndex(P, scope)).toBeUndefined();
    const v1 = "# Memory\n- [m-aaaaaa] (2026-03-02, user-said) Fact one. ← episodes/a.md";
    await store.writeIndex(P, scope, v1);
    expect(await store.readIndex(P, scope)).toBe(v1);

    const v2 = `${v1}\n- [m-bbbbbb] (2026-03-03, user-said) Fact two. ← episodes/b.md`;
    await store.writeIndex(P, scope, v2);
    expect(await store.readIndex(P, scope)).toBe(v2);
    expect(store.files.get("_memory/coach/u-1/archive/index-snapshots/MEMORY-0001.md")).toBe(v1);
  });

  it("rejects a rewrite that drops an active entry", async () => {
    const store = createInMemoryStore();
    await store.writeIndex(P, scope, "- [m-aaaaaa] (2026-03-02, user-said) Fact. ← episodes/a.md");
    await expect(
      store.writeIndex(P, scope, "- [m-bbbbbb] (2026-03-03, user-said) Other. ← episodes/b.md"),
    ).rejects.toThrow(IndexValidationError);
  });

  it("writes episodes with deterministic sortable names and disambiguates collisions", async () => {
    const store = createInMemoryStore();
    const episode = {
      slug: "tempo run!",
      meta: { agent: "coach", extractedAt: "2026-03-02T06:10:00.000Z", provenance: "user-said" as const },
      summary: "s",
      body: "## Facts\n- (user-said) x",
    };
    const first = await store.writeEpisode(P, scope, episode);
    const second = await store.writeEpisode(P, scope, episode);
    expect(first?.name).toBe("2026-03-02-06-10-tempo-run.md");
    expect(second?.name).toBe("2026-03-02-06-10-tempo-run-2.md");
    expect(store.files.get(first!.path)).toContain("provenance: user-said");
  });

  it("readEpisodes enforces the scope root", async () => {
    const store = createInMemoryStore({
      files: {
        "_memory/coach/u-1/episodes/a.md": "inside",
        "_memory/other/u-2/episodes/b.md": "outside",
      },
    });
    const got = await store.readEpisodes(P, scope, [
      "_memory/coach/u-1/episodes/a.md",
      "_memory/other/u-2/episodes/b.md",
      "_memory/coach/u-1/../../other/u-2/episodes/b.md",
    ]);
    expect(got).toEqual([{ path: "_memory/coach/u-1/episodes/a.md", text: "inside" }]);
  });

  it("search stays inside the scope root and is deterministic", async () => {
    const store = createInMemoryStore({
      files: {
        "_memory/coach/u-1/memories/tempo-pace.md": "Tempo pace is 4:50 per km.",
        "_memory/coach/u-1/memories/easy-pace.md": "Easy runs at 6:00 per km feel right.",
        "_memory/other/u-2/memories/leak.md": "Tempo tempo tempo pace pace.",
      },
    });
    const a = await store.search(P, scope, "tempo pace", 5);
    const b = await store.search(P, scope, "tempo pace", 5);
    expect(a).toEqual(b);
    expect(a.map((h) => h.path)).toEqual([
      "_memory/coach/u-1/memories/tempo-pace.md",
      "_memory/coach/u-1/memories/easy-pace.md",
    ]);
  });
});

describe("keywordSearch", () => {
  const docs: Array<[string, string]> = [
    ["m/alpha.md", "the quick brown fox"],
    ["m/beta.md", "quick quick quick lazy dog"],
    ["m/gamma.md", "unrelated content entirely"],
  ];

  it("ranks by term match with saturation, ties broken by path", () => {
    const hits = keywordSearch(docs, "quick fox", 10);
    // alpha matches both terms ("fox" is rare → high idf); beta only "quick".
    expect(hits.map((h) => h.path)).toEqual(["m/alpha.md", "m/beta.md"]);
  });

  it("returns [] for stopword-only or empty queries", () => {
    expect(keywordSearch(docs, "the and of", 10)).toEqual([]);
    expect(keywordSearch(docs, "", 10)).toEqual([]);
  });

  it("extracts the best-matching line as the snippet and collects memory ids", () => {
    const hits = keywordSearch(
      [["m/x/episodes/e.md", "# Note\n- [m-7f3a2c] tempo run went well\n- other line"]],
      "tempo",
      1,
    );
    expect(hits[0].snippet).toBe("- [m-7f3a2c] tempo run went well");
    expect(hits[0].memoryIds).toEqual(["m-7f3a2c", "m/x/episodes/e.md"]);
  });

  it("matches filename tokens (title weight)", () => {
    const hits = keywordSearch([["m/marathon-goal.md", "wants to finish strong"]], "marathon", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("m/marathon-goal.md");
  });
});
