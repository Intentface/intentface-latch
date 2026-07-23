import type { SecretResolver } from "./context.js";

/**
 * The Vault — server-side, envelope-encrypted secret storage.
 *
 * Connection credentials (API keys, OAuth tokens) live here, encrypted at rest
 * in the customer's own database and scoped per tenant. The decrypted value is
 * brokered server-side only: it reaches a tool's egress (fetch/MCP) but never
 * the model, logs, or telemetry. The read-side is a `SecretResolver`, so the
 * existing context/tools plumbing consumes it without knowing it's encrypted.
 *
 * Envelope encryption: each secret gets a random data key (DEK) that encrypts
 * the value (AES-256-GCM); the DEK itself is wrapped by a master key (KEK) held
 * in config/env/KMS. Rotating the KEK only requires re-wrapping DEKs, not
 * re-encrypting values. Crypto is Web Crypto (`crypto.subtle`) — portable to
 * Node and edge/serverless, no native deps.
 */

/** The opaque encrypted record persisted by a `SecretStore`. Never holds plaintext. */
export interface SecretRecord {
  key: string;
  /** base64 AES-GCM ciphertext of the value (auth tag appended by Web Crypto). */
  ciphertext: string;
  /** base64 nonce used to encrypt the value. */
  iv: string;
  /** base64 AES-GCM ciphertext of the raw DEK, wrapped under the KEK. */
  wrappedDek: string;
  /** base64 nonce used to wrap the DEK. */
  dekIv: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Persistence seam for encrypted secret records (Drizzle impl in latch-drizzle).
 * Isolation lives here: each method receives the opaque `Principal` and the store
 * scopes by it (the default derives an `owner` key). The framework never reads `P`.
 */
export interface SecretStore<P> {
  put(principal: P, record: SecretRecord): Promise<void>;
  get(principal: P, key: string): Promise<SecretRecord | null>;
  delete(principal: P, key: string): Promise<void>;
  /** Keys only — never values — for the caller. */
  list(principal: P): Promise<string[]>;
}

/** The Vault operations. `get` returns decrypted plaintext; storage stays opaque. */
export interface Vault<P> {
  set(principal: P, key: string, value: string): Promise<void>;
  get(principal: P, key: string): Promise<string | undefined>;
  has(principal: P, key: string): Promise<boolean>;
  delete(principal: P, key: string): Promise<void>;
  list(principal: P): Promise<string[]>;
  /** Read-side adapter for context/tools (a `SecretResolver`). */
  readonly resolver: SecretResolver<P>;
}

// --- base64 <-> bytes (no Buffer; works in Node + browsers/edge) ------------
function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// `deriveMasterKey` (passphrase → KEK via scrypt) lives in
// `@intentface/latch-core/node` — it needs `node:crypto`, and importing it here
// would make the package root unusable on edge/serverless runtimes.

// Web Crypto's lib types narrow BufferSource to ArrayBuffer-backed views; our
// Uint8Arrays are structurally fine, so coerce at the crypto call boundary.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

/**
 * Build a Vault over a `SecretStore`. `masterKey` is a base64-encoded 32-byte
 * (256-bit) key — generate with `crypto.getRandomValues(new Uint8Array(32))`
 * and keep it in env/KMS, never in the database.
 */
export function createVault<P>(opts: {
  store: SecretStore<P>;
  masterKey: string;
}): Vault<P> {
  const { store } = opts;
  const rawKek = fromB64(opts.masterKey);
  if (rawKek.length !== 32) {
    throw new Error("Vault masterKey must be base64 of 32 bytes (256-bit)");
  }
  // Import the KEK once; reused to wrap/unwrap per-secret DEKs.
  const kekPromise = crypto.subtle.importKey(
    "raw",
    bs(rawKek),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  async function encryptValue(value: string): Promise<
    Pick<SecretRecord, "ciphertext" | "iv" | "wrappedDek" | "dekIv">
  > {
    const kek = await kekPromise;
    const dek = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv) },
      dek,
      bs(enc.encode(value)),
    );
    const rawDek = await crypto.subtle.exportKey("raw", dek);
    const dekIv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedDek = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(dekIv) },
      kek,
      rawDek,
    );
    return {
      ciphertext: toB64(ciphertext),
      iv: toB64(iv),
      wrappedDek: toB64(wrappedDek),
      dekIv: toB64(dekIv),
    };
  }

  async function decryptValue(record: SecretRecord): Promise<string> {
    const kek = await kekPromise;
    const rawDek = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bs(fromB64(record.dekIv)) },
      kek,
      bs(fromB64(record.wrappedDek)),
    );
    const dek = await crypto.subtle.importKey(
      "raw",
      rawDek,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bs(fromB64(record.iv)) },
      dek,
      bs(fromB64(record.ciphertext)),
    );
    return dec.decode(plaintext);
  }

  const get: Vault<P>["get"] = async (principal, key) => {
    const record = await store.get(principal, key);
    if (!record) return undefined;
    return decryptValue(record);
  };

  return {
    async set(principal, key, value) {
      const now = Date.now();
      await store.put(principal, {
        key,
        ...(await encryptValue(value)),
        createdAt: now,
        updatedAt: now,
      });
    },
    get,
    async has(principal, key) {
      return (await store.get(principal, key)) != null;
    },
    async delete(principal, key) {
      await store.delete(principal, key);
    },
    list(principal) {
      return store.list(principal);
    },
    resolver: (principal, key) => get(principal, key),
  };
}
