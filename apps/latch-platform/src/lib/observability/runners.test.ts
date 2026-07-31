import { describe, expect, it, vi } from "vitest";
import { pseudonymFor, resolveRunners, userIdFromOwnerTag } from "./runners";
import type { UserProfile } from "./runners";

const SELF = "org/me";
const OTHER = "org/colleague";

const lookup = (rows: Record<string, UserProfile>) =>
  vi.fn(async (ids: string[]) => {
    const out = new Map<string, UserProfile>();
    for (const id of ids) if (rows[id]) out.set(id, rows[id]);
    return out;
  });

describe("userIdFromOwnerTag", () => {
  it("takes the user segment, decoded", () => {
    expect(userIdFromOwnerTag("org/u_123")).toBe("u_123");
    expect(userIdFromOwnerTag("org%2Fx/u%40b.com")).toBe("u@b.com");
  });

  it("has none for an org-only tag (a system/cron run)", () => {
    expect(userIdFromOwnerTag("org")).toBeUndefined();
    expect(userIdFromOwnerTag("org/")).toBeUndefined();
  });
});

describe("resolveRunners", () => {
  it("labels the reader 'You' and names everyone else", async () => {
    const runners = await resolveRunners({
      tags: [SELF, OTHER],
      selfTag: SELF,
      anonymous: false,
      lookup: lookup({ colleague: { name: "Klaus" } }),
    });
    expect(runners.get(SELF)).toEqual({ key: SELF, label: "You", isSelf: true });
    expect(runners.get(OTHER)).toEqual({ key: OTHER, label: "Klaus", isSelf: false });
  });

  it("falls back to email, then to a pseudonym", async () => {
    const runners = await resolveRunners({
      tags: ["org/a", "org/b"],
      selfTag: SELF,
      anonymous: false,
      lookup: lookup({ a: { email: "a@x.com" }, b: {} }),
    });
    expect(runners.get("org/a")?.label).toBe("a@x.com");
    expect(runners.get("org/b")?.label).toBe(pseudonymFor("org/b"));
  });

  it("anonymized: never looks up a profile, and ships no real key", async () => {
    const spy = lookup({ colleague: { name: "Klaus" } });
    const runners = await resolveRunners({
      tags: [SELF, OTHER],
      selfTag: SELF,
      anonymous: true,
      lookup: spy,
    });
    expect(spy).not.toHaveBeenCalled();
    const other = runners.get(OTHER);
    expect(other?.label).toBe(pseudonymFor(OTHER));
    expect(other?.key).toBe(pseudonymFor(OTHER));
    // No owner tag survives anywhere in the response — not even one's own row,
    // whose label stays "You" but whose filter key is pseudonymous too.
    expect(JSON.stringify([...runners.values()])).not.toContain("colleague");
    expect(runners.get(SELF)?.key).toBe(pseudonymFor(SELF));
    expect(runners.get(SELF)?.label).toBe("You");
  });

  it("pseudonyms are stable, so a colleague reads the same across polls", async () => {
    expect(pseudonymFor(OTHER)).toBe(pseudonymFor(OTHER));
    expect(pseudonymFor(OTHER)).not.toBe(pseudonymFor(SELF));
  });

  it("degrades to pseudonyms when the profile lookup fails", async () => {
    const runners = await resolveRunners({
      tags: [OTHER],
      selfTag: SELF,
      anonymous: false,
      lookup: async () => {
        throw new Error("db down");
      },
    });
    expect(runners.get(OTHER)?.label).toBe(pseudonymFor(OTHER));
  });

  it("de-duplicates and drops empty tags", async () => {
    const runners = await resolveRunners({
      tags: [OTHER, OTHER, ""],
      selfTag: SELF,
      anonymous: false,
      lookup: lookup({ colleague: { name: "Klaus" } }),
    });
    expect(runners.size).toBe(1);
  });
});
