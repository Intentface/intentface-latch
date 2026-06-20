import { createClient } from "@libsql/client";
import { createVault } from "@intentface/latch-core";
import { createSqliteSecretStore, migrate } from "@intentface/latch-drizzle";
import { assert, owner, type Principal } from "./setup.js";

/** A random base64 256-bit key (in prod this lives in env/KMS, never the DB). */
function randomKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * Vault: envelope-encrypted secrets, scoped per tenant. Proves the value is
 * encrypted at rest, only the owning scope can read it, and the wrong master
 * key can't decrypt it.
 */
async function main() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const store = createSqliteSecretStore<Principal>(client, { owner });
  const masterKey = randomKey();
  const vault = createVault<Principal>({ store, masterKey });

  const orgA: Principal = { orgId: "org_a" };

  // --- roundtrip ---------------------------------------------------------
  await vault.set(orgA, "clockify_token", "ck_live_123");
  assert((await vault.get(orgA, "clockify_token")) === "ck_live_123", "set→get roundtrip");
  assert(await vault.has(orgA, "clockify_token"), "has() true for a stored secret");
  assert(
    JSON.stringify(await vault.list(orgA)) === JSON.stringify(["clockify_token"]),
    "list() returns keys (never values)",
  );

  // --- encrypted at rest -------------------------------------------------
  const raw = await client.execute("SELECT ciphertext, iv, wrapped_dek FROM latch_secrets LIMIT 1");
  const ciphertext = String(raw.rows[0]?.ciphertext ?? "");
  assert(ciphertext.length > 0, "a row was persisted");
  assert(!ciphertext.includes("ck_live_123"), "plaintext is NOT in the stored ciphertext");
  assert(String(raw.rows[0]?.wrapped_dek ?? "").length > 0, "the DEK is wrapped (envelope)");

  // --- tenant isolation --------------------------------------------------
  assert(
    (await vault.get({ orgId: "org_b" }, "clockify_token")) === undefined,
    "another org cannot read the secret",
  );

  // --- scope strictness (user-level vs org-level) ------------------------
  await vault.set({ orgId: "org_a", userId: "u1" }, "personal_token", "tok_u1");
  assert(
    (await vault.get({ orgId: "org_a", userId: "u1" }, "personal_token")) === "tok_u1",
    "user-scoped secret readable by that user",
  );
  assert(
    (await vault.get(orgA, "personal_token")) === undefined,
    "user-scoped secret is NOT visible at org scope",
  );

  // --- wrong master key cannot decrypt ----------------------------------
  const wrongVault = createVault<Principal>({ store, masterKey: randomKey() });
  let threw = false;
  try {
    await wrongVault.get(orgA, "clockify_token");
  } catch {
    threw = true;
  }
  assert(threw, "decryption fails under a different master key (AES-GCM auth)");

  // --- delete ------------------------------------------------------------
  await vault.delete(orgA, "clockify_token");
  assert((await vault.get(orgA, "clockify_token")) === undefined, "deleted secret is gone");

  // --- resolver is a SecretResolver (the read-side tools consume) --------
  assert(typeof vault.resolver === "function", "exposes a SecretResolver");

  console.log("✅ vault smoke passed — envelope encryption, scoping, isolation, key safety");
}

main().catch((e) => {
  console.error("❌ vault smoke failed:", e);
  throw e;
});
