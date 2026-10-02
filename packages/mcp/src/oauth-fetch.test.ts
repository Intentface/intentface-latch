import { describe, expect, it } from "vitest";
import { createOAuthDiscoveryFetch } from "./oauth-fetch.js";

/** A fetch that serves one discovery document for every URL. */
const serving = (doc: unknown) => async () =>
  new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });

describe("createOAuthDiscoveryFetch", () => {
  it("forces https on a proxied server's discovery, and strips the issuer's trailing slash", async () => {
    const f = createOAuthDiscoveryFetch({
      forceScheme: "https",
      baseFetch: serving({ issuer: "http://mcp.example.com/", token_endpoint: "http://mcp.example.com/token" }),
    });
    const doc = await (await f("https://mcp.example.com/.well-known/oauth-authorization-server")).json();
    expect(doc).toMatchObject({ issuer: "https://mcp.example.com", token_endpoint: "https://mcp.example.com/token" });
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("leaves a local server's http scheme alone (%s)", async (host) => {
    const f = createOAuthDiscoveryFetch({
      forceScheme: "https",
      baseFetch: serving({ resource: `http://${host}:3011/mcp`, authorization_servers: [`http://${host}:3011/api/auth/`] }),
    });
    const doc = await (await f(`http://${host}:3011/.well-known/oauth-protected-resource/mcp`)).json();
    // The SDK compares `resource` with the URL it connected to; https here broke every local server.
    expect(doc.resource).toBe(`http://${host}:3011/mcp`);
    expect(doc.authorization_servers[0]).toMatch(/^http:\/\//);
  });
});
