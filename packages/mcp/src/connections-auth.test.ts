import { describe, expect, it } from "vitest";
import { bearer, bearerHeader } from "./index.js";

/**
 * `bearer` is the one auth strategy whose header is COMPUTED per caller. The
 * default is the OAuth-style `Authorization: Bearer <token>`; a server keyed on
 * its own header (`X-API-Key: <key>`) names it explicitly. Pinned here because
 * the header is assembled at egress, out of sight of any integration test.
 */
describe("bearerHeader", () => {
  it("defaults to Authorization: Bearer <token>", () => {
    expect(bearerHeader({}, "tok")).toEqual({ Authorization: "Bearer tok" });
  });

  it("sends the token in a custom header with no prefix", () => {
    expect(bearerHeader({ header: "X-API-Key", prefix: "" }, "k1")).toEqual({
      "X-API-Key": "k1",
    });
  });

  it("keeps a custom prefix on the default header", () => {
    expect(bearerHeader({ prefix: "Token " }, "abc")).toEqual({
      Authorization: "Token abc",
    });
  });
});

describe("bearer()", () => {
  it("omits header/prefix unless given, so the defaults apply", () => {
    const auth = bearer({ getToken: () => "t" });
    expect(auth).toEqual({ kind: "bearer", getToken: expect.any(Function) });
  });

  it("carries header/prefix through to the strategy", () => {
    const auth = bearer({ getToken: () => "t", header: "X-API-Key", prefix: "" });
    expect(auth).toMatchObject({ kind: "bearer", header: "X-API-Key", prefix: "" });
  });
});
