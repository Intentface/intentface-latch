import { createClient } from "@libsql/client";
import { createVault } from "@intentface/latch-core";
import { createSqliteSecretStore, migrate } from "@intentface/latch-drizzle";
import {
  createMcpOAuth,
  createVaultOAuthProvider,
  type McpOAuthConfig,
} from "@intentface/latch-mcp";
import { assert, owner, type Principal } from "./setup.js";

function randomKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * MCP OAuth provider: the Vault-backed storage + the security guards. Proves
 * tokens/verifier/state/DCR round-trip through the Vault per tenant, are
 * encrypted at rest, isolate across tenants, and that the authorization-server
 * allowlist is enforced. (The live handshake — `start()`/`finish()` — drives a
 * real IdP over the network and is exercised against an IdP separately.)
 */
async function main() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const vault = createVault<Principal>({ store: createSqliteSecretStore<Principal>(client, { owner }), masterKey: randomKey() });

  const config: McpOAuthConfig = {
    name: "linear",
    serverUrl: "https://mcp.linear.app/mcp",
    redirectUrl: "https://app.example.com/connections/linear/callback",
    clientMetadata: {
      redirect_uris: ["https://app.example.com/connections/linear/callback"],
      client_name: "Latch Example",
    },
    allowedAuthorizationServers: ["https://auth.linear.app"],
  };

  const orgA: Principal = { orgId: "org_a" };
  const { provider, takeAuthorizationUrl } = createVaultOAuthProvider({ vault, principal: orgA, config });

  // --- config getters ----------------------------------------------------
  assert(provider.redirectUrl === config.redirectUrl, "redirectUrl is configurable");
  assert(provider.clientMetadata.client_name === "Latch Example", "clientMetadata exposed");

  // --- flow state round-trips through the Vault --------------------------
  await provider.saveCodeVerifier("verifier_abc");
  assert((await provider.codeVerifier()) === "verifier_abc", "code verifier round-trips");

  await provider.saveState!("state_xyz");
  assert((await provider.storedState!()) === "state_xyz", "CSRF state round-trips");
  assert((await provider.state!()).length > 0, "state() generates a fresh value");

  await provider.saveClientInformation!({ client_id: "cid_1" });
  assert((await provider.clientInformation())?.client_id === "cid_1", "DCR client info round-trips");

  const tokens = { access_token: "at_SECRET_123", token_type: "bearer", refresh_token: "rt_456" };
  await provider.saveTokens(tokens);
  assert((await provider.tokens())?.access_token === "at_SECRET_123", "tokens round-trip");

  // --- tokens are encrypted at rest (Vault) ------------------------------
  const raw = await client.execute(
    "SELECT ciphertext FROM latch_secrets WHERE key = 'mcp_oauth:linear:tokens'",
  );
  assert(
    !String(raw.rows[0]?.ciphertext ?? "").includes("at_SECRET_123"),
    "the access token is NOT stored in plaintext",
  );

  // --- redirect capture --------------------------------------------------
  provider.redirectToAuthorization(new URL("https://auth.linear.app/authorize?x=1"));
  assert(
    takeAuthorizationUrl()?.toString() === "https://auth.linear.app/authorize?x=1",
    "redirectToAuthorization captures the URL for the route to 302 to",
  );

  // --- authorization-server allowlist ------------------------------------
  provider.validateAuthorizationServerURL!(config.serverUrl, "https://auth.linear.app");
  let blocked = false;
  try {
    provider.validateAuthorizationServerURL!(config.serverUrl, "https://evil-idp.com");
  } catch {
    blocked = true;
  }
  assert(blocked, "a disallowed authorization server is rejected (anti-phishing)");

  // --- tenant isolation --------------------------------------------------
  const orgB = createVaultOAuthProvider({ vault, principal: { orgId: "org_b" }, config }).provider;
  assert((await orgB.tokens()) === undefined, "another tenant cannot read the tokens");

  // --- McpOAuth lifecycle ------------------------------------------------
  const oauth = createMcpOAuth({ vault, config });
  assert(await oauth.isAuthorized(orgA), "isAuthorized true once tokens exist");
  assert(!(await oauth.isAuthorized({ orgId: "org_b" })), "isAuthorized false for an unconnected tenant");
  assert(typeof oauth.provider(orgA).tokens === "function", "provider(scope) returns a usable OAuthClientProvider");

  // --- invalidate --------------------------------------------------------
  await provider.invalidateCredentials!("tokens");
  assert((await provider.tokens()) === undefined, "invalidateCredentials clears tokens");
  assert(!(await oauth.isAuthorized(orgA)), "isAuthorized false after invalidation");

  console.log("✅ oauth smoke passed — Vault-backed provider: storage, encryption, isolation, allowlist");
}

main().catch((e) => {
  console.error("❌ oauth smoke failed:", e);
  throw e;
});
