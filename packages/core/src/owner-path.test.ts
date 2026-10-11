import { describe, expect, it } from "vitest";
import { decodeOwnerKey, encodeOwnerKey, isUnderOwner } from "./storage.js";

describe("owner paths", () => {
  it("cover the key itself and keys under it, never a longer sibling", () => {
    expect(isUnderOwner("t1", ["t1"])).toBe(true);
    expect(isUnderOwner("t1/u7", ["t1"])).toBe(true);
    expect(isUnderOwner("t10", ["t1"])).toBe(false);
    expect(isUnderOwner("t1/u7", ["t1", "u7"])).toBe(true);
    expect(isUnderOwner("t1/u70", ["t1", "u7"])).toBe(false);
    expect(isUnderOwner("t1", ["t1", "u7"])).toBe(false);
  });

  it("can't be fooled by a slash inside an id", () => {
    // ["t1/u7"] is one segment; its key is escaped, so it isn't the path t1 > u7.
    expect(isUnderOwner(encodeOwnerKey(["t1", "u7"]), ["t1/u7"])).toBe(false);
    expect(isUnderOwner(encodeOwnerKey(["t1/u7"]), ["t1"])).toBe(false);
  });

  it("decodes what encodeOwnerKey made", () => {
    expect(decodeOwnerKey(encodeOwnerKey(["t_1", "u/7", "a%b"]))).toEqual(["t_1", "u/7", "a%b"]);
  });
});
