/**
 * Sealing: the code path that executes searches receives ONLY the query text.
 *
 * `toPublicQuery` projects a qrel by EXPLICIT field enumeration — never a
 * spread, never a delete — so gold labels (`relevant`, `first_relevant`,
 * grades, tier) physically cannot reach the search implementation.
 * `seal.test.ts` asserts the projection strips everything but id + text.
 */

export interface PublicQuery {
  id: string;
  text: string;
}

export function toPublicQuery(qrel: { id: string; query: string }): PublicQuery {
  return { id: qrel.id, text: qrel.query };
}
