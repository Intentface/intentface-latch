import { createHash } from "node:crypto";

/**
 * Who produced a run, as the observability feed presents it. One per distinct
 * owner tag in the window.
 */
export interface Runner {
  /**
   * Opaque handle the client filters by. The owner tag itself when identified,
   * the pseudonym when anonymized — so an anonymized feed never ships a real
   * user id to the browser, and the filter still round-trips.
   */
  key: string;
  /** "You", the user's name/email, or a stable pseudonym. */
  label: string;
  isSelf: boolean;
}

/** Profile fields the label is built from. */
export interface UserProfile {
  name?: string;
  email?: string;
}

/**
 * The user id inside an owner tag (`ownerTagOf`: `orgId` or `orgId/userId`, each
 * segment URL-encoded). Absent for an org-only tag — a run with no acting user,
 * e.g. a cron/system turn.
 */
export function userIdFromOwnerTag(tag: string): string | undefined {
  const segments = tag.split("/");
  if (segments.length < 2) return undefined;
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    // A malformed percent-escape shouldn't sink the whole feed.
    return last;
  }
}

/**
 * A short, stable label for an owner tag that names nobody. Deterministic, so the
 * same colleague reads as the same pseudonym across polls and page loads.
 *
 * NOT a privacy boundary: the reader is already authorized to see these runs, and
 * the digest is over a low-entropy input, so anyone holding the candidate user ids
 * could re-identify it. It exists to let you review a colleague's runs without
 * knowing whose they are — deliberately reversible by the server, never shipped
 * alongside the identity.
 */
export function pseudonymFor(tag: string): string {
  // 6 hex digits (~16.7M): wide enough that two colleagues sharing a label — which
  // would silently merge them in the feed and its filter — stays negligible.
  return `User ${createHash("sha256").update(tag).digest("hex").slice(0, 6)}`;
}

/**
 * Build the display identity for each owner tag in the feed.
 *
 * `anonymous` short-circuits the profile lookup entirely — no names or emails are
 * read, let alone returned — so the toggle is enforced server-side rather than by
 * the client choosing not to render what it was sent.
 */
export async function resolveRunners(args: {
  /** Distinct owner tags appearing in the window. */
  tags: string[];
  /** The reader's own owner tag, labelled "You". */
  selfTag: string;
  anonymous: boolean;
  /** Batch profile lookup, injected by the composition root. */
  lookup: (userIds: string[]) => Promise<Map<string, UserProfile>>;
}): Promise<Map<string, Runner>> {
  const tags = [...new Set(args.tags.filter((t) => t.length > 0))];
  const out = new Map<string, Runner>();

  if (args.anonymous) {
    for (const tag of tags) {
      const isSelf = tag === args.selfTag;
      // Pseudonymous keys throughout, including one's own row: the contract is
      // that an anonymized response carries no owner tag at all.
      out.set(tag, {
        key: pseudonymFor(tag),
        label: isSelf ? "You" : pseudonymFor(tag),
        isSelf,
      });
    }
    return out;
  }

  const byTag = new Map<string, string>();
  for (const tag of tags) {
    const userId = userIdFromOwnerTag(tag);
    if (userId) byTag.set(tag, userId);
  }
  // One query for the whole window; a failed lookup degrades to the pseudonym
  // rather than emptying the feed.
  let profiles = new Map<string, UserProfile>();
  if (byTag.size > 0) {
    try {
      profiles = await args.lookup([...new Set(byTag.values())]);
    } catch (e) {
      console.warn("runner profile lookup failed:", e);
    }
  }

  for (const tag of tags) {
    const isSelf = tag === args.selfTag;
    const userId = byTag.get(tag);
    const profile = userId ? profiles.get(userId) : undefined;
    const label = isSelf
      ? "You"
      : (profile?.name?.trim() || profile?.email?.trim() || pseudonymFor(tag));
    out.set(tag, { key: tag, label, isSelf });
  }
  return out;
}
