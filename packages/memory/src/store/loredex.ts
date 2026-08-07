import type { ConnectionRegistry } from "@intentface/latch-core";
import type { EpisodeMeta, MemorySearchHit, MemoryStore, ScopeRef } from "../types.js";
import { MemoryStoreUnreachableError } from "../types.js";
import { isUnderScopeRoot, LOREDEX_PRIVATE_ROOT } from "../scope.js";
import {
  IndexValidationError,
  MEMORY_INDEX_FILENAME,
  memoryIdsIn,
  validateIndexRewrite,
} from "../index-file.js";

/**
 * MemoryStore over a Loredex MCP connection.
 *
 * Every operation opens the connection fresh (`hostFor([conn]).open(principal)`),
 * calls the namespaced tools programmatically, and closes — the same pattern
 * platform read-tools use. It deliberately does NOT share the agent turn's
 * opened connection set: that would couple the store to the turn lifecycle for
 * one saved round-trip.
 *
 * Loredex tool shapes this store relies on (verified against the live server;
 * override names via `toolNames` if a workspace exposes variants):
 * - `read_file { fileId }` — path-addressable reads.
 * - `create { type, name, folderId?, parentId?, content?, summary? }` — files
 *   and folders; there is no overwrite. Folder creates are NOT idempotent:
 *   a repeat call with the same name+parent inserts a DUPLICATE sibling rather
 *   than erroring, so `ensureFolders` probes before it creates. For `.md`,
 *   `summary` is injected as YAML frontmatter into the stored file — so the
 *   bytes on disk are never quite the `content` we handed over.
 * - `edit_file { fileId, replacements: [{ oldContent, newContent }] }` —
 *   search-and-replace only; a full rewrite replaces the whole previous text.
 *   For `.md` it splits frontmatter off and matches the BODY ALONE, so
 *   `oldContent` must never include the frontmatter (see `splitFrontmatter`).
 * - `search { query, folderId?, limit?, mode? }` — BM25, folder-scopable.
 *
 * There is no delete/move tool, so nothing here ever destroys content: index
 * rewrites snapshot the previous version into `archive/index-snapshots/`.
 */

export interface LoredexToolNames {
  read: string;
  create: string;
  edit: string;
  search: string;
}

const DEFAULT_TOOL_NAMES: LoredexToolNames = {
  read: "read_file",
  create: "create",
  edit: "edit_file",
  search: "search",
};

/**
 * Loredex auto-creates this file inside every folder it makes, so reading it is
 * how `ensureFolders` asks "does this folder exist?" without a folder-stat tool.
 */
const FOLDER_INDEX_FILENAME = "index.md";

type ToolCall = (tool: string, input: unknown) => Promise<CallResult>;
type CallResult =
  | { ok: true; text: string }
  | { ok: false; error: string }
  | { ok: false; unavailable: true; error: string };

