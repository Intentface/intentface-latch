import type { SecretResolver } from "./context.js";
import { UnsupportedOperationError, type PurgeResult } from "./storage.js";

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
 * re-encrypting values (`vault.rotate()`). Crypto is Web Crypto
 * (`crypto.subtle`) — portable to Node and edge/serverless, no native deps.
 *
 * Wrapped-DEK format. Records written since key ids exist carry them in
 * `wrappedDek` itself, `v2:<keyId>:<binding>:<base64>`, so no store needs a new
 * column: `keyId` names the master key that wrapped it, and `binding` says what
 * the wrap is bound to (AES-GCM additional data): `o` the owner key and the
 * secret's name, `n` the name only (a store that can't say its owner key).
 * Bound, a record copied into another owner's row, or under another name, no
 * longer decrypts. Records without the prefix are from before: unbound, and
 * wrapped by whichever configured key opens them. `rotate()` brings them over.
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
  /** Saves an encrypted record for this owner, replacing one with the same key. */
  put(principal: P, record: SecretRecord): Promise<void>;
  /** This owner's record for the key, or `null`. */
  get(principal: P, key: string): Promise<SecretRecord | null>;
  /** Removes this owner's record for the key. */
  delete(principal: P, key: string): Promise<void>;
  /** This owner's keys, never values. */
  list(principal: P): Promise<string[]>;
  /**
   * OPTIONAL. Delete everything this store keeps (every secret under it) for an owner path, in passes
   * (see `StorageAdapter.purgeOwner`): call until `done`. Without it,
   * `runtime.purgeOwner` refuses when this store is passed to it.
   */
  purgeOwner?(segments: string[], opts?: { batchSize?: number }): Promise<PurgeResult>;
  /**
   * OPTIONAL. The owner key this store files `key` under for this principal:
   * the same value it stores in the row. With it, the vault binds each secret
   * to its owner, so a record moved into another owner's row won't decrypt;
   * without it, only to the secret's name.
   */
  ownerKeyOf?(principal: P, key: string): string;
  /**
   * OPTIONAL system op, for `vault.rotate()`: every record, with the owner key
   * it's stored under, in pages ordered by a stable cursor.
   */
  scan?(opts: { after?: string; limit: number }): Promise<{ records: StoredSecret[]; next?: string }>;
  /**
   * OPTIONAL system op, for `vault.rotate()`: replace a record's wrapped data
   * key, only while it still has `expectedWrappedDek` (a secret saved again in
   * the meantime keeps its new value). Returns whether it applied.
   */
  replaceWrap?(
    owner: string,
    key: string,
    wrap: Pick<SecretRecord, "wrappedDek" | "dekIv">,
    expectedWrappedDek: string,
  ): Promise<boolean>;
}

/** A record as `SecretStore.scan` returns it: with the owner key it's stored under. */
export interface StoredSecret extends SecretRecord {
  owner: string;
}

/**
 * A master key for `createVault`: one the vault holds (`{ id, key }`, 32
 * random bytes, base64), or one kept in a key service you call
 * (`VaultKeyProvider`).
 */
export type VaultKey = { id: string; key: string } | VaultKeyProvider;

/**
 * A master key that stays in a key service (AWS KMS, Google Cloud KMS,
 * HashiCorp Vault, your own HSM): the vault hands it each secret's data key to
 * wrap, and the wrapped bytes back to unwrap, and never sees the key itself.
 * Each `get` and `set` makes one call; cache in your implementation if that's
 * too many.
 */
export interface VaultKeyProvider {
  /** Letters, digits, `_` and `-`, up to 32: recorded with every secret it wraps. */
  id: string;
  /** Encrypt a 32-byte data key. Bind it to `binding` (the service's encryption context or additional data). */
  wrap(dataKey: Uint8Array<ArrayBuffer>, binding: VaultKeyBinding): Promise<Uint8Array>;
  /**
   * Decrypt what `wrap` returned. Must throw, not return something else, when
   * the bytes weren't wrapped by this key with this same `binding`: that's
   * what stops a secret copied into another owner's row from opening there.
   */
  unwrap(wrapped: Uint8Array<ArrayBuffer>, binding: VaultKeyBinding): Promise<Uint8Array>;
}

/** What a data key is bound to: the secret it belongs to, in the two shapes key services take. */
export interface VaultKeyBinding {
  /** As an encryption context (AWS KMS `EncryptionContext`): `vault`, `secret` and, when the store says it, `owner`. */
  context: Record<string, string>;
  /** The same, as bytes, for services that take additional authenticated data (Google Cloud KMS, AES-GCM). */
  aad: Uint8Array;
}

/**
 * Per-customer secrets, encrypted in your database: API keys, bot tokens, the
 * OAuth tokens of a user's connections. Every call takes the principal the
 * secret belongs to; the store's `owner` decides whether that's one person or
 * the whole team. Values come back only to your server code.
 */
