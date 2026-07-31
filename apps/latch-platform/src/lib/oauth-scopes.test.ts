import { describe, expect, it } from "vitest";
import { parseScopes, sameScopeSet } from "./oauth-scopes";

describe("parseScopes", () => {
  it("splits on any run of whitespace", () => {
    expect(parseScopes("mcp:read   private_only")).toEqual(["mcp:read", "private_only"]);
    expect(parseScopes(" mcp:read\tprivate_only\n")).toEqual(["mcp:read", "private_only"]);
  });

  it("treats blank input as no scopes at all", () => {
    // Distinct from an empty array: `undefined` means the authorize request
    // carries no `scope` parameter, which is the pre-existing behaviour for
    // connections that never asked for one.
    expect(parseScopes(undefined)).toBeUndefined();
    expect(parseScopes("")).toBeUndefined();
    expect(parseScopes("   ")).toBeUndefined();
  });

  it("drops duplicates, keeping first-seen order", () => {
    expect(parseScopes("a b a")).toEqual(["a", "b"]);
  });
});

describe("sameScopeSet", () => {
  it("ignores order", () => {
    // The reason this matters: an inequality here clears the stored token and
    // forces re-consent, so reordering the field must not count as a change.
    expect(sameScopeSet(["mcp:read", "private_only"], ["private_only", "mcp:read"])).toBe(true);
  });

  it("ignores duplicates", () => {
    expect(sameScopeSet(["a", "a", "b"], ["b", "a"])).toBe(true);
  });

  it("treats absent and empty as equivalent", () => {
    expect(sameScopeSet(undefined, undefined)).toBe(true);
    expect(sameScopeSet(undefined, [])).toBe(true);
    expect(sameScopeSet([], undefined)).toBe(true);
  });

  it("detects a genuine change in either direction", () => {
    // Adding a restriction, and — the dangerous direction — removing one.
    expect(sameScopeSet(undefined, ["private_only"])).toBe(false);
    expect(sameScopeSet(["private_only"], undefined)).toBe(false);
    expect(sameScopeSet(["mcp:read"], ["mcp:read", "private_only"])).toBe(false);
    expect(sameScopeSet(["a"], ["b"])).toBe(false);
  });

  it("is not fooled by equal lengths with different members", () => {
    expect(sameScopeSet(["a", "b"], ["a", "c"])).toBe(false);
  });
});
