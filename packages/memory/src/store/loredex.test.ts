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
function fakeRegistry(opts?: { unauthorized?: boolean; failCreate?: boolean }) {
  const files = new Map<string, string>();
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
              if (files.has(`dir:${path}`)) return err(`Folder already exists: ${path}`);
              files.set(`dir:${path}`, "");
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
                results: [
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
  return { registry, files, calls, closeCount: () => closes };
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
