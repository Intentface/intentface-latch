import { encodeOwnerKey, type PurgeResult } from "@intentface/latch-core";
import type { KnowledgeDb, SqlClient } from "./db.js";
import { KnowledgeError } from "./errors.js";
import { frontmatterDescription } from "./frontmatter.js";
import { coversSql, globToRegExp, resolvePath, virtualPath } from "./paths.js";
import { migrate } from "./schema.js";

/** What a principal can reach: its grant subjects, and which space each mount shows. */
export interface KnowledgeAccess {
  /**
   * Who the caller is, as the subjects grants name: `"user:acme/u7"`,
   * `"org:acme"`, `"group:staff"`. `"everyone"` is added for you.
   */
  subjects: string[];
  /**
   * Mount name → space id: `{ practices: "practices", org: "org:acme", me: "user:acme/u7" }`
   * shows `/practices`, `/org` and `/me`. A space that isn't mounted can't be
   * reached by any path.
   */
  mounts: Record<string, string>;
}

export interface KnowledgeConfig<P> {
  db: KnowledgeDb;
  /** Resolves a principal's subjects and mounts. Runs once per view, so on every turn. */
  access: (principal: P) => KnowledgeAccess | Promise<KnowledgeAccess>;
  /**
   * Subjects whose writes are trusted: your staff, your curator agents. A file
   * is trusted when one of these wrote it, and no one outside them can change
   * it now. Replacing a file sets its trust from the writer; an edit can only
   * lower it, since the rest of the text is still the earlier writer's.
   */
  trustedSubjects?: string[];
  /** Who a principal's writes are recorded as. Default: its first subject. */
  actor?: (principal: P) => string;
}

export type SpaceKind = "shared" | "org" | "user";
export type Role = "viewer" | "editor";

/** One entry of a listing. Folders are implied by the files under them. */
export interface KnowledgeEntry {
  path: string;
  type: "folder" | "file";
  /** Bytes, for files. */
  size?: number;
  version?: number;
  /** `true` when no one outside the trusted subjects can write it. For a skill folder, its `SKILL.md`'s. */
  trusted?: boolean;
  /** A skill folder's description, from its `SKILL.md` frontmatter. */
  description?: string;
}

export interface KnowledgeFile {
  path: string;
  version: number;
  trusted: boolean;
  /** The lines asked for, without line breaks. */
  lines: string[];
  /** The line number of `lines[0]`, counting from 1. */
  offset: number;
  totalLines: number;
  updatedAt: Date;
  updatedBy: string;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchHit {
  path: string;
  rank: number;
  snippet: string;
}

/** What one principal can do with the knowledge, every call checked against its grants. */
export interface KnowledgeView {
  /** The mounts, as `/name`, with the kind of space behind each. */
  mounts(): Promise<{ path: string; kind: SpaceKind }[]>;
  list(path: string, opts?: { depth?: number }): Promise<KnowledgeEntry[]>;
  read(path: string, opts?: { offset?: number; limit?: number }): Promise<KnowledgeFile>;
  /** Creates a document, or replaces one: replacing needs the `version` you read. */
  write(path: string, content: string, opts?: { version?: number; runId?: string }): Promise<{ path: string; version: number }>;
  /** Replaces `oldText`, which must occur exactly once, with `newText`. */
  edit(path: string, oldText: string, newText: string, opts?: { runId?: string }): Promise<{ path: string; version: number }>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, opts?: { path?: string; ignoreCase?: boolean; limit?: number }): Promise<GrepHit[]>;
  search(query: string, opts?: { path?: string; limit?: number }): Promise<SearchHit[]>;
  /** The kind of space behind a path's mount: tools refuse changes to `shared` ones. */
  kindOf(path: string): Promise<SpaceKind>;
}

