import { describe, expect, it, vi } from "vitest";
import { createWatchlist } from "./watchlist.js";

describe("watchlist", () => {
  it("adds newly joined channels, removes left ones, and reports membership", async () => {
    let channels = [{ id: "C1", name: "general" }];
    const onAdd = vi.fn(async () => {});
    const onRemove = vi.fn(async () => {});
    const wl = createWatchlist({ list: async () => channels, onAdd, onRemove });
    await wl.refresh();
    expect(wl.has("C1")).toBe(true);
    expect(onAdd).toHaveBeenCalledWith({ id: "C1", name: "general" });

    channels = [{ id: "C2", name: "ops" }];
    await wl.refresh();
    expect(wl.ids()).toEqual(["C2"]);
    expect(onRemove).toHaveBeenCalledWith("C1");
    expect(onAdd).toHaveBeenCalledTimes(2);

    await wl.refresh(); // steady state: nothing fires
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("overlapping refreshes share one pass, and a failing list is reported not thrown", async () => {
    let n = 0;
    const list = vi.fn(async () => {
      n++;
      await new Promise((r) => setTimeout(r, 5));
      return [{ id: "C1", name: "g" }];
    });
    const wl = createWatchlist({ list, onAdd: async () => {}, onRemove: async () => {} });
    await Promise.all([wl.refresh(), wl.refresh(), wl.refresh()]);
    expect(n).toBe(1);

    const onError = vi.fn();
    const failing = createWatchlist({
      list: async () => {
        throw new Error("slack:users.conversations failed: ratelimited");
      },
      onAdd: async () => {},
      onRemove: async () => {},
      onError,
    });
    await expect(failing.refresh()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
