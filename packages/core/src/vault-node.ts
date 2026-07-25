import { scryptSync } from "node:crypto";

/**
 * Derive a base64 32-byte `masterKey` from a free-form passphrase via scrypt.
 *
 * NOTE — Node-only entry point (`@intentface/latch-core/node`): the vault
 * itself is pure Web Crypto (`crypto.subtle`) so the package root stays
 * portable to edge/serverless. `scryptSync` is a Node-only KDF and is used
 * deliberately here: it's a convenience for the common case where the KEK
 * comes from a human passphrase env var rather than a raw base64 key, and key
 * derivation happens once at startup on the server (never in an edge request
 * path). Consumers on non-Node runtimes should supply a raw base64 32-byte
 * `masterKey` to `createVault` directly and skip this helper.
 *
 * `salt` is required and must be a stable per-deployment value (deployment
 * config/KMS — it need not be secret): a shared default salt would make the
 * same passphrase yield the same KEK on every deployment.
 */
export function deriveMasterKey(
  passphrase: string,
  opts: { salt: string },
): string {
  // Fail closed: a missing/blank passphrase or salt (an unset env var) must not
  // silently derive a valid-looking key — that would encrypt the vault under a
  // predictable KEK.
  if (!passphrase || passphrase.trim() === "") {
    throw new Error("deriveMasterKey: passphrase must be a non-empty string");
  }
  if (!opts?.salt || opts.salt.trim() === "") {
    throw new Error(
      "deriveMasterKey: salt must be a non-empty, deployment-stable string",
    );
  }
  return scryptSync(passphrase, opts.salt, 32).toString("base64");
}
