import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { cleanClusters, clusterPrompt } from "./failures";
import { createEvalsStore, migrateEvalsV2 } from "./store";

describe("grouping notes", () => {
  it("keeps a model honest: in-range numbers, one mode per note, empty modes dropped, biggest first", () => {
    const modes = cleanClusters(
      {
        modes: [
          { name: "Small", description: "a", notes: [1, 1, 99] },
          { name: "Big", description: "b", notes: [1, 2, 3] },
          { name: "Empty", description: "c", notes: [0, -1] },
        ],
      },
      3,
    );
    expect(modes).toEqual([
      { name: "Big", description: "b", notes: [1, 2] },
      { name: "Small", description: "a", notes: [0] },
    ]);
  });

  it("asks for user-side failures and offers earlier names back", () => {
    const p = clusterPrompt({ agentName: "edge", notes: [{ text: "cited\nnothing" }], existing: [{ name: "No sources", description: "d" }] });
    expect(p).toContain("1. cited nothing");
    expect(p).toContain("keep these names");
    expect(p).toContain("- No sources: d");
  });
});

describe("notes", () => {
  it("round-trip, and a rewritten note leaves its mode", async () => {
    const client = createClient({ url: ":memory:" });
    await migrateEvalsV2(client);
    const s = createEvalsStore(client);
    const base = { owner: "o", agentName: "a", createdAt: 1, updatedAt: 1 };
    await s.saveNote({ ...base, threadId: "t1", text: "made up a source", ok: false });
    await s.saveNote({ ...base, threadId: "t2", text: "", ok: true });
    await s.setModes("o", "a", [{ owner: "o", agentName: "a", id: "m1", name: "Invents sources", description: "d", createdAt: 1 }], new Map([["t1", "m1"]]));
    expect((await s.listNotes("o", "a")).find((n) => n.threadId === "t1")?.modeId).toBe("m1");

    // Same text: the mode stays. New text: it may not fit any more.
    await s.saveNote({ ...base, threadId: "t1", text: "made up a source", ok: false, updatedAt: 2 });
    expect((await s.listNotes("o", "a")).find((n) => n.threadId === "t1")?.modeId).toBe("m1");
    await s.saveNote({ ...base, threadId: "t1", text: "ignored the budget", ok: false, updatedAt: 3 });
    expect((await s.listNotes("o", "a")).find((n) => n.threadId === "t1")?.modeId).toBeUndefined();

    expect((await s.listNotes("o", "a")).find((n) => n.threadId === "t2")).toMatchObject({ ok: true, text: "" });
    await s.deleteNote("o", "t2");
    expect(await s.listNotes("o", "a")).toHaveLength(1);
  });
});