export interface Knowledge<P> {
  /** Creates the tables if they're missing. */
  migrate(): Promise<void>;
  /** Creates a space, owned by an owner path in Latch's format (`["acme"]`, `["acme", "u7"]`). No-op if it exists. */
  createSpace(space: { id: string; owner: string[]; kind: SpaceKind; name?: string }): Promise<void>;
  /** Grants a role on a folder (`""` = the whole space) and everything under it. Returns the grant id. */
  grant(grant: {
    space: string;
    path?: string;
    subject: string;
    role: Role;
    grantedBy: string;
    expiresAt?: Date;
    reason?: string;
  }): Promise<string>;
  revoke(grantId: string): Promise<void>;
  /** The knowledge as this principal sees it. Resolve one per turn. */
  as(principal: P): KnowledgeView;
  /** Deletes every space under an owner path, with its files, versions and grants (`runtime.purgeOwner`'s `also`). */
  purgeOwner(segments: string[], opts?: { batchSize?: number }): Promise<PurgeResult>;
}

const MAX_FILE_BYTES = 1_000_000;
const utf8 = new TextEncoder();
const byteLength = (text: string) => utf8.encode(text).length;
const MAX_PATTERN = 300;
const MOUNT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

type FileRow = { space_id: string; path: string; size: number; version: number; trusted: boolean; head: string | null };

/**
 * Permissioned knowledge in your own Postgres. Spaces hold Markdown documents
 * by path; grants on folders decide who reads and writes; each principal sees
 * the spaces mounted for it, and nothing else.
 *
 * ```ts
 * const knowledge = createKnowledge<Principal>({
 *   db: fromPgPool(pool),
 *   access: (p) => ({
 *     subjects: [`user:${p.orgId}/${p.userId}`, `org:${p.orgId}`, ...(p.staff ? ["group:staff"] : [])],
 *     mounts: { practices: "practices", org: `org:${p.orgId}`, me: `user:${p.orgId}/${p.userId}` },
 *   }),
 *   trustedSubjects: ["group:staff"],
 * });
 * ```
 */
