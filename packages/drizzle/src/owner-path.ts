import { inArray, sql, type SQL } from "drizzle-orm";
import { encodeOwnerKey } from "@intentface/latch-core";

/**
 * Whether an owner-key column falls under an owner path: it is the path's key,
 * or starts with it plus `/` (see `isUnderOwner`). A plain prefix comparison
 * with `substr`, which SQLite and Postgres share; never `LIKE`, because encoded
 * keys contain `%` and `_`, which `LIKE` reads as wildcards.
 */
export function underOwnerPath(column: unknown, segments: string[]): SQL {
  const key = encodeOwnerKey(segments);
  const prefix = `${key}/`;
  return sql`(${column} = ${key} or substr(${column}, 1, ${prefix.length}) = ${prefix})`;
}

/**
 * Delete up to `limit` rows of `table` matching `where`, by their single-column
 * key `id`, and say how many went. A purge pass is a series of these.
 */
export async function deleteBatch(db: any, table: any, id: any, where: SQL, limit: number): Promise<number> {
  const rows: any[] = await db.select({ id }).from(table).where(where).limit(limit);
  if (rows.length === 0) return 0;
  await db.delete(table).where(inArray(id, rows.map((r) => r.id)));
  return rows.length;
}
