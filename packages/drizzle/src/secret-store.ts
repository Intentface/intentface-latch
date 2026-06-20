import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import type { SecretRecord, SecretStore } from "@intentface/latch-core";
import * as schema from "./schema.js";

/** Join an `owner` path into one composite key, segment-encoded so it's unambiguous. */
function ownerKeyOf<P>(owner: (p: P) => string[], principal: P): string {
  return owner(principal).map(encodeURIComponent).join("/");
}

/** Stable composite id from the ownership key + secret key. */
const secretId = (ownerKey: string, key: string) => `${ownerKey}:${key}`;

export interface SqliteSecretStoreOptions<P> {
  /**
   * Derive the ownership key for a principal — credential isolation boundary.
   * Can differ from the storage adapter's `owner` (e.g. credentials shared at the
   * tenant level while chats are per-user). Server-derived only.
   */
  owner: (principal: P) => string[];
}

/**
 * A `SecretStore` on libsql — persists the Vault's opaque encrypted records.
 * It never sees plaintext; encryption/decryption happens in `createVault`.
 */
export function createSqliteSecretStore<P>(
  client: Client,
  opts: SqliteSecretStoreOptions<P>,
): SecretStore<P> {
  const db = drizzle(client, { schema });
  const ownerKey = (p: P) => ownerKeyOf(opts.owner, p);

  const rowToRecord = (r: typeof schema.secrets.$inferSelect): SecretRecord => ({
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
      const owner = ownerKey(principal);
      await db
        .insert(schema.secrets)
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
          target: schema.secrets.id,
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
        .from(schema.secrets)
        .where(eq(schema.secrets.id, secretId(ownerKey(principal), key)));
      return rows[0] ? rowToRecord(rows[0]) : null;
    },

    async delete(principal, key) {
      await db
        .delete(schema.secrets)
        .where(eq(schema.secrets.id, secretId(ownerKey(principal), key)));
    },

    async list(principal) {
      const rows = await db
        .select({ key: schema.secrets.key })
        .from(schema.secrets)
        .where(eq(schema.secrets.owner, ownerKey(principal)));
      return rows.map((r) => r.key);
    },
  };
}