/** Flatten an MCP CallToolResult (or any tool return) to text. */
function textOf(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const r = result as { content?: unknown };
  if (Array.isArray(r.content)) {
    return r.content
      .map((c) =>
        typeof c === "string" ? c : ((c as { text?: string }).text ?? ""),
      )
      .join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function isErrorResult(result: unknown): boolean {
  return !!(result as { isError?: boolean })?.isError;
}

/**
 * `read_file` output → the file's body.
 *
 * Loredex does NOT return the body: it returns a JSON envelope
 * (`{ file, content, totalLines, linksTo, … }`) whose `content` carries every
 * line prefixed with its number — server-side, literally
 * `lines.map((line, i) => \`${i + 1}|${line}\`).join("\n")`. Un-numbering is
 * therefore exact and round-trips to the stored bytes, which `writeIndex`
 * depends on: it hands the previous body straight back as `edit_file`'s
 * `oldContent`, and a JSON envelope matches nothing in the file.
 *
 * Tolerant on purpose: a non-JSON result, a shape without a string `content`,
 * or content that isn't line-numbered passes through untouched, so a plain-text
 * server (or the range form, which we never ask for) still reads sensibly.
 *
 * Caveat: for `.md` reads Loredex renders insight blocks and strips ai-block
 * config comments before numbering, so a body containing those markers decodes
 * to the RENDERED text, not the stored bytes. Memory files are consolidator-
 * authored and carry neither.
 */
function decodeFileRead(text: string): string {
  let content: unknown;
  try {
    content = (JSON.parse(text) as { content?: unknown }).content;
  } catch {
    return text;
  }
  if (typeof content !== "string") return text;
  if (content === "") return "";
  const lines = content.split("\n");
  // All lines or none: a partial match means this isn't a numbered body, and
  // stripping the prefixes that happen to be there would corrupt the rest.
  if (!lines.every((line) => /^\d+\|/.test(line))) return text;
  return lines.map((line) => line.replace(/^\d+\|/, "")).join("\n");
}

/**
 * Split a leading `---\n…\n---` frontmatter block off a file's text.
 *
 * Loredex OWNS that block on `.md` files, and both halves of the rewrite depend
 * on it: `create` injects the `summary` we pass into frontmatter, and `edit_file`
 * splits frontmatter off and runs replacements against the BODY ALONE. So the
 * index file we read back is `frontmatter + body` while the text `edit_file` can
 * actually match is `body` — handing the whole read back as `oldContent` matches
 * nothing, forever, from the second consolidation onward. The store therefore
 * owns the body and leaves the frontmatter to Loredex.
 *
 * Structural, exactly like the server's own `splitFrontmatter`: the block is
 * located by its `---` delimiters and never YAML-parsed, so a malformed-but-
 * delimited block is still recognized (and left alone) rather than leaking into
 * the body, where it would put bytes into `oldContent` that `edit_file` cannot
 * see.
 */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("---")) return { frontmatter: "", body: text };
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: "", body: text };
  const offset = text.length - trimmed.length;
  return {
    frontmatter: text.slice(0, offset + end + 4),
    body: text.slice(offset + end + 4).replace(/^\n/, ""),
  };
}

/**
 * Does this tool error definitively mean "the file isn't there"?
 *
 * Loredex answers an unresolvable read with `File not found: <ref>` on every
 * path (bad id, unresolvable path, missing row). Everything else — tool
 * unavailable, transport failure, an out-of-scope folder — leaves existence
 * UNKNOWN, and `ensureFolders` must not create on an unknown.
 */
function isDefinitelyMissing(error: string): boolean {
  return /not found/i.test(error);
}

