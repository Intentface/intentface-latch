import { eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { SecretRecord, SecretStore } from "@intentface/latch-core";
import * as schema from "./schema.pg.js";
import type { SqliteSecretStoreOptions } from "./secret-store.js";

/** Join an `owner` path into one composite key, segment-encoded so it's unambiguous. */
function ownerKeyOf<P>(
  owner: (p: P, key?: string) => string[],
  principal: P,
  key?: string,
): string {
  return owner(principal, key).map(encodeURIComponent).join("/");
}

const secretId = (ownerKey: string, key: string) => `${ownerKey}:${key}`;

/** A `SecretStore` on Postgres — same contract + logic as the SQLite store. */
export function createPostgresSecretStore<P>(
  db: PgDatabase<any, any, any>,
  opts: SqliteSecretStoreOptions<P>,
): SecretStore<P> {
  const ownerKey = (p: P, key?: string) => ownerKeyOf(opts.owner, p, key);

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
      const owner = ownerKey(principal, r.key);
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
        .where(eq(schema.secrets.id, secretId(ownerKey(principal, key), key)));
      return rows[0] ? rowToRecord(rows[0]) : null;
    },

    async delete(principal, key) {
      await db
        .delete(schema.secrets)
        .where(eq(schema.secrets.id, secretId(ownerKey(principal, key), key)));
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