export interface Vault<P> {
  /** Saves a secret, encrypted, replacing any value under that key. This is also how you rotate one. */
  set(principal: P, key: string, value: string): Promise<void>;
  /** The secret's value, or `undefined` if there is none. Use it in your server code and tools; never return it to the model or the browser. */
  get(principal: P, key: string): Promise<string | undefined>;
  /** Whether a secret is set, without decrypting it. For a settings page's "connected" state. */
  has(principal: P, key: string): Promise<boolean>;
  /** Removes a secret. Nothing that used it can read it afterwards. */
  delete(principal: P, key: string): Promise<void>;
  /** The keys set for this owner. Names only, never values. */
  list(principal: P): Promise<string[]>;
  /** `get` as a function, for what takes a resolver: `createMcpConnections({ secrets: vault.resolver })`. */
  readonly resolver: SecretResolver<P>;
  /**
   * Re-wraps every secret not yet under the current master key (and binding)
   * onto it. Values aren't re-encrypted, so it's quick. Run it after adding a
   * new `masterKey` with the old one in `previousKeys`; when it reports
   * `remaining: 0`, nothing needs the old keys any more and you can remove
   * them. Safe to run again or stop part-way. Needs a store with `scan` and
   * `replaceWrap` (the shipped ones have them); throws
   * `UnsupportedOperationError` otherwise.
   */
  rotate(opts?: { batchSize?: number }): Promise<{
    /** Records looked at. */
    checked: number;
    /** Records moved onto the current key. */
    rewrapped: number;
    /**
     * Records still not on the current key: saved again mid-rotation (run it
     * once more), or in `errors`.
     */
    remaining: number;
    /** Records that couldn't be re-wrapped, usually because no configured key opens them. */
    errors: { owner: string; key: string; error: unknown }[];
  }>;
}

