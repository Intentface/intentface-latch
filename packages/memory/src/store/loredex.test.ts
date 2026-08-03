import { describe, expect, it } from "vitest";
import type { ConnectionRegistry, OpenToolSet } from "@intentface/latch-core";
import { createLoredexStore } from "./loredex.js";
import type { ScopeRef } from "../types.js";
import { MemoryStoreUnreachableError } from "../types.js";

/**
 * Fake Loredex-shaped connection: an in-memory file map behind MCP-ish tools
 * (`{ content: [{type:"text",text}], isError? }` results), recording every
 * call and close so tests can assert behavior AND ordering.
 */
function fakeRegistry(opts?: {
  unauthorized?: boolean;
  failCreate?: boolean;
  /** Override the search tool's `results` array (e.g. the live Loredex shape). */
  searchResults?: Array<Record<string, unknown>>;
}) {
  const files = new Map<string, string>();
  /** Every folder path created, in order — duplicates included, as live does. */
  const folders: string[] = [];
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  let closes = 0;

  const ok = (text: string) => ({ content: [{ type: "text", text }] });
  const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });

  const tools: Record<string, unknown> = opts?.unauthorized
    ? {}
    : {
        loredex_read_file: {
          execute: async (input: { fileId: string }) => {
            calls.push({ tool: "read_file", input });
            const text = files.get(input.fileId);
            return text === undefined ? err(`File not found: ${input.fileId}`) : ok(text);
          },
        },
        loredex_create: {
          execute: async (input: Record<string, unknown>) => {
            calls.push({ tool: "create", input });
            if (input.type === "folder") {
              const path = [input.parentId, input.name].filter(Boolean).join("/");
              // Live Loredex does NOT reject a duplicate folder name — it
              // inserts a second sibling and auto-creates its `index.md`, and
              // path reads keep resolving to the first one. Model exactly that
              // (`folders` is an array, so duplicates are countable) or the
              // fake hides the empty-shadow-folder bug.
              folders.push(path);
              if (!files.has(`${path}/index.md`)) files.set(`${path}/index.md`, "");
              return ok(`created folder ${path}`);
            }
            if (opts?.failCreate) return err("boom");
            const path = [input.folderId, input.name].filter(Boolean).join("/");
            if (files.has(path)) return err(`File already exists: ${path}`);
            files.set(path, String(input.content ?? ""));
            return ok(`created ${path}`);
          },
        },
        loredex_edit_file: {
          execute: async (input: {
            fileId: string;
            replacements: Array<{ oldContent: string; newContent: string }>;
          }) => {
            calls.push({ tool: "edit_file", input });
            const current = files.get(input.fileId);
            if (current === undefined) return err(`File not found: ${input.fileId}`);
            let next = current;
            for (const r of input.replacements) {
              if (!next.includes(r.oldContent)) return err("oldContent not found");
              next = next.replace(r.oldContent, r.newContent);
            }
            files.set(input.fileId, next);
            return ok("edited");
          },
        },
        loredex_search: {
          execute: async (input: Record<string, unknown>) => {
            calls.push({ tool: "search", input });
            return ok(
              JSON.stringify({
                results: opts?.searchResults ?? [
                  {
                    path: "_memory/coach/u-1/episodes/2026-07-01-10-00-tempo.md",
                    snippet: "…[m-7f3a2c] tempo…",
                  },
                ],
              }),
            );
          },
        },
      };

  const registry: ConnectionRegistry<{ id: string }> = {
    hostFor: () => ({
      open: async (): Promise<OpenToolSet> => ({
        tools,
        close: async () => {
          closes++;
        },
      }),
    }),
  };
  return { registry, files, folders, calls, closeCount: () => closes };
}

const SCOPE: ScopeRef = {
  key: "loredex:_memory/coach/u-1",
  connection: "loredex",
  root: "_memory/coach/u-1",
};
const P = { id: "usr_1" };

const VALID_INDEX = `# Memory — coach · u-1

## Identity & preferences
- [m-7f3a2c] (2026-07-12, user-said) Prefers concise answers. ← episodes/a.md

## Archive
`;

