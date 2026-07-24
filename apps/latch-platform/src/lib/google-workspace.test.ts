import type { Vault } from "@intentface/latch-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleWorkspaceConnection,
  createGoogleWorkspaceWriteConnection,
} from "./google-workspace";
import { buildRawEmail } from "./google-workspace-tools";

type P = { orgId: string; userId?: string };

/** In-memory Vault stub — enough surface for the OAuth flow. */
function memoryVault(): Vault<P> {
  const data = new Map<string, string>();
  const k = (p: P, key: string) => `${p.orgId}/${p.userId ?? ""}:${key}`;
  return {
    set: async (p: P, key: string, value: string) => void data.set(k(p, key), value),
    get: async (p: P, key: string) => data.get(k(p, key)),
    has: async (p: P, key: string) => data.has(k(p, key)),
    delete: async (p: P, key: string) => void data.delete(k(p, key)),
    list: async () => [...data.keys()],
    resolver: { get: async () => undefined },
  } as unknown as Vault<P>;
}

const principal: P = { orgId: "org1", userId: "user1" };

function connection(vault = memoryVault()) {
  return createGoogleWorkspaceConnection<P>({
    vault,
    clientId: "test-client",
    clientSecret: "test-secret",
    callbackBaseUrl: "http://localhost:3000/api/latch/connections",
  });
}