// --- base64 <-> bytes (no Buffer; works in Node + browsers/edge) ------------
function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(b64: string): Uint8Array<ArrayBuffer> {
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

/** The additional data a v2 wrap is bound to. */
const wrapContext = (binding: "o" | "n", owner: string | undefined, key: string) =>
  enc.encode(`latch-vault/v2\u0000${binding === "o" ? owner : ""}\u0000${key}`);

const keyBinding = (binding: "o" | "n", owner: string | undefined, key: string): VaultKeyBinding => ({
  context: { vault: "latch-vault/v2", secret: key, ...(binding === "o" ? { owner: owner! } : {}) },
  aad: wrapContext(binding, owner, key),
});

/** A configured master key: held here, or in a key service. */
type Kek = { id: string; local: Promise<CryptoKey> } | { id: string; provider: VaultKeyProvider };

type ParsedWrap = { version: 1; data: Uint8Array<ArrayBuffer> } | { version: 2; keyId: string; binding: "o" | "n"; data: Uint8Array<ArrayBuffer> };

function parseWrap(wrappedDek: string): ParsedWrap {
  if (!wrappedDek.startsWith("v2:")) return { version: 1, data: fromB64(wrappedDek) };
  const [, keyId, binding, data] = wrappedDek.split(":");
  if (!keyId || (binding !== "o" && binding !== "n") || data === undefined) throw new Error("Vault: unreadable wrapped key");
  return { version: 2, keyId, binding, data: fromB64(data) };
}

/**
 * Builds a vault over a `SecretStore` (`createPostgresSecretStore` or
 * `createSqliteSecretStore` from `@intentface/latch-drizzle`). `masterKey` is
 * 32 random bytes, base64-encoded: keep it in an environment variable or a key
 * manager, never in the database.
 *
 * To rotate it, give the new key an id and keep the old one readable:
 * `{ masterKey: { id: "k2", key: NEW }, previousKeys: [{ id: "k1", key: OLD }] }`,
 * then run `vault.rotate()`. A plain string is a key with the id `default`.
 * Losing a key that secrets are still wrapped with makes them unreadable.
 *
 * To keep the master key in a key service instead (AWS KMS, Google Cloud KMS,
 * HashiCorp Vault), pass a `VaultKeyProvider` that calls it.
 */
export function createVault<P>(opts: {
  store: SecretStore<P>;
  masterKey: string | VaultKey;
  /** Keys that can still read secrets, but never wrap new ones: the ones you're rotating away from. */
  previousKeys?: VaultKey[];
}): Vault<P> {
  const { store } = opts;
  const current: VaultKey = typeof opts.masterKey === "string" ? { id: "default", key: opts.masterKey } : opts.masterKey;
  const keks = new Map<string, Kek>();
  for (const k of [current, ...(opts.previousKeys ?? [])]) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(k.id)) throw new Error(`Vault key id "${k.id}": use letters, digits, _ and -, up to 32`);
    if (keks.has(k.id)) throw new Error(`Vault key id "${k.id}" is used twice`);
    if ("key" in k) {
      const raw = fromB64(k.key);
      if (raw.length !== 32) throw new Error(`Vault key "${k.id}" must be base64 of 32 bytes (256-bit)`);
      keks.set(k.id, { id: k.id, local: crypto.subtle.importKey("raw", bs(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]) });
    } else {
      if (typeof k.wrap !== "function" || typeof k.unwrap !== "function") throw new Error(`Vault key "${k.id}" needs a key, or wrap and unwrap`);
      keks.set(k.id, { id: k.id, provider: k });
    }
  }
  const currentKek = keks.get(current.id)!;
  /** How new wraps are bound with this store. */
  const binding: "o" | "n" = store.ownerKeyOf ? "o" : "n";

  /** Wrap a raw data key under the current master key, bound to its owner and name. */
  async function wrap(rawDek: Uint8Array<ArrayBuffer>, owner: string | undefined, key: string): Promise<Pick<SecretRecord, "wrappedDek" | "dekIv">> {
    const prefix = `v2:${current.id}:${binding}:`;
    if ("provider" in currentKek) {
      // The service keeps whatever IV it uses inside the bytes it returns.
      const wrapped = await currentKek.provider.wrap(rawDek, keyBinding(binding, owner, key));
      return { wrappedDek: prefix + toB64(wrapped), dekIv: "" };
    }
    const dekIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(dekIv), additionalData: bs(wrapContext(binding, owner, key)) },
      await currentKek.local,
      bs(rawDek),
    );
    return { wrappedDek: prefix + toB64(wrapped), dekIv: toB64(dekIv) };
  }

  /** A record's raw data key. AES-GCM refuses the wrong key, or a record moved from its row. */
  async function unwrap(record: SecretRecord, owner: string | undefined): Promise<Uint8Array<ArrayBuffer>> {
    const parsed = parseWrap(record.wrappedDek);
    const named = parsed.version === 2 ? keks.get(parsed.keyId) : undefined;
    if (parsed.version === 2 && named && "provider" in named) {
      // A key service's own error (refused, unreachable) says more than ours would.
      return new Uint8Array(await named.provider.unwrap(parsed.data, keyBinding(parsed.binding, owner, record.key)));
    }
    const iv = bs(fromB64(record.dekIv));
    const params: AesGcmParams =
      parsed.version === 2 ? { name: "AES-GCM", iv, additionalData: bs(wrapContext(parsed.binding, owner, record.key)) } : { name: "AES-GCM", iv };
    // The named key when it's configured; otherwise (a record from before key
    // ids, or one named by an id since renamed) whichever key held here opens
    // it. Key services aren't tried blind: that would be a call to each.
    const locals = [...keks.values()].flatMap((k) => ("local" in k ? [k.local] : []));
    for (const kek of named && "local" in named ? [named.local] : locals) {
      try {
        return new Uint8Array(await crypto.subtle.decrypt(params, await kek, bs(parsed.data)));
      } catch {
        // not this key
      }
    }
    const which = parsed.version === 2 ? `key "${parsed.keyId}"` : "a key from before key ids";
    throw new Error(
      `Vault: can't open secret "${record.key}", wrapped by ${which}: that key isn't configured, or the record was moved or altered`,
    );
  }

  async function encryptValue(value: string, owner: string | undefined, key: string) {
    const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, dek, bs(enc.encode(value)));
    return { ciphertext: toB64(ciphertext), iv: toB64(iv), ...(await wrap(new Uint8Array(await crypto.subtle.exportKey("raw", dek)), owner, key)) };
  }

  async function decryptValue(record: SecretRecord, owner: string | undefined): Promise<string> {
    const dek = await crypto.subtle.importKey("raw", bs(await unwrap(record, owner)), { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(fromB64(record.iv)) }, dek, bs(fromB64(record.ciphertext)));
    return dec.decode(plaintext);
  }

  const ownerOf = (principal: P, key: string) => store.ownerKeyOf?.(principal, key);

  const get: Vault<P>["get"] = async (principal, key) => {
    const record = await store.get(principal, key);
    if (!record) return undefined;
    return decryptValue(record, ownerOf(principal, key));
  };

  /** Whether a record is already on the current key with this store's binding. */
  const isCurrent = (record: SecretRecord) => {
    const parsed = parseWrap(record.wrappedDek);
    return parsed.version === 2 && parsed.keyId === current.id && parsed.binding === binding;
  };

  return {
    async set(principal, key, value) {
      const now = Date.now();
      await store.put(principal, {
        key,
        ...(await encryptValue(value, ownerOf(principal, key), key)),
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

    async rotate(rotateOpts) {
      if (!store.scan || !store.replaceWrap) throw new UnsupportedOperationError("vault.rotate");
      const limit = rotateOpts?.batchSize ?? 500;
      let checked = 0;
      let rewrapped = 0;
      let remaining = 0;
      const errors: { owner: string; key: string; error: unknown }[] = [];
      let after: string | undefined;
      do {
        const page = await store.scan({ after, limit });
        for (const record of page.records) {
          checked++;
          if (isCurrent(record)) continue;
          try {
            const next = await wrap(await unwrap(record, record.owner), record.owner, record.key);
            if (await store.replaceWrap(record.owner, record.key, next, record.wrappedDek)) rewrapped++;
            else remaining++;
          } catch (error) {
            // One unreadable record mustn't hold up the rest.
            errors.push({ owner: record.owner, key: record.key, error });
            remaining++;
          }
        }
        after = page.next;
      } while (after);
      return { checked, rewrapped, remaining, errors };
    },
  };
}