export function createKnowledge<P>(config: KnowledgeConfig<P>): Knowledge<P> {
  const { db } = config;
  const trustedSubjects = config.trustedSubjects ?? [];

  return {
    migrate: () => migrate(db),

    async createSpace({ id, owner, kind, name }) {
      await db.query(
        `insert into kb_spaces (id, owner, kind, name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
        [id, encodeOwnerKey(owner), kind, name ?? id],
      );
    },

    async grant({ space, path = "", subject, role, grantedBy, expiresAt, reason }) {
      const clean = path === "" ? "" : resolvePath(`/x/${path}`).rel;
      const { rows } = await db.query<{ id: string }>(
        `insert into kb_grants (space_id, path, subject, role, granted_by, expires_at, reason)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [space, clean, subject, role, grantedBy, expiresAt ?? null, reason ?? null],
      );
      return rows[0]!.id;
    },

    async revoke(grantId) {
      await db.query(`delete from kb_grants where id = $1`, [grantId]);
    },

    as(principal) {
      return createView(principal);
    },

    async purgeOwner(segments, opts) {
      const key = encodeOwnerKey(segments);
      const limit = opts?.batchSize ?? 100;
      const { rows } = await db.query<{ id: string }>(
        `select id from kb_spaces where owner = $1 or starts_with(owner, $1 || '/') order by id limit $2`,
        [key, limit],
      );
      if (!rows.length) return { removed: { spaces: 0, files: 0 }, done: true };
      const ids = rows.map((r) => r.id);
      const { rows: files } = await db.query<{ n: string }>(`select count(*)::text as n from kb_files where space_id = any($1)`, [ids]);
      await db.query(`delete from kb_spaces where id = any($1)`, [ids]);
      return { removed: { spaces: ids.length, files: Number(files[0]?.n ?? 0) }, done: rows.length < limit };
    },
  };

  function createView(principal: P): KnowledgeView {
    let resolved: Promise<{ subjects: string[]; mounts: Map<string, string>; kinds: Map<string, SpaceKind>; actor: string; trustedWriter: boolean }> | undefined;
    const state = () =>
      (resolved ??= (async () => {
        const access = await config.access(principal);
        const mounts = new Map<string, string>();
        for (const [name, space] of Object.entries(access.mounts)) {
          if (!MOUNT_NAME.test(name)) throw new KnowledgeError("invalid", `Mount names are lowercase letters, digits, _ and -: "${name}"`);
          mounts.set(name, space);
        }
        const subjects = [...new Set(["everyone", ...access.subjects])];
        const { rows } = await db.query<{ id: string; kind: SpaceKind }>(`select id, kind from kb_spaces where id = any($1)`, [[...mounts.values()]]);
        const kinds = new Map(rows.map((r) => [r.id, r.kind]));
        const trustedWriter = access.subjects.some((x) => trustedSubjects.includes(x));
        return { subjects, mounts, kinds, actor: config.actor?.(principal) ?? access.subjects[0] ?? "unknown", trustedWriter };
      })());

    /** The space behind a mount, or not_found (a mount the caller doesn't have looks like a missing path). */
    async function spaceOf(mount: string, input: string) {
      const s = await state();
      const space = s.mounts.get(mount);
      if (!space || !s.kinds.has(space)) throw new KnowledgeError("not_found", `No such path: ${input}`);
      return { space, s };
    }

    /** The CTE of the caller's live grants in the given spaces: `$1` = space ids, `$2` = subjects. */
    const grantsCte = `g as (
      select space_id, path, role from kb_grants
      where space_id = any($1) and subject = any($2) and (expires_at is null or expires_at > now())
    )`;
    const readable = (f: string) => `exists (select 1 from g where g.space_id = ${f}.space_id and ${coversSql("g.path", `${f}.path`)})`;
    /** `$3` = trusted subjects. */
    const trusted = (f: string) => `${f}.trusted_author and not exists (
      select 1 from kb_grants e
      where e.space_id = ${f}.space_id and e.role = 'editor' and (e.expires_at is null or e.expires_at > now())
        and ${coversSql("e.path", `${f}.path`)} and not (e.subject = any($3))
    )`;

    /** Files the caller can read in one space, under a folder. */
    async function filesUnder(space: string, rel: string, subjects: string[], withHead: boolean): Promise<FileRow[]> {
      const { rows } = await db.query<FileRow>(
        `with ${grantsCte}
         select f.space_id, f.path, f.size, f.version, ${trusted("f")} as trusted,
                ${withHead ? `case when f.path like '%SKILL.md' then left(f.body, 2000) end` : "null"} as head
         from kb_files f
         where f.space_id = any($1) and ${coversSql("$4", "f.path")} and ${readable("f")}
         order by f.path limit 5000`,
        [[space], subjects, trustedSubjects, rel],
      );
      return rows;
    }

    async function canEdit(tx: SqlClient, space: string, rel: string, subjects: string[]) {
      const { rows } = await tx.query(
        `with ${grantsCte} select 1 from g where g.role = 'editor' and ${coversSql("g.path", "$3")} limit 1`,
        [[space], subjects, rel],
      );
      return rows.length > 0;
    }

    /** Mounts a search covers: the one a path names, or all of them. */
    async function scope(path: string | undefined) {
      const s = await state();
      if (!path || path === "/") return { s, targets: [...s.mounts].filter(([, sp]) => s.kinds.has(sp)).map(([mount, space]) => ({ mount, space, rel: "" })) };
      const { mount, rel } = resolvePath(path);
      const { space } = await spaceOf(mount, path);
      return { s, targets: [{ mount, space, rel }] };
    }

    const mountOfSpace = (s: Awaited<ReturnType<typeof state>>, space: string) =>
      [...s.mounts].find(([, sp]) => sp === space)?.[0] ?? space;

    async function writeChecks(tx: SqlClient, input: string) {
      const { mount, rel } = resolvePath(input);
      if (!rel) throw new KnowledgeError("invalid", `Name a file inside the mount: ${input}`);
      const { space, s } = await spaceOf(mount, input);
      if (!(await canEdit(tx, space, rel, s.subjects))) {
        throw new KnowledgeError("forbidden", `You can read ${virtualPath(mount, rel.split("/")[0]!)} but not change it`);
      }
      return { space, rel, s };
    }

    async function saveVersion(tx: SqlClient, fileId: string, version: number, body: string, author: string, runId?: string) {
      await tx.query(`insert into kb_versions (file_id, version, body, author, run_id) values ($1, $2, $3, $4, $5)`, [
        fileId,
        version,
        body,
        author,
        runId ?? null,
      ]);
    }

    const view: KnowledgeView = {
      async mounts() {
        const s = await state();
        return [...s.mounts].filter(([, sp]) => s.kinds.has(sp)).map(([mount, space]) => ({ path: `/${mount}`, kind: s.kinds.get(space)! }));
      },

      async list(input, opts) {
        const depth = Math.max(1, Math.min(opts?.depth ?? 1, 10));
        const { mount, rel } = resolvePath(input);
        if (!mount) {
          const ms = await view.mounts();
          return ms.map((m) => ({ path: m.path, type: "folder" as const }));
        }
        const { space, s } = await spaceOf(mount, input);
        const rows = await filesUnder(space, rel, s.subjects, true);
        const exact = rows.find((r) => r.path === rel);
        if (exact) return [{ path: virtualPath(mount, rel), type: "file", size: exact.size, version: exact.version, trusted: exact.trusted }];
        if (!rows.length && rel) throw new KnowledgeError("not_found", `No such path: ${input}`);

        const entries = new Map<string, KnowledgeEntry>();
        const base = rel ? `${rel}/` : "";
        for (const r of rows) {
          const parts = r.path.slice(base.length).split("/");
          for (let d = 1; d <= Math.min(depth, parts.length); d++) {
            const sub = base + parts.slice(0, d).join("/");
            const isFile = d === parts.length;
            const vp = virtualPath(mount, sub);
            if (isFile) entries.set(vp, { path: vp, type: "file", size: r.size, version: r.version, trusted: r.trusted });
            else if (!entries.has(vp)) entries.set(vp, { path: vp, type: "folder" });
          }
          // A skill folder carries its SKILL.md's description and trust.
          if (r.path.endsWith("/SKILL.md")) {
            const folder = entries.get(virtualPath(mount, r.path.slice(0, -"/SKILL.md".length)));
            if (folder?.type === "folder") {
              folder.trusted = r.trusted;
              const description = r.head ? frontmatterDescription(r.head) : undefined;
              if (description) folder.description = description;
            }
          }
        }
        return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
      },

      async read(input, opts) {
        const { mount, rel } = resolvePath(input);
        if (!rel) throw new KnowledgeError("invalid", `${input} is a folder: list it instead`);
        const { space, s } = await spaceOf(mount, input);
        const { rows } = await db.query<{ body: string; version: number; trusted: boolean; updated_at: Date; updated_by: string }>(
          `with ${grantsCte}
           select f.body, f.version, ${trusted("f")} as trusted, f.updated_at, f.updated_by
           from kb_files f where f.space_id = any($1) and f.path = $4 and ${readable("f")}`,
          [[space], s.subjects, trustedSubjects, rel],
        );
        const row = rows[0];
        if (!row) {
          const under = await filesUnder(space, rel, s.subjects, false);
          throw new KnowledgeError(under.length ? "invalid" : "not_found", under.length ? `${input} is a folder: list it instead` : `No such file: ${input}`);
        }
        const all = row.body.split("\n");
        const offset = Math.max(1, opts?.offset ?? 1);
        const limit = Math.max(1, Math.min(opts?.limit ?? 2000, 5000));
        return {
          path: virtualPath(mount, rel),
          version: row.version,
          trusted: row.trusted,
          lines: all.slice(offset - 1, offset - 1 + limit),
          offset,
          totalLines: all.length,
          updatedAt: new Date(row.updated_at),
          updatedBy: row.updated_by,
        };
      },

      async write(input, content, opts) {
        if (byteLength(content) > MAX_FILE_BYTES) throw new KnowledgeError("invalid", `Documents are limited to ${MAX_FILE_BYTES} bytes`);
        // Resolve access outside the transaction: on a single-connection
        // database (PGlite) a query on `db` inside it would wait forever.
        await state();
        return db.transaction(async (tx) => {
          const { space, rel, s } = await writeChecks(tx, input);
          const { mount } = resolvePath(input);
          // A file can't sit where a folder is, or under a file.
          const prefixes = rel.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"));
          const { rows: clash } = await tx.query(
            `select path from kb_files where space_id = $1 and (path = any($2) or starts_with(path, $3 || '/')) limit 1`,
            [space, prefixes, rel],
          );
          if (clash.length) throw new KnowledgeError("conflict", `${input} would clash with ${virtualPath(mount, String((clash[0] as { path: string }).path))}`);
          const { rows } = await tx.query<{ id: string; version: number }>(
            `select id, version from kb_files where space_id = $1 and path = $2 for update`,
            [space, rel],
          );
          const existing = rows[0];
          if (existing) {
            if (opts?.version === undefined) throw new KnowledgeError("conflict", `${input} exists: read it, then pass its version to replace it`);
            if (opts.version !== existing.version) throw new KnowledgeError("conflict", `${input} changed since version ${opts.version}: it's at ${existing.version} now`);
            const version = existing.version + 1;
            await tx.query(
              `update kb_files set body = $1, size = $2, version = $3, updated_at = now(), updated_by = $4, trusted_author = $6 where id = $5`,
              [content, byteLength(content), version, s.actor, existing.id, s.trustedWriter],
            );
            await saveVersion(tx, existing.id, version, content, s.actor, opts.runId);
            return { path: virtualPath(mount, rel), version };
          }
          // Two runs creating the same path at once: the second finds no row to
          // lock, and its insert waits on the first's, then does nothing.
          const { rows: created } = await tx.query<{ id: string }>(
            `insert into kb_files (space_id, path, version, body, size, updated_by, trusted_author) values ($1, $2, 1, $3, $4, $5, $6)
             on conflict (space_id, path) do nothing returning id`,
            [space, rel, content, byteLength(content), s.actor, s.trustedWriter],
          );
          if (!created[0]) throw new KnowledgeError("conflict", `${input} was just created by someone else: read it, then pass its version to replace it`);
          await saveVersion(tx, created[0]!.id, 1, content, s.actor, opts?.runId);
          return { path: virtualPath(mount, rel), version: 1 };
        });
      },

      async edit(input, oldText, newText, opts) {
        if (!oldText) throw new KnowledgeError("invalid", "old_text can't be empty");
        await state();
        return db.transaction(async (tx) => {
          const { space, rel, s } = await writeChecks(tx, input);
          const { rows } = await tx.query<{ id: string; version: number; body: string }>(
            `select id, version, body from kb_files where space_id = $1 and path = $2 for update`,
            [space, rel],
          );
          const file = rows[0];
          if (!file) throw new KnowledgeError("not_found", `No such file: ${input}`);
          const at = file.body.indexOf(oldText);
          if (at === -1) throw new KnowledgeError("conflict", `The text to replace isn't in ${input} (it may have changed): read it again`);
          if (file.body.indexOf(oldText, at + 1) !== -1) throw new KnowledgeError("conflict", `The text to replace occurs more than once in ${input}: include more of it`);
          const body = file.body.slice(0, at) + newText + file.body.slice(at + oldText.length);
          if (byteLength(body) > MAX_FILE_BYTES) throw new KnowledgeError("invalid", `Documents are limited to ${MAX_FILE_BYTES} bytes`);
          const version = file.version + 1;
          await tx.query(
            `update kb_files set body = $1, size = $2, version = $3, updated_at = now(), updated_by = $4, trusted_author = trusted_author and $6 where id = $5`,
            [body, byteLength(body), version, s.actor, file.id, s.trustedWriter],
          );
          await saveVersion(tx, file.id, version, body, s.actor, opts?.runId);
          return { path: virtualPath(resolvePath(input).mount, rel), version };
        });
      },

      async glob(pattern) {
        const re = globToRegExp(pattern.startsWith("/") ? pattern : `/${pattern}`);
        const first = resolvePath(pattern.startsWith("/") ? pattern : `/${pattern}`).mount;
        const { s, targets } = await scope(first && !/[*?]/.test(first) ? `/${first}` : undefined);
        const out: string[] = [];
        for (const t of targets) {
          for (const r of await filesUnder(t.space, "", s.subjects, false)) {
            const vp = virtualPath(t.mount, r.path);
            if (re.test(vp)) out.push(vp);
          }
        }
        return out.sort().slice(0, 500);
      },

      async grep(pattern, opts) {
        if (!pattern || pattern.length > MAX_PATTERN) throw new KnowledgeError("invalid", `Patterns are 1 to ${MAX_PATTERN} characters`);
        const limit = Math.max(1, Math.min(opts?.limit ?? 200, 500));
        const op = opts?.ignoreCase ? "~*" : "~";
        const { s, targets } = await scope(opts?.path);
        const hits: GrepHit[] = [];
        for (const t of targets) {
          if (hits.length >= limit) break;
          const rows = await db
            .transaction(async (tx) => {
              await tx.query(`set local statement_timeout = 2000`);
              const { rows } = await tx.query<{ path: string; line: string; text: string }>(
                `with ${grantsCte},
                 docs as (
                   select f.path, f.body from kb_files f
                   where f.space_id = any($1) and ${coversSql("$3", "f.path")} and ${readable("f")} and f.body ${op} $4
                 )
                 select d.path, l.n::text as line, l.text
                 from docs d, regexp_split_to_table(d.body, E'\\n') with ordinality as l(text, n)
                 where l.text ${op} $4
                 order by d.path, l.n limit $5`,
                [[t.space], s.subjects, t.rel, pattern, limit - hits.length],
              );
              return rows;
            })
            .catch((e: unknown) => {
              const message = e instanceof Error ? e.message : String(e);
              if (/regular expression/i.test(message)) throw new KnowledgeError("invalid", `Not a valid POSIX regular expression: ${message}`);
              if (/statement timeout|canceling statement/i.test(message)) throw new KnowledgeError("invalid", "The pattern took too long: make it more specific");
              throw e;
            });
          for (const r of rows) hits.push({ path: virtualPath(t.mount, r.path), line: Number(r.line), text: r.text });
        }
        return hits;
      },

      async search(query, opts) {
        const limit = Math.max(1, Math.min(opts?.limit ?? 20, 100));
        const { s, targets } = await scope(opts?.path);
        const hits: SearchHit[] = [];
        for (const t of targets) {
          const { rows } = await db.query<{ space_id: string; path: string; rank: number; snippet: string }>(
            `with ${grantsCte}
             select f.space_id, f.path, ts_rank(to_tsvector('simple', f.body), q) as rank,
                    ts_headline('simple', f.body, q, 'MaxFragments=1, MaxWords=30, MinWords=12, StartSel=**, StopSel=**') as snippet
             from kb_files f, websearch_to_tsquery('simple', $4) q
             where f.space_id = any($1) and ${coversSql("$3", "f.path")} and ${readable("f")}
               and to_tsvector('simple', f.body) @@ q
             order by rank desc limit $5`,
            [[t.space], s.subjects, t.rel, query, limit],
          );
          for (const r of rows) hits.push({ path: virtualPath(mountOfSpace(s, r.space_id), r.path), rank: Number(r.rank), snippet: r.snippet });
        }
        return hits.sort((a, b) => b.rank - a.rank).slice(0, limit);
      },

      async kindOf(input) {
        const { mount } = resolvePath(input);
        const { space, s } = await spaceOf(mount, input);
        return s.kinds.get(space)!;
      },
    };
    return view;
  }
}
