import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The session → Principal bridge must FAIL LOUDLY when the session has no
 * active organization. The old `?? user:<id>` fallback turned "org choice
 * missing" into a valid-looking personal owner key, silently splitting one
 * user's owner-keyed data (the Loredex incident: OAuth tokens under
 * `user:<id>`, the connection under the real org).
 */

const getSession = vi.hoisted(() => vi.fn());

vi.mock("./auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => new Request("https://x") }));

const { getPrincipalFromHeaders, getSessionUserFromHeaders, credentialPrincipalOf } =
  await import("./session");

const headers = new Headers();

beforeEach(() => {
  getSession.mockReset();
});

describe("getPrincipalFromHeaders", () => {
  it("maps an org-pinned session to {orgId, userId}", async () => {
    getSession.mockResolvedValue({
      session: { activeOrganizationId: "org_a" },
      user: { id: "u1" },
    });
    expect(await getPrincipalFromHeaders(headers)).toEqual({ orgId: "org_a", userId: "u1" });
  });

  it("returns null when unauthenticated", async () => {
    getSession.mockResolvedValue(null);
    expect(await getPrincipalFromHeaders(headers)).toBeNull();
  });

  it("returns null — NOT a personal tenant — when the session has no active org", async () => {
    getSession.mockResolvedValue({
      session: { activeOrganizationId: null },
      user: { id: "u1" },
    });
    expect(await getPrincipalFromHeaders(headers)).toBeNull();
  });
});

describe("getSessionUserFromHeaders", () => {
  it("returns principal + display identity for a pinned session", async () => {
    getSession.mockResolvedValue({
      session: { activeOrganizationId: "org_a" },
      user: { id: "u1", name: "Ana", email: "ana@acme.test" },
    });
    expect(await getSessionUserFromHeaders(headers)).toEqual({
      principal: { orgId: "org_a", userId: "u1" },
      name: "Ana",
      email: "ana@acme.test",
    });
  });

  it("returns null when the session has no active org (same rule, no drift)", async () => {
    getSession.mockResolvedValue({
      session: { activeOrganizationId: undefined },
      user: { id: "u1", name: "Ana" },
    });
    expect(await getSessionUserFromHeaders(headers)).toBeNull();
  });
});

describe("credentialPrincipalOf", () => {
  it("resolves grants under the acting human when one is present", () => {
    expect(
      credentialPrincipalOf({ orgId: "org_a", userId: "binder", actorUserId: "typist" }),
    ).toEqual({ orgId: "org_a", userId: "typist" });
    expect(credentialPrincipalOf({ orgId: "org_a", userId: "u1" })).toEqual({
      orgId: "org_a",
      userId: "u1",
    });
  });
});
