import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { createStateStore } from "./state.js";

const fresh = async (now = () => 1_000) => {
  const store = createStateStore(createClient({ url: ":memory:" }), now);
  await store.migrate();
  return store;
};

describe("channel state store", () => {
  it("reads an empty state for an unknown channel and round-trips a document", async () => {
    const store = await fresh();
    expect(await store.load("C1")).toEqual({ channel: "C1", doc: "", cursor: null, updatedAt: null });
    await store.saveDoc("C1", "## Open questions\n- none");
    expect(await store.load("C1")).toMatchObject({ doc: "## Open questions\n- none", updatedAt: 1_000 });
  });

  it("the cursor only moves forward and survives a later doc write", async () => {
    const store = await fresh();
    await store.advanceCursor("C1", "1700000000.000100");
    await store.advanceCursor("C1", "1600000000.000100"); // older — ignored
    expect((await store.load("C1")).cursor).toBe("1700000000.000100");
    await store.saveDoc("C1", "doc");
    expect((await store.load("C1")).cursor).toBe("1700000000.000100");
    await store.advanceCursor("C1", "1700000001.000000");
    expect((await store.load("C1")).cursor).toBe("1700000001.000000");
  });

  it("counts only unprompted posts inside the window, per channel", async () => {
    let t = 0;
    const store = await fresh(() => t);
    t = 10;
    await store.recordPost("C1", "1.0", "unprompted");
    await store.recordPost("C1", "1.1", "addressed");
    await store.recordPost("C2", "1.2", "unprompted");
    t = 20;
    await store.recordPost("C1", "1.3", "unprompted");
    expect(await store.unpromptedPostsSince("C1", 0)).toBe(2);
    expect(await store.unpromptedPostsSince("C1", 15)).toBe(1);
    expect(await store.unpromptedPostsSince("C2", 0)).toBe(1);
  });
});
