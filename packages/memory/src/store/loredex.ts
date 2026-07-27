import type { ConnectionRegistry } from "@intentface/latch-core";
import type { EpisodeMeta, MemorySearchHit, MemoryStore, ScopeRef } from "../types.js";
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
 *   and folders; there is no overwrite.
 * - `edit_file { fileId, replacements: [{ oldContent, newContent }] }` —
 *   search-and-replace only; a full rewrite replaces the whole previous text.
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

export function createLoredexStore<P>(opts: {
  connections: ConnectionRegistry<P>;
  toolNames?: Partial<LoredexToolNames>;
}): MemoryStore<P> {
  const names = { ...DEFAULT_TOOL_NAMES, ...opts.toolNames };
  // Folders successfully ensured this process lifetime (per scope key) — the
  // create calls are idempotent-by-tolerance but not free.
  const ensuredFolders = new Set<string>();

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

  /** Create the folder chain for `path` (workspace-relative), tolerating "exists". */
  async function ensureFolders(call: ToolCall, scopeKey: string, path: string): Promise<void> {
    const cacheKey = `${scopeKey}:${path}`;
    if (ensuredFolders.has(cacheKey)) return;
    const parts = path.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const parentId = parts.slice(0, i).join("/") || undefined;
      // "Already exists" comes back as an error — that's the common, fine case.
      await call(names.create, {
        type: "folder",
        name: parts[i],
        ...(parentId ? { parentId } : {}),
      });
    }
    ensuredFolders.add(cacheKey);
  }

  function indexPath(scope: ScopeRef): string {
    return `${scope.root}/${MEMORY_INDEX_FILENAME}`;
  }

  async function readIndexWith(call: ToolCall, scope: ScopeRef): Promise<string | undefined> {
    const res = await call(names.read, { fileId: indexPath(scope) });
    if (!res.ok) return undefined;
    return res.text;
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
      const result = await withConnection(principal, scope, async (call) => {
        const prev = await readIndexWith(call, scope);
        const problems = validateIndexRewrite(prev, text);
        if (problems.length > 0) throw new IndexValidationError(problems);
        if (prev !== undefined && prev.trim().length > 0) {
          // Snapshot BEFORE the rewrite; a failed snapshot aborts the write —
          // never rewrite history we couldn't preserve.
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const snapDir = `${scope.root}/archive/index-snapshots`;
          await ensureFolders(call, scope.key, snapDir);
          const snap = await call(names.create, {
            type: "file",
            name: `MEMORY-${stamp}.md`,
            folderId: snapDir,
            content: prev,
            summary: "Memory index snapshot (pre-consolidation)",
          });
          if (!snap.ok) throw new Error(`memory index snapshot failed: ${snap.error}`);
          const edit = await call(names.edit, {
            fileId: indexPath(scope),
            replacements: [{ oldContent: prev, newContent: text }],
          });
          if (!edit.ok) throw new Error(`memory index rewrite failed: ${edit.error}`);
        } else {
          await ensureFolders(call, scope.key, scope.root);
          const created = await call(names.create, {
            type: "file",
            name: MEMORY_INDEX_FILENAME,
            folderId: scope.root,
            content: text,
            summary: "Compiled memory index (managed by the memory consolidator)",
          });
          if (!created.ok) throw new Error(`memory index create failed: ${created.error}`);
        }
        return true;
      });
      if (result === undefined) throw new Error("memory store unreachable (connection failed)");
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
      const result = await withConnection(principal, scope, async (call) => {
        // Individual reads (not the batch form): per-file failures skip that
        // file instead of poisoning a combined result we'd have to re-split.
        const out: Array<{ path: string; text: string }> = [];
        for (const path of paths) {
          const res = await call(names.read, { fileId: path });
          if (res.ok) out.push({ path, text: res.text });
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
        const path =
          (r.path as string) ?? (r.file as string) ?? (r.fileId as string) ?? scope.root;
        const snippet =
          (r.snippet as string) ?? (r.content as string) ?? (r.text as string) ?? textOfRaw(r);
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
