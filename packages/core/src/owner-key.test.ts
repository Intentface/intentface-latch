import { describe, expect, it } from "vitest";
import { encodeOwnerKey } from "./storage.js";

describe("encodeOwnerKey", () => {
  it("joins escaped segments", () => {
    expect(encodeOwnerKey(["org_1", "user/2"])).toBe("org_1/user%2F2");
  });

  it("refuses a missing, empty or non-string segment", () => {
    expect(() => encodeOwnerKey(["org_1", undefined])).toThrow(/position 1/);
    expect(() => encodeOwnerKey(["", "u"])).toThrow(/position 0/);
    expect(() => encodeOwnerKey(["org_1", null])).toThrow(/position 1/);
    expect(() => encodeOwnerKey(["org_1", 7])).toThrow(/position 1/);
  });

  it("refuses an empty path", () => {
    expect(() => encodeOwnerKey([])).toThrow(/no segments/);
  });
});