export function createLoredexStore<P>(opts: {
  connections: ConnectionRegistry<P>;
  toolNames?: Partial<LoredexToolNames>;
}): MemoryStore<P> {
  const names = { ...DEFAULT_TOOL_NAMES, ...opts.toolNames };
  // Folder prefixes confirmed to exist this process lifetime (`<scope key>:<path>`),
  // so repeat writes skip the existence probe. Correctness never depends on it:
  // a cold cache (every serverless start) just re-probes.
  const ensuredFolders = new Set<string>();
  /**
   * Ensures currently in flight, keyed the same way. Without this, two
   * concurrent writes for one scope (a turn running `memory_write` and
   * `memory_index` in parallel) both probe a missing folder, both see it
   * absent, and both create it — the duplicate this store exists to avoid.
   *
   * In-process only. Two instances racing can still duplicate, which is why
   * the server-side idempotent create matters (Intentface/loredex#149).
   */
  const ensuringFolders = new Map<string, Promise<void>>();

  /** Open the scope's connection, run `fn` with a tool caller, always close. */
  async function withConnection<T>(
    principal: P,
    scope: ScopeRef,
    fn: (call: ToolCall) => Promise<T>,
  ): Promise<T | undefined> {
    let opened;
    try {
      opened = await opts.connections.hostFor([scope.connection]).open(principal);
    } catch {
      return undefined;
    }
    try {
      const call: ToolCall = async (tool, input) => {
        const t = opened.tools[`${scope.connection}_${tool}`] as
          | { execute?: (input: unknown, options: unknown) => Promise<unknown> }
          | undefined;
        if (!t || typeof t.execute !== "function") {
          return { ok: false, unavailable: true, error: `tool not available: ${tool}` };
        }
        try {
          const result = await t.execute(input, {
            toolCallId: `memory_${Math.random().toString(36).slice(2, 10)}`,
            messages: [],
          });
          const text = textOf(result);
          if (isErrorResult(result)) return { ok: false, error: text };
          return { ok: true, text };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      };
      return await fn(call);
    } finally {
      await opened.close().catch(() => {});
    }
  }

  /**
   * Create the folder chain for `path` (workspace-relative), skipping segments
   * that already exist.
   *
   * Loredex's folder `create` does NOT reject a duplicate name: it inserts a
   * second sibling with the same name, and path resolution then silently
   * resolves to whichever the traversal reaches first — so a blind re-create
   * leaves a trail of empty shadow folders (each with just its auto `index.md`)
   * that nothing can delete, since there is no delete tool. So probe first.
   *
   * The probe reads the segment's auto-created `index.md`: folders themselves
   * aren't addressable by `read_file`, but every Loredex folder has that file.
   *
   * Caching is per PREFIX, not per full path — `writeIndex` ensures `root`
   * while `writeEpisode` ensures `root/episodes`, so a whole-path key made the
   * second call re-walk (and, before the probe, re-create) every shared
   * ancestor.
   */
  async function ensureFolders(call: ToolCall, scopeKey: string, path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    // The caller's private root always exists (Loredex creates it on join)
    // and must never be created here — a `create` for that name would mint a
    // stray SHARED top-level folder shadowing it. Start below it; descendants
    // then inherit `private` visibility from it.
    const first = parts[0] === LOREDEX_PRIVATE_ROOT ? 1 : 0;
    for (let i = first; i < parts.length; i++) {
      const cacheKey = `${scopeKey}:${parts.slice(0, i + 1).join("/")}`;
      if (ensuredFolders.has(cacheKey)) continue;
      // Share an in-flight ensure rather than racing it. Deleted on settle so a
      // failed attempt is retried by the next write instead of being awaited
      // forever.
      let pending = ensuringFolders.get(cacheKey);
      if (!pending) {
        pending = ensureOneFolder(call, cacheKey, parts, i).finally(() => {
          ensuringFolders.delete(cacheKey);
        });
        ensuringFolders.set(cacheKey, pending);
      }
      await pending;
    }
  }

  /** One segment of `ensureFolders`: probe `parts[i]`, create it if truly absent. */
  async function ensureOneFolder(
    call: ToolCall,
    cacheKey: string,
    parts: string[],
    i: number,
  ): Promise<void> {
    const prefix = parts.slice(0, i + 1).join("/");
    const probe = await call(names.read, {
      fileId: `${prefix}/${FOLDER_INDEX_FILENAME}`,
    });
    if (probe.ok) {
      ensuredFolders.add(cacheKey);
      return;
    }
    // Only a definitive "not found" licenses a create. Any other failure —
    // tool unavailable, transport error, an out-of-scope folder — leaves
    // existence unknown, and creating on a guess is precisely how the shadow
    // folders appeared. Bail instead: the write that follows surfaces the real
    // error, and the next run re-probes. Guessing wrong here is unrecoverable
    // (no delete tool); guessing "exists" costs one retry.
    if (!isDefinitelyMissing(probe.error)) return;
    const parentId = parts.slice(0, i).join("/") || undefined;
    const created = await call(names.create, {
      type: "folder",
      name: parts[i],
      ...(parentId ? { parentId } : {}),
    });
    // Only remember what we know exists: a failed create must be retried on
    // the next write, not cached as done.
    if (created.ok) ensuredFolders.add(cacheKey);
  }

  function indexPath(scope: ScopeRef): string {
    return `${scope.root}/${MEMORY_INDEX_FILENAME}`;
  }

  /**
   * The index's BODY — Loredex's frontmatter stripped. That is the text every
   * consumer wants (entry lines, not a `summary:` block the provider would
   * otherwise inject into the agent's instructions), and it is the only text
   * `edit_file` can match.
   */
  async function readIndexWith(call: ToolCall, scope: ScopeRef): Promise<string | undefined> {
    const res = await call(names.read, { fileId: indexPath(scope) });
    if (!res.ok) return undefined;
    return splitFrontmatter(decodeFileRead(res.text)).body;
  }

  return {
    async available(principal, scope) {
      const probe = await withConnection(principal, scope, async (call) => {
        const res = await call(names.search, { query: "memory", folderId: scope.root, limit: 1 });
        return !("unavailable" in res && res.unavailable);
      });
      return probe ?? false;
    },

    async readIndex(principal, scope) {
      return withConnection(principal, scope, (call) => readIndexWith(call, scope));
    },

    async writeIndex(principal, scope, text) {
      // Unreachable store (open failed / tools absent) → MemoryStoreUnreachableError
      // ("retry later"); a rejected rewrite → IndexValidationError ("fix content").
      const fail = (what: string, res: { error: string } & Record<string, unknown>): never => {
        if (res.unavailable)
          throw new MemoryStoreUnreachableError(`memory store unreachable (${res.error})`);
        throw new Error(`${what}: ${res.error}`);
      };
      // What we write is the BODY. A consolidator that read the index saw the
      // frontmatter Loredex injected and routinely echoes it back at the top of
      // its rewrite; keeping it would both duplicate the block on disk and put
      // unmatchable bytes into `oldContent`.
      const body = splitFrontmatter(text).body;
      const result = await withConnection(principal, scope, async (call) => {
        const prev = await readIndexWith(call, scope);
        const problems = validateIndexRewrite(prev, body);
        if (problems.length > 0) throw new IndexValidationError(problems);
        if (prev !== undefined && prev.trim().length > 0) {
          // Snapshot BEFORE the rewrite; a failed snapshot aborts the write —
          // never rewrite history we couldn't preserve.
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const snapDir = `${scope.root}/archive/index-snapshots`;
          await ensureFolders(call, scope.key, snapDir);
          const snapshot = (name: string) =>
            call(names.create, {
              type: "file",
              name,
              folderId: snapDir,
              content: prev,
              summary: "Memory index snapshot (pre-consolidation)",
            });
          let snap = await snapshot(`MEMORY-${stamp}.md`);
          if (!snap.ok && /exist/i.test(snap.error)) {
            // Two rewrites inside the same millisecond collide on the name, and
            // an aborted write here means a consolidation that can never land.
            // Disambiguate once, as `writeEpisode` does.
            snap = await snapshot(`MEMORY-${stamp}-${Math.random().toString(36).slice(2, 6)}.md`);
          }
          if (!snap.ok) fail("memory index snapshot failed", snap);
          let edit = await call(names.edit, {
            fileId: indexPath(scope),
            replacements: [{ oldContent: prev, newContent: body }],
          });
          // A match failure means the file changed under us (a concurrent
          // consolidation, a human editing MEMORY.md in Loredex), which Loredex
          // answers with "re-read and try again". Do exactly that, once —
          // re-validating against the CURRENT entries, so an entry added
          // meanwhile can't be dropped either — and reuse the snapshot already
          // taken. One retry, not a loop: a second failure is a real conflict,
          // and each attempt would otherwise leave another undeletable snapshot.
          if (!edit.ok && !("unavailable" in edit)) {
            const fresh = await readIndexWith(call, scope);
            if (fresh !== undefined && fresh !== prev && fresh.trim().length > 0) {
              const freshProblems = validateIndexRewrite(fresh, body);
              if (freshProblems.length > 0) throw new IndexValidationError(freshProblems);
              edit = await call(names.edit, {
                fileId: indexPath(scope),
                replacements: [{ oldContent: fresh, newContent: body }],
              });
            }
          }
          if (!edit.ok) fail("memory index rewrite failed", edit);
        } else {
          // `prev === ""` (the file exists but its body is empty) lands here and
          // fails the create as "already exists" — deliberately loud: `edit_file`
          // rejects an empty `oldContent`, so there is nothing to replace and
          // guessing would mean clobbering a file we can't read.
          await ensureFolders(call, scope.key, scope.root);
          const created = await call(names.create, {
            type: "file",
            name: MEMORY_INDEX_FILENAME,
            folderId: scope.root,
            content: body,
            summary: "Compiled memory index (managed by the memory consolidator)",
          });
          if (!created.ok) fail("memory index create failed", created);
        }
        return true;
      });
      if (result === undefined)
        throw new MemoryStoreUnreachableError("memory store unreachable (connection failed)");
    },

    async writeEpisode(principal, scope, episode) {
      return withConnection(principal, scope, async (call) => {
        const dir = `${scope.root}/episodes`;
        await ensureFolders(call, scope.key, dir);
        // Chronologically sortable name — the filename IS the ordering key.
        const stamp = episode.meta.extractedAt.slice(0, 16).replace("T", "-").replace(":", "-");
        const slug =
          episode.slug
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .replace(/-{2,}/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48) || "note";
        const frontmatter = [
          "---",
          ...(episode.meta.chat ? [`chat: ${episode.meta.chat}`] : []),
          `agent: ${episode.meta.agent}`,
          `extracted_at: ${episode.meta.extractedAt}`,
          `provenance: ${episode.meta.provenance}`,
          ...(episode.meta.aliases?.length
            ? [`aliases: [${episode.meta.aliases.join(", ")}]`]
            : []),
          ...(episode.meta.status ? [`status: ${episode.meta.status}`] : []),
          "---",
        ].join("\n");
        const content = `${frontmatter}\n\n${episode.body.trim()}\n`;
        let name = `${stamp}-${slug}.md`;
        let created = await call(names.create, {
          type: "file",
          name,
          folderId: dir,
          content,
          summary: episode.summary,
        });
        if (!created.ok && /exist/i.test(created.error)) {
          // Same minute + same slug: disambiguate once rather than fail.
          name = `${stamp}-${slug}-${Math.random().toString(36).slice(2, 6)}.md`;
          created = await call(names.create, {
            type: "file",
            name,
            folderId: dir,
            content,
            summary: episode.summary,
          });
        }
        if (!created.ok) return undefined;
        return { path: `${dir}/${name}`, name };
      });
    },

    async readEpisodes(principal, scope, paths) {
      // Defense-in-depth: enforce the scope boundary here too, so a future
      // caller that forgets to pre-filter can't read outside the scope root.
      const safePaths = paths.filter((p) => isUnderScopeRoot(scope.root, p));
      const result = await withConnection(principal, scope, async (call) => {
        // Individual reads (not the batch form): per-file failures skip that
        // file instead of poisoning a combined result we'd have to re-split.
        const out: Array<{ path: string; text: string }> = [];
        for (const path of safePaths) {
          const res = await call(names.read, { fileId: path });
          if (res.ok) out.push({ path, text: decodeFileRead(res.text) });
        }
        return out;
      });
      return result ?? [];
    },

    async search(principal, scope, query, limit = 6) {
      const result = await withConnection(principal, scope, async (call) => {
        const res = await call(names.search, {
          query,
          folderId: scope.root,
          limit,
          mode: "text",
        });
        if (!res.ok) return [];
        return parseSearchHits(res.text, scope, limit);
      });
      return result ?? [];
    },
  };
}

/**
 * Loredex search output → hits. The result shape isn't pinned by the MCP
 * contract, so parse tolerantly: JSON with a results/hits array when present,
 * otherwise treat the whole text as one hit (still useful to the model; usage
 * tracking degrades to the `[m-…]` ids found in the text).
 */
function parseSearchHits(text: string, scope: ScopeRef, limit: number): MemorySearchHit[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : ((parsed as { results?: unknown[]; hits?: unknown[] }).results ??
        (parsed as { results?: unknown[]; hits?: unknown[] }).hits);
    if (Array.isArray(arr)) {
      return arr.slice(0, limit).map((raw) => {
        const r = raw as Record<string, unknown>;
        const str = (v: unknown): string | undefined =>
          typeof v === "string" && v.length > 0 ? v : undefined;
        // Loredex (live) returns `{ id: "file_…", title: "<filename>", snippet }`
        // with no path field. A title under the searched scope root is the best
        // file identity available without extra lookups; the opaque id still
        // resolves in read tools, so it is the next fallback — never the bare
        // scope root, which erases the hit's identity for every consumer
        // (ranking evals, episode detection, usage tracking).
        const path =
          str(r.path) ??
          str(r.file) ??
          str(r.fileId) ??
          (str(r.title) ? `${scope.root}/${str(r.title)}` : undefined) ??
          str(r.id) ??
          // No identity fields at all: keep the hit under the bare root —
          // the same contract as the plain-text fallback below, where
          // `scope.root` means "no per-file identity" (hitIds skips it,
          // evals filter it) but the snippet is still useful to the model.
          scope.root;
        const snippet =
          str(r.snippet) ?? str(r.content) ?? str(r.text) ?? str(r.title) ?? textOfRaw(r);
        return { path, snippet, memoryIds: hitIds(path, snippet) };
      });
    }
  } catch {
    // fall through — plain-text result
  }
  return [{ path: scope.root, snippet: trimmed, memoryIds: hitIds(undefined, trimmed) }];
}

function textOfRaw(r: Record<string, unknown>): string {
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
}

function hitIds(path: string | undefined, snippet: string): string[] {
  const ids = memoryIdsIn(snippet);
  if (path && /\/episodes\//.test(path)) ids.push(path);
  return Array.from(new Set(ids));
}
