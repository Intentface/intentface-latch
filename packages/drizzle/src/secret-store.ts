import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq, isNull } from "drizzle-orm";
import type { Scope, SecretRecord, SecretStore } from "@intentface/latch-core";
import * as schema from "./schema.js";

/** Stable composite id; userId omitted → org-level secret (empty segment). */
const secretId = (orgId: string, userId: string | null | undefined, key: string) =>
  `${orgId}:${userId ?? ""}:${key}`;

/**
 * A `SecretStore` on libsql — persists the Vault's opaque encrypted records.
 * It never sees plaintext; encryption/decryption happens in `createVault`.
 */
export function createSqliteSecretStore(client: Client): SecretStore {
  const db = drizzle(client, { schema });

  const rowToRecord = (r: typeof schema.secrets.$inferSelect): SecretRecord => ({
    orgId: r.orgId,
    userId: r.userId,
    key: r.key,
    ciphertext: r.ciphertext,
    iv: r.iv,
    wrappedDek: r.wrappedDek,
    dekIv: r.dekIv,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  return {
    async put(r) {
      await db
        .insert(schema.secrets)
        .values({
          id: secretId(r.orgId, r.userId, r.key),
          orgId: r.orgId,
          userId: r.userId ?? null,
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

    async get(scope: Scope, key) {
      const rows = await db
        .select()
        .from(schema.secrets)
        .where(eq(schema.secrets.id, secretId(scope.orgId, scope.userId, key)));
      return rows[0] ? rowToRecord(rows[0]) : null;
    },

    async delete(scope: Scope, key) {
      await db
        .delete(schema.secrets)
        .where(eq(schema.secrets.id, secretId(scope.orgId, scope.userId, key)));
    },

    async list(scope: Scope) {
      const rows = await db
        .select({ key: schema.secrets.key })
        .from(schema.secrets)
        .where(
          and(
            eq(schema.secrets.orgId, scope.orgId),
            scope.userId
              ? eq(schema.secrets.userId, scope.userId)
              : isNull(schema.secrets.userId),
          ),
        );
      return rows.map((r) => r.key);
    },
  };
}