const tokenResponse = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("google_workspace OAuth", () => {
  it("start() builds a read-only-scoped offline consent URL", async () => {
    const gw = connection();
    const res = await gw.oauth("google_workspace")!.start(principal, {
      state: { returnTo: "/connections" },
    });
    expect(res.status).toBe("redirect");
    const url = new URL((res as { authorizationUrl: string }).authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const scope = url.searchParams.get("scope")!;
    expect(scope).toContain("drive.readonly");
    expect(scope).toContain("gmail.readonly");
    expect(scope).toContain("documents.readonly");
    expect(scope).toContain("spreadsheets.readonly");
    expect(scope).toContain("presentations.readonly");
    expect(scope).not.toMatch(/drive(\s|$)|gmail\.(send|modify|compose)/);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/latch/connections/google_workspace/callback",
    );
    // state = <csrf>.<b64url payload> — handler's decodeOAuthState needs the dot
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{32}\./);
  });

  it("finish() rejects a state mismatch (CSRF)", async () => {
    const gw = connection();
    const oauth = gw.oauth("google_workspace")!;
    await oauth.start(principal);
    await expect(
      oauth.finish(principal, { code: "c", state: "deadbeef.e30" }),
    ).rejects.toThrow(/state mismatch/);
  });

  it("finish() exchanges the code and stores tokens; mountCredsFor exposes them", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () =>
        tokenResponse({ access_token: "at-1", expires_in: 3600, refresh_token: "rt-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gw = connection();
    const oauth = gw.oauth("google_workspace")!;
    const start = await oauth.start(principal);
    const state = new URL(
      (start as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    expect(await oauth.isAuthorized(principal)).toBe(false);
    await oauth.finish(principal, { code: "auth-code", state });
    expect(await oauth.isAuthorized(principal)).toBe(true);

    const body = String(fetchMock.mock.calls[0]![1]!.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code");

    const creds = await gw.mountCredsFor(principal);
    expect(creds).toMatchObject({ clientId: "test-client", refreshToken: "rt-1" });

    // refreshFn hits the token endpoint with the refresh grant.
    fetchMock.mockResolvedValueOnce(
      tokenResponse({ access_token: "at-2", expires_in: 3599 }),
    );
    expect(await creds!.refreshFn("rt-1")).toEqual({ accessToken: "at-2", expiresIn: 3599 });
    expect(String(fetchMock.mock.calls.at(-1)![1]!.body)).toContain(
      "grant_type=refresh_token",
    );
  });

  it("finish() fails when Google omits the refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse({ access_token: "at", expires_in: 3600 })),
    );
    const gw = connection();
    const oauth = gw.oauth("google_workspace")!;
    const start = await oauth.start(principal);
    const state = new URL(
      (start as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    await expect(oauth.finish(principal, { code: "c", state })).rejects.toThrow(
      /no refresh token/,
    );
  });

  it("is tenant-scoped: another principal stays unauthorized and unmountable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tokenResponse({ access_token: "at", expires_in: 3600, refresh_token: "rt" }),
      ),
    );
    const gw = connection();
    const oauth = gw.oauth("google_workspace")!;
    const start = await oauth.start(principal);
    const state = new URL(
      (start as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    await oauth.finish(principal, { code: "c", state });

    const other: P = { orgId: "org1", userId: "user2" };
    expect(await oauth.isAuthorized(other)).toBe(false);
    expect(await gw.mountCredsFor(other)).toBeNull();
  });

  it("disconnect (provider().invalidateCredentials) revokes and drops tokens", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () =>
        tokenResponse({ access_token: "at", expires_in: 3600, refresh_token: "rt" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gw = connection();
    const oauth = gw.oauth("google_workspace")!;
    const start = await oauth.start(principal);
    const state = new URL(
      (start as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    await oauth.finish(principal, { code: "c", state });
    expect(await oauth.isAuthorized(principal)).toBe(true);

    await oauth.provider(principal).invalidateCredentials?.("all");
    expect(await oauth.isAuthorized(principal)).toBe(false);
    expect(await gw.mountCredsFor(principal)).toBeNull();
    const revoke = fetchMock.mock.calls.find(([u]) => String(u).includes("/revoke"));
    expect(String(revoke![1]!.body)).toContain("token=rt");

    // Revocation endpoint failure must not block the local disconnect.
    await oauth.finish(principal, {
      code: "c2",
      state: new URL(
        ((await oauth.start(principal)) as { authorizationUrl: string }).authorizationUrl,
      ).searchParams.get("state")!,
    });
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await oauth.provider(principal).invalidateCredentials?.("all");
    expect(await oauth.isAuthorized(principal)).toBe(false);
  });

  it("contributes only the gated connect tool and answers status", async () => {
    const gw = connection();
    const opened = await gw.hostFor(["google_workspace"]).open(principal);
    expect(Object.keys(opened.tools)).toEqual(["connect_google_workspace"]);
    expect(
      (opened as { toolApproval?: Record<string, string> }).toolApproval,
    ).toEqual({ connect_google_workspace: "user-approval" });
    expect((opened as { alwaysActive?: string[] }).alwaysActive).toEqual([
      "connect_google_workspace",
    ]);
    await opened.close();
    const notPicked = await gw.hostFor(["other"]).open(principal);
    expect(Object.keys(notPicked.tools)).toEqual([]);
    const status = await gw.status(principal);
    expect(status).toEqual([
      expect.objectContaining({ name: "google_workspace", oauth: true, authorized: false }),
    ]);
  });
});

function writeConnection(vault = memoryVault()) {
  return createGoogleWorkspaceWriteConnection<P>({
    vault,
    clientId: "test-client",
    clientSecret: "test-secret",
    callbackBaseUrl: "http://localhost:3000/api/latch/connections",
  });
}

type ExecutableTool = {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

/** Authorize the write connection against a mocked token endpoint. */
async function authorizeWrite(gw: ReturnType<typeof writeConnection>) {
  const oauth = gw.oauth("google_workspace_write")!;
  const start = await oauth.start(principal);
  const state = new URL(
    (start as { authorizationUrl: string }).authorizationUrl,
  ).searchParams.get("state")!;
  await oauth.finish(principal, { code: "c", state });
}

describe("google_workspace_write (gmail_send)", () => {
  const WRITE_TOOLS = [
    "gmail_send",
    "gdocs_create",
    "gdocs_append",
    "gsheets_create",
    "gsheets_append",
    "gslides_create",
  ];

  it("requests only send + the RW scopes its tools need — never gmail read/modify", async () => {
    const gw = writeConnection();
    const res = await gw.oauth("google_workspace_write")!.start(principal);
    const url = new URL((res as { authorizationUrl: string }).authorizationUrl);
    const scope = url.searchParams.get("scope")!;
    expect(scope.split(" ").sort()).toEqual(
      [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/presentations",
      ].sort(),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/latch/connections/google_workspace_write/callback",
    );
  });

  const CONNECT = "connect_google_workspace_write";

  it("unauthorized: exposes ONLY the gated, always-active connect tool", async () => {
    const gw = writeConnection();
    const opened = await gw.hostFor(["google_workspace_write"]).open(principal);
    expect(Object.keys(opened.tools)).toEqual([CONNECT]);
    expect(
      (opened as { toolApproval?: Record<string, string> }).toolApproval,
    ).toEqual({ [CONNECT]: "user-approval" });
    expect((opened as { alwaysActive?: string[] }).alwaysActive).toEqual([CONNECT]);
    // The connect tool itself just acknowledges — OAuth rides on the approval.
    expect(await (opened.tools[CONNECT] as ExecutableTool).execute({})).toEqual({
      connected: true,
      connection: "google_workspace_write",
    });
  });

  it("authorized: contributes the write tools, ALL approval-gated, only when picked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tokenResponse({ access_token: "at", expires_in: 3600, refresh_token: "rt" }),
      ),
    );
    const gw = writeConnection();
    await authorizeWrite(gw);
    const opened = await gw.hostFor(["google_workspace_write"]).open(principal);
    expect(Object.keys(opened.tools).sort()).toEqual([...WRITE_TOOLS, CONNECT].sort());
    const approval = (opened as { toolApproval?: Record<string, string> }).toolApproval!;
    for (const name of [...WRITE_TOOLS, CONNECT]) expect(approval[name]).toBe("user-approval");
    await opened.close();

    const notPicked = await gw.hostFor(["other_connection"]).open(principal);
    expect(Object.keys(notPicked.tools)).toEqual([]);
  });

  it("execute refreshes a token and posts the RFC822 raw message", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async (url) =>
        String(url).includes("/token")
          ? tokenResponse({ access_token: "at-send", expires_in: 3600, refresh_token: "rt" })
          : tokenResponse({ id: "msg-1", threadId: "thr-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gw = writeConnection();
    await authorizeWrite(gw);

    const opened = await gw.hostFor(["google_workspace_write"]).open(principal);
    const result = await (opened.tools.gmail_send as ExecutableTool).execute({
      to: "a@example.com",
      subject: "Hei ✨",
      body: "terve maailma",
      cc: "b@example.com",
    });
    expect(result).toMatchObject({ sent: true, id: "msg-1", to: "a@example.com" });

    const send = fetchMock.mock.calls.find(([u]) => String(u).includes("/messages/send"))!;
    expect((send[1]!.headers as Record<string, string>).Authorization).toBe("Bearer at-send");
    const { raw } = JSON.parse(String(send[1]!.body)) as { raw: string };
    const rfc822 = Buffer.from(raw, "base64url").toString("utf8");
    expect(rfc822).toContain("To: a@example.com");
    expect(rfc822).toContain("Cc: b@example.com");
    expect(rfc822).toContain("Subject: =?UTF-8?B?"); // non-ASCII → RFC 2047
    expect(rfc822).not.toContain("Bcc:");
    const body64 = rfc822.split("\r\n\r\n")[1]!;
    expect(Buffer.from(body64, "base64").toString("utf8")).toBe("terve maailma");
  });

  it("buildRawEmail strips CRLF from address fields (header injection)", () => {
    const rfc822 = Buffer.from(
      buildRawEmail({
        to: "x@y.z\r\nBcc: hidden@evil.example",
        subject: "s",
        body: "b",
        cc: "c@y.z\nX-Evil: 1",
      }),
      "base64url",
    ).toString("utf8");
    expect(rfc822).toContain("To: x@y.z Bcc: hidden@evil.example");
    expect(rfc822).toContain("Cc: c@y.z X-Evil: 1");
    // No injected header lines: every CRLF-delimited line is one we built.
    const headerLines = rfc822.split("\r\n\r\n")[0].split("\r\n");
    expect(headerLines.filter((l) => l.startsWith("Bcc:"))).toHaveLength(0);
    expect(headerLines.filter((l) => l.startsWith("X-Evil:"))).toHaveLength(0);
  });

  it("buildRawEmail keeps plain-ASCII subjects readable", () => {
    const rfc822 = Buffer.from(
      buildRawEmail({ to: "x@y.z", subject: "plain", body: "hi" }),
      "base64url",
    ).toString("utf8");
    expect(rfc822).toContain("Subject: plain");
  });

  /** Mock: token endpoint + per-URL API responses; returns the fetch mock. */
  function apiMock(respond: (url: string) => Record<string, unknown>) {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async (url) =>
        String(url).includes("oauth2.googleapis.com/token")
          ? tokenResponse({ access_token: "at", expires_in: 3600, refresh_token: "rt" })
          : tokenResponse(respond(String(url))),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const callBody = (
    fetchMock: ReturnType<typeof apiMock>,
    urlPart: string,
  ): Record<string, unknown> => {
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes(urlPart));
    expect(call, `no call to ${urlPart}`).toBeDefined();
    return JSON.parse(String(call![1]!.body)) as Record<string, unknown>;
  };

  it("gdocs_create makes the doc then inserts the body text", async () => {
    const fetchMock = apiMock(() => ({ documentId: "doc-1" }));
    const gw = writeConnection();
    await authorizeWrite(gw);
    const opened = await gw.hostFor(["google_workspace_write"]).open(principal);
    const result = await (opened.tools.gdocs_create as ExecutableTool).execute({
      title: "Notes",
      body: "hello doc",
    });
    expect(result).toMatchObject({ created: true, documentId: "doc-1" });
    expect(callBody(fetchMock, "docs.googleapis.com/v1/documents")).toEqual({ title: "Notes" });
    expect(callBody(fetchMock, "doc-1:batchUpdate")).toEqual({
      requests: [{ insertText: { endOfSegmentLocation: {}, text: "hello doc" } }],
    });
  });

  it("gsheets_append posts rows to the encoded range", async () => {
    const fetchMock = apiMock(() => ({}));
    const gw = writeConnection();
    await authorizeWrite(gw);
    const opened = await gw.hostFor(["google_workspace_write"]).open(principal);
    const result = await (opened.tools.gsheets_append as ExecutableTool).execute({
      spreadsheet_id: "sheet-1",
      rows: [["a", "b"]],
      range: "Sheet2!A1",
    });
    expect(result).toMatchObject({ appended: true, rowCount: 1 });
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes(":append"))!;
    expect(String(call[0])).toContain("/sheet-1/values/Sheet2!A1:append");
    expect(String(call[0])).toContain("valueInputOption=USER_ENTERED");
    expect(JSON.parse(String(call[1]!.body))).toEqual({ values: [["a", "b"]] });
  });

  it("gslides_create builds slides, fills placeholders, and drops the default blank slide", async () => {
    const fetchMock = apiMock(() => ({
      presentationId: "pres-1",
      slides: [{ objectId: "initial_blank" }],
    }));
    const gw = writeConnection();
    await authorizeWrite(gw);
    const opened = await gw.hostFor(["google_workspace_write"]).open(principal);
    const result = await (opened.tools.gslides_create as ExecutableTool).execute({
      title: "Deck",
      slides: [{ title: "Intro", body: "Welcome" }],
    });
    expect(result).toMatchObject({ created: true, presentationId: "pres-1", slideCount: 1 });
    const { requests } = callBody(fetchMock, "pres-1:batchUpdate") as {
      requests: Record<string, Record<string, unknown>>[];
    };
    const ids = requests.flatMap((r) =>
      [r.createSlide?.objectId, r.insertText?.objectId].filter(Boolean),
    ) as string[];
    for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(5);
    expect(requests.some((r) => r.insertText?.text === "Intro")).toBe(true);
    expect(requests.some((r) => r.insertText?.text === "Welcome")).toBe(true);
    // The API's seeded blank slide is deleted AFTER the real slides exist, so
    // a 1-slide input yields a 1-slide deck (never an empty one mid-batch).
    expect(requests.at(-1)).toEqual({ deleteObject: { objectId: "initial_blank" } });
  });
});
