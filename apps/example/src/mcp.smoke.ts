import { createClient } from "@libsql/client";
import { createVault, type Scope } from "@intentface/latch-core";
import { createSqliteSecretStore, migrate } from "@intentface/latch-drizzle";
import {
  buildAuthHeaders,
  createMcpHost,
  isHostAllowed,
  type McpConnection,
} from "@intentface/latch-mcp";
import { assert } from "./setup.js";

function randomKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * MCP host guards: the SSRF allowlist and vault-brokered auth — the two
 * Latch-specific protections layered on the SDK client. (Live tool discovery
 * needs a running MCP server and is exercised separately; here we prove the
 * security boundary deterministically, no sockets opened.)
 */
async function main() {
  const orgA: Scope = { orgId: "org_a" };

  // --- SSRF allowlist matching -------------------------------------------
  assert(isHostAllowed("mcp.linear.app", ["mcp.linear.app"]), "exact host allowed");
  assert(isHostAllowed("api.example.com", [".example.com"]), "subdomain allowed via .suffix");
  assert(isHostAllowed("example.com", [".example.com"]), "apex allowed via .suffix");
  assert(!isHostAllowed("evil.com", ["mcp.linear.app", ".example.com"]), "unlisted host rejected");
  assert(!isHostAllowed("notexample.com", [".example.com"]), "suffix is not a substring match");

  // --- vault-brokered bearer auth ----------------------------------------
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const vault = createVault({ store: createSqliteSecretStore(client), masterKey: randomKey() });
  await vault.set(orgA, "linear_token", "lin_api_secret");

  const bearerConn: McpConnection = {
    name: "linear",
    url: "https://mcp.linear.app/mcp",
    auth: { type: "bearer", vaultKey: "linear_token" },
  };
  const headers = await buildAuthHeaders(bearerConn, orgA, vault.resolver);
  assert(headers.Authorization === "Bearer lin_api_secret", "bearer token resolved from vault");

  const staticConn: McpConnection = {
    name: "internal",
    url: "https://mcp.internal/mcp",
    auth: { type: "headers", headers: { "x-api-key": "k1" } },
  };
  assert(
    (await buildAuthHeaders(staticConn, orgA, vault.resolver))["x-api-key"] === "k1",
    "static headers pass through",
  );

  // missing secret → fail closed
  let missingThrew = false;
  try {
    await buildAuthHeaders(
      { name: "x", url: "https://x/mcp", auth: { type: "bearer", vaultKey: "nope" } },
      orgA,
      vault.resolver,
    );
  } catch {
    missingThrew = true;
  }
  assert(missingThrew, "bearer auth fails closed when the secret is absent");

  // --- host.open() enforces the allowlist BEFORE connecting --------------
  const host = createMcpHost({
    connections: [{ name: "evil", url: "https://evil.com/mcp" }],
    allowedHosts: ["mcp.linear.app"],
    secrets: vault.resolver,
  });
  let ssrfBlocked = false;
  try {
    await host.open(orgA);
  } catch (e) {
    ssrfBlocked = e instanceof Error && e.message.includes("not allowed");
  }
  assert(ssrfBlocked, "open() refuses a disallowed host before opening a socket");

  console.log("✅ mcp smoke passed — SSRF allowlist + vault-brokered auth enforced");
}

main().catch((e) => {
  console.error("❌ mcp smoke failed:", e);
  throw e;
});
