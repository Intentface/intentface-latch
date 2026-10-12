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
 *
 * `cost` is scrypt's N. The default, 2^14, is kept so existing deployments
 * derive the same key; for a new deployment pass `2 ** 17` (about 128 MB and a
 * fraction of a second, once at startup). Changing it changes the key: move an
 * existing vault over by adding the new key with the old one in
 * `previousKeys` and running `vault.rotate()`.
 */
export function deriveMasterKey(
  passphrase: string,
  opts: {
    salt: string;
    /** scrypt's N, a power of two from 2^14 (the default) up to 2^20. */
    cost?: number;
  },
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
  const N = opts.cost ?? 2 ** 14;
  if (!Number.isInteger(Math.log2(N)) || N < 2 ** 14 || N > 2 ** 20) {
    throw new Error("deriveMasterKey: cost must be a power of two from 2 ** 14 to 2 ** 20");
  }
  // scrypt needs 128 * N * r bytes (r = 8); Node refuses past 32 MB unless told.
  return scryptSync(passphrase, opts.salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 }).toString("base64");
}