describe("createLoredexStore", () => {
  it("readIndex returns undefined for a missing file, text when present", async () => {
    const { registry, files } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    expect(await store.readIndex(P, SCOPE)).toBeUndefined();
    files.set("_memory/coach/u-1/MEMORY.md", VALID_INDEX);
    expect(await store.readIndex(P, SCOPE)).toBe(VALID_INDEX);
  });

  it("writeIndex creates the file (and folder chain) on first write", async () => {
    const { registry, files, calls } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    await store.writeIndex(P, SCOPE, VALID_INDEX);
    expect(files.get("_memory/coach/u-1/MEMORY.md")).toBe(VALID_INDEX);
    const folderCreates = calls.filter((c) => c.tool === "create" && c.input.type === "folder");
    expect(folderCreates.map((c) => c.input.name)).toEqual(["_memory", "coach", "u-1"]);
  });

  it("never creates the private root itself for a private-root scope", async () => {
    const { registry, files, calls } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    const scope: ScopeRef = {
      key: "loredex:__private_root/_memory/_user/u-1",
      connection: "loredex",
      root: "__private_root/_memory/_user/u-1",
    };
    await store.writeIndex(P, scope, VALID_INDEX);
    expect(files.get("__private_root/_memory/_user/u-1/MEMORY.md")).toBe(VALID_INDEX);
    const folderCreates = calls.filter((c) => c.tool === "create" && c.input.type === "folder");
    // `__private_root` always exists server-side; creating it would mint a
    // stray shared folder. Only its descendants are ensured.
    expect(folderCreates.map((c) => c.input.name)).toEqual(["_memory", "_user", "u-1"]);
    expect(folderCreates[0]?.input.parentId).toBe("__private_root");
    // Existence probes stay rooted at the private root. Probing the bare
    // `_memory/index.md` would resolve against the SHARED top-level `_memory`
    // (agent-org scopes create one), so every private segment would look like
    // it already existed and the scope would never be created at all.
    const probes = calls
      .filter((c) => c.tool === "read_file" && String(c.input.fileId).endsWith("/index.md"))
      .map((c) => c.input.fileId);
    expect(probes).toEqual([
      "__private_root/_memory/index.md",
      "__private_root/_memory/_user/index.md",
      "__private_root/_memory/_user/u-1/index.md",
    ]);
  });

  const EPISODE = {
    slug: "tempo-run",
    summary: "Tempo run",
    body: "Ran 8k tempo.",
    meta: {
      agent: "coach",
      extractedAt: "2026-07-31T09:43:00.000Z",
      provenance: "user-said" as const,
    },
  };

  it("never creates a folder twice across writes that share ancestors", async () => {
    // The empty-shadow-folder bug: `writeEpisode` ensures `<root>/episodes`
    // and `writeIndex` ensures `<root>`, so the shared `_memory/coach/u-1`
    // ancestors were walked — and re-created — a second time.
    const { registry, folders } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    await store.writeEpisode(P, SCOPE, EPISODE);
    await store.writeIndex(P, SCOPE, VALID_INDEX);
    expect(folders).toEqual([
      "_memory",
      "_memory/coach",
      "_memory/coach/u-1",
      "_memory/coach/u-1/episodes",
    ]);
  });

  it("a fresh store (new process) reuses folders instead of duplicating them", async () => {
    // The in-process `ensuredFolders` cache is empty on every cold start, so
    // existence has to be probed against the workspace, not just remembered.
    const { registry, folders } = fakeRegistry();
    await createLoredexStore({ connections: registry }).writeIndex(P, SCOPE, VALID_INDEX);
    const before = [...folders];
    await createLoredexStore({ connections: registry }).writeEpisode(P, SCOPE, EPISODE);
    expect(folders).toEqual([...before, "_memory/coach/u-1/episodes"]);
  });

  it("writeIndex snapshots BEFORE rewriting an existing index", async () => {
    const { registry, files, calls } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    files.set("_memory/coach/u-1/MEMORY.md", VALID_INDEX);
    const next = VALID_INDEX.replace("Prefers concise answers.", "Prefers detailed answers.");
    await store.writeIndex(P, SCOPE, next);

    const snapshotIdx = calls.findIndex(
      (c) => c.tool === "create" && String(c.input.name).startsWith("MEMORY-"),
    );
    const editIdx = calls.findIndex((c) => c.tool === "edit_file");
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(editIdx).toBeGreaterThan(snapshotIdx);
    expect(files.get("_memory/coach/u-1/MEMORY.md")).toBe(next);
    const snapPath = Array.from(files.keys()).find((k) =>
      k.includes("archive/index-snapshots/MEMORY-"),
    );
    expect(snapPath).toBeDefined();
    expect(files.get(snapPath!)).toBe(VALID_INDEX);
  });

  it("writeIndex rejects a rewrite that silently deletes an active entry", async () => {
    const { registry, files } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    files.set("_memory/coach/u-1/MEMORY.md", VALID_INDEX);
    const bad = VALID_INDEX.replace(/- \[m-7f3a2c\].*\n/, "");
    await expect(store.writeIndex(P, SCOPE, bad)).rejects.toThrow(/silently deleted/);
    expect(files.get("_memory/coach/u-1/MEMORY.md")).toBe(VALID_INDEX);
  });

  it("writeEpisode renders frontmatter and a chronologically sortable name", async () => {
    const { registry, files } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    const written = await store.writeEpisode(P, SCOPE, {
      slug: "calf strain (week 2)",
      meta: {
        chat: "cht_1",
        agent: "coach",
        extractedAt: "2026-07-27T10:30:45.000Z",
        provenance: "user-said",
      },
      summary: "calf strain",
      body: "## Facts\n- (user-said) left calf strained",
    });
    expect(written?.name).toBe("2026-07-27-10-30-calf-strain-week-2.md");
    expect(written?.path).toBe(`_memory/coach/u-1/episodes/${written!.name}`);
    const text = files.get(written!.path)!;
    expect(text).toContain("chat: cht_1");
    expect(text).toContain("provenance: user-said");
    expect(text).toContain("## Facts");
    // Optional trust/alias frontmatter is absent unless set.
    expect(text).not.toContain("status:");
    expect(text).not.toContain("aliases:");
  });

  it("writeEpisode renders aliases and the unverified status when set", async () => {
    const { registry, files } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    const written = await store.writeEpisode(P, SCOPE, {
      slug: "new-lead",
      meta: {
        agent: "coach",
        extractedAt: "2026-07-27T10:30:45.000Z",
        provenance: "user-said",
        aliases: ["Robert Smith", "Bob"],
        status: "unverified",
      },
      summary: "new lead",
      body: "## Facts\n- (user-said) Bob is the new team lead",
    });
    const text = files.get(written!.path)!;
    expect(text).toContain("aliases: [Robert Smith, Bob]");
    expect(text).toContain("status: unverified");
  });

  it("degrades gracefully when the connection is unauthorized (empty toolset)", async () => {
    const { registry } = fakeRegistry({ unauthorized: true });
    const store = createLoredexStore({ connections: registry });
    expect(await store.readIndex(P, SCOPE)).toBeUndefined();
    expect(await store.search(P, SCOPE, "x")).toEqual([]);
    expect(await store.available(P, SCOPE)).toBe(false);
    expect(
      await store.writeEpisode(P, SCOPE, {
        slug: "s",
        meta: { agent: "a", extractedAt: "2026-07-27T10:00:00Z", provenance: "user-said" },
        summary: "s",
        body: "b",
      }),
    ).toBeUndefined();
  });

  it("writeIndex signals an unreachable store with MemoryStoreUnreachableError", async () => {
    const { registry } = fakeRegistry({ unauthorized: true });
    const store = createLoredexStore({ connections: registry });
    await expect(store.writeIndex(P, SCOPE, VALID_INDEX)).rejects.toBeInstanceOf(
      MemoryStoreUnreachableError,
    );
  });

  it("search scopes to the memory folder and extracts memory ids", async () => {
    const { registry, calls } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    const hits = await store.search(P, SCOPE, "tempo", 3);
    const searchCall = calls.find((c) => c.tool === "search")!;
    expect(searchCall.input.folderId).toBe(SCOPE.root);
    expect(searchCall.input.limit).toBe(3);
    expect(hits).toHaveLength(1);
    expect(hits[0].memoryIds).toContain("m-7f3a2c");
    expect(hits[0].memoryIds).toContain(hits[0].path);
  });

  it("search maps the live Loredex result shape (id/title, no path) to a scoped path", async () => {
    // Observed live shape (2026-07-29): results carry an opaque `id` and the
    // filename as `title` — no path field. Regression: the parser used to fall
    // back to the bare scope root, erasing every hit's file identity.
    const { registry } = fakeRegistry({
      searchResults: [
        {
          id: "file_QE2DrP_XTDLrimGtIKQEf",
          title: "no-caffeine-after-noon.md",
          fileType: ".md",
          score: 1000000000,
          snippet: "no-caffeine-after-noon.md",
          url: "https://app.loredex.ai/memory-eval/file_QE2DrP_XTDLrimGtIKQEf",
        },
        { id: "file_noTitle123", score: 1, snippet: "orphan snippet" },
      ],
    });
    const store = createLoredexStore({ connections: registry });
    const hits = await store.search(P, SCOPE, "caffeine", 5);
    expect(hits[0].path).toBe(`${SCOPE.root}/no-caffeine-after-noon.md`);
    expect(hits[0].snippet).toBe("no-caffeine-after-noon.md");
    // No title → the opaque id (still resolvable by read tools), never the bare root.
    expect(hits[1].path).toBe("file_noTitle123");
    expect(hits[1].snippet).toBe("orphan snippet");
  });

  it("search keeps an identity-less hit under the bare root with its snippet intact", async () => {
    // No path/file/fileId/title/id at all: the bare root is the documented
    // "no per-file identity" contract (same as plain-text results) — the
    // snippet still reaches the model, and id-dependent consumers skip it.
    const { registry } = fakeRegistry({
      searchResults: [{ score: 1, snippet: "mystery snippet with [m-9a8b7c]" }],
    });
    const store = createLoredexStore({ connections: registry });
    const hits = await store.search(P, SCOPE, "mystery", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(SCOPE.root);
    expect(hits[0].snippet).toBe("mystery snippet with [m-9a8b7c]");
    expect(hits[0].memoryIds).toContain("m-9a8b7c");
  });

  it("always closes the connection, including on failure paths", async () => {
    const { registry, closeCount } = fakeRegistry({ failCreate: true });
    const store = createLoredexStore({ connections: registry });
    await store.readIndex(P, SCOPE);
    await expect(store.writeIndex(P, SCOPE, VALID_INDEX)).rejects.toThrow();
    expect(closeCount()).toBe(2);
  });

  it("readEpisodes skips missing files", async () => {
    const { registry, files } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    files.set("_memory/coach/u-1/episodes/a.md", "A");
    const out = await store.readEpisodes(P, SCOPE, [
      "_memory/coach/u-1/episodes/a.md",
      "_memory/coach/u-1/episodes/missing.md",
    ]);
    expect(out).toEqual([{ path: "_memory/coach/u-1/episodes/a.md", text: "A" }]);
  });

  it("readEpisodes rejects paths outside the scope root (traversal, prefix-sibling)", async () => {
    const { registry, files, calls } = fakeRegistry();
    const store = createLoredexStore({ connections: registry });
    files.set("_memory/coach/u-1/episodes/a.md", "A");
    files.set("_memory/coach/u-12/episodes/b.md", "OTHER USER");
    const out = await store.readEpisodes(P, SCOPE, [
      "_memory/coach/u-1/episodes/a.md",
      "_memory/coach/u-1/../u-12/episodes/b.md", // traversal
      "_memory/coach/u-12/episodes/b.md", // sibling, not under root
      "_memory/coach/u-1", // the root itself, not strictly under it
    ]);
    expect(out).toEqual([{ path: "_memory/coach/u-1/episodes/a.md", text: "A" }]);
    // Out-of-scope paths never even reach the connection.
    const reads = calls.filter((c) => c.tool === "read_file");
    expect(reads).toHaveLength(1);
  });
});
