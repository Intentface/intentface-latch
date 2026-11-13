/** Something that runs parameterised SQL: a `pg` client or pool, PGlite, or a transaction of either. */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** The database the knowledge library writes to: queries, and transactions for multi-statement writes. */
export interface KnowledgeDb extends SqlClient {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/** Any object with PGlite's `query` and `transaction`, such as `new PGlite({ extensions: { pg_trgm } })`. */
export function fromPGlite(db: {
  query: SqlClient["query"];
  transaction<T>(fn: (tx: { query: SqlClient["query"] }) => Promise<T>): Promise<T>;
}): KnowledgeDb {
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: (fn) => db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  };
}

/** A `pg` `Pool` (node-postgres), or anything with its `query` and `connect`. */
export function fromPgPool(pool: {
  query: SqlClient["query"];
  connect(): Promise<{ query: SqlClient["query"]; release(): void }>;
}): KnowledgeDb {
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
