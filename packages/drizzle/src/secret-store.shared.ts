import { and, asc, eq, gt } from "drizzle-orm";
import { encodeOwnerKey, type SecretRecord, type SecretStore } from "@intentface/latch-core";
import { deleteBatch, underOwnerPath } from "./owner-path.js";

/**
 * Dialect-shared `SecretStore` implementation — persists the Vault's opaque
 * encrypted records. It never sees plaintext; encryption/decryption happens in
 * `createVault`. The SQLite and Postgres entry points pass their dialect's
 * schema; nothing else differs.
 */

export interface SecretStoreSchema {
  secrets: any;
}

export interface SharedSecretStoreOptions<P> {
  /**
   * Derive the ownership key for a principal — credential isolation boundary.
   * Can differ from the storage adapter's `owner` (e.g. credentials shared at the
   * tenant level while chats are per-user). Server-derived only.
   *
   * The optional `key` argument enables secret-class scoping: a store can place
   * a secret in a different owner bucket based on its key (e.g. workspace-shared
   * OAuth tokens vs. per-user API keys). `list()` has no key context and passes
   * none, so the derivation must be stable for the enumerated bucket.
   */
  owner: (principal: P, key?: string) => string[];
}

/** Join an `owner` path into one composite key; refuses a missing or empty segment. */
function ownerKeyOf<P>(
  owner: (p: P, key?: string) => string[],
  principal: P,
  key?: string,
): string {
  return encodeOwnerKey(owner(principal, key));
}

/** Stable composite id from the ownership key + secret key. */
const secretId = (ownerKey: string, key: string) => `${ownerKey}:${key}`;

export function makeSecretStore<P>(
  db: any,
  s: SecretStoreSchema,
  opts: SharedSecretStoreOptions<P>,
): SecretStore<P> {
  const ownerKey = (p: P, key?: string) => ownerKeyOf(opts.owner, p, key);

  const rowToRecord = (r: any): SecretRecord => ({
    key: r.key,
    ciphertext: r.ciphertext,
    iv: r.iv,
    wrappedDek: r.wrappedDek,
    dekIv: r.dekIv,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  return {
    async put(principal, r) {
      const owner = ownerKey(principal, r.key);
      await db
        .insert(s.secrets)
        .values({
          id: secretId(owner, r.key),
          owner,
          key: r.key,
          ciphertext: r.ciphertext,
          iv: r.iv,
          wrappedDek: r.wrappedDek,
          dekIv: r.dekIv,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })
        .onConflictDoUpdate({
          target: s.secrets.id,
          set: {
            ciphertext: r.ciphertext,
            iv: r.iv,
            wrappedDek: r.wrappedDek,
            dekIv: r.dekIv,
            updatedAt: r.updatedAt,
          },
        });
    },

    async get(principal, key) {
      const rows = await db
        .select()
        .from(s.secrets)
        .where(eq(s.secrets.id, secretId(ownerKey(principal, key), key)));
      return rows[0] ? rowToRecord(rows[0]) : null;
    },

    async delete(principal, key) {
      await db
        .delete(s.secrets)
        .where(eq(s.secrets.id, secretId(ownerKey(principal, key), key)));
    },

    async list(principal) {
      const rows = await db
        .select({ key: s.secrets.key })
        .from(s.secrets)
        .where(eq(s.secrets.owner, ownerKey(principal)));
      return rows.map((r: any) => r.key);
    },

    ownerKeyOf: (principal, key) => ownerKey(principal, key),

    async scan({ after, limit }) {
      const rows = await db
        .select()
        .from(s.secrets)
        .where(after === undefined ? undefined : gt(s.secrets.id, after))
        .orderBy(asc(s.secrets.id))
        .limit(limit);
      const records = rows.map((r: any) => ({ ...rowToRecord(r), owner: r.owner as string }));
      return { records, next: rows.length === limit ? rows[rows.length - 1].id : undefined };
    },

    async replaceWrap(owner, key, wrap, expectedWrappedDek) {
      const updated = await db
        .update(s.secrets)
        .set({ wrappedDek: wrap.wrappedDek, dekIv: wrap.dekIv })
        .where(and(eq(s.secrets.id, secretId(owner, key)), eq(s.secrets.wrappedDek, expectedWrappedDek)))
        .returning({ id: s.secrets.id });
      return updated.length > 0;
    },

    async purgeOwner(segments, opts) {
      const limit = opts?.batchSize ?? 500;
      const secrets = await deleteBatch(db, s.secrets, s.secrets.id, underOwnerPath(s.secrets.owner, segments), limit);
      return { removed: { secrets }, done: secrets < limit };
    },
  };
}
