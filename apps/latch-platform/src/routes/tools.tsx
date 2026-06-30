import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  currentPrincipalFn,
  listAuthoredToolsFn,
  saveAuthoredToolFn,
  testAuthoredToolFn,
  deleteAuthoredToolFn,
} from "@/lib/server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { CodeEditor } from "@/components/code-editor";

type AuthoredTool = {
  name: string;
  description: string;
  code: string;
  inputSchema: string;
  allowedHosts: string[];
  updatedAt: number;
};

type Draft = {
  originalName?: string;
  name: string;
  description: string;
  inputSchema: string;
  code: string;
  allowedHosts: string;
};

const BLANK: Draft = {
  name: "",
  description: "",
  inputSchema: '{\n  "type": "object",\n  "properties": {}\n}',
  code: "// `input` = the call args; `fetch(url)` returns { ok, status, json, text }.\n// const r = await fetch(`https://api.example.com/x?q=${input.q}`);\n// return r.json;\nreturn { ok: true };",
  allowedHosts: "",
};

export const Route = createFileRoute("/tools")({
  head: () => ({ meta: [{ title: "Tools · Latch" }] }),
  beforeLoad: async () => {
    if (!(await currentPrincipalFn())) throw redirect({ to: "/login" });
  },
  loader: () => listAuthoredToolsFn(),
  component: ToolsPage,
});

function ToolsPage() {
  const tools = Route.useLoaderData() as AuthoredTool[];
  const router = useRouter();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function remove(name: string) {
    if (!window.confirm(`Delete the tool "${name}"?`)) return;
    setBusy(name);
    await deleteAuthoredToolFn({ data: name }).catch(() => {});
    setBusy(null);
    router.invalidate();
  }

  if (editing) {
    return (
      <ToolEditor
        draft={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.invalidate();
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-end justify-between">
        <h1 className="text-lg font-semibold">Tools</h1>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">{tools.length} tools</span>
          <Button size="sm" onClick={() => setEditing({ ...BLANK })}>
            New tool
          </Button>
        </div>
      </div>
      <p className="text-ink-tertiary text-sm">
        Sandboxed JS/TS programs over <span className="font-mono">input</span> + an allowlisted{" "}
        <span className="font-mono">fetch</span>. The Agent Builder authors them; you can write,
        edit, and test them here, then attach them to agents.
      </p>
      {tools.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No tools yet. Click <span className="font-medium">New tool</span> — or ask the Agent
          Builder to author one.
        </p>
      ) : (
        <div className="space-y-3">
          {tools.map((t) => (
            <div key={t.name} className="border-primary-border rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-sm font-medium">{t.name}</div>
                  <div className="text-ink-secondary text-sm">{t.description}</div>
                  {t.allowedHosts.length > 0 && (
                    <div className="text-ink-tertiary mt-1 text-xs">
                      hosts: <span className="font-mono">{t.allowedHosts.join(", ")}</span>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEditing({
                        originalName: t.name,
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                        code: t.code,
                        allowedHosts: t.allowedHosts.join(", "),
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === t.name}
                    onClick={() => remove(t.name)}
                  >
                    {busy === t.name ? "…" : "Delete"}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const parseHosts = (s: string): string[] =>
  s
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);

function ToolEditor({
  draft,
  onClose,
  onSaved,
}: {
  draft: Draft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [inputSchema, setInputSchema] = useState(draft.inputSchema);
  const [code, setCode] = useState(draft.code);
  const [allowedHosts, setAllowedHosts] = useState(draft.allowedHosts);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testInput, setTestInput] = useState("{}");
  const [testing, setTesting] = useState(false);
  const [testOut, setTestOut] = useState<
    { status: "completed"; result: string } | { status: "error"; error: string } | null
  >(null);

  async function save() {
    setError(null);
    setSaving(true);
    const res = await saveAuthoredToolFn({
      data: {
        name,
        description,
        inputSchema,
        code,
        allowedHosts: parseHosts(allowedHosts),
        originalName: draft.originalName,
      },
    }).catch((e) => ({ ok: false as const, error: (e as Error).message }));
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't save the tool.");
      return;
    }
    onSaved();
  }

  async function runTest() {
    setError(null);
    setTestOut(null);
    let input: unknown = {};
    if (testInput.trim()) {
      try {
        input = JSON.parse(testInput);
      } catch {
        setTestOut({ status: "error", error: "Test input is not valid JSON." });
        return;
      }
    }
    setTesting(true);
    const res = await testAuthoredToolFn({
      data: { code, input, allowedHosts: parseHosts(allowedHosts) },
    }).catch((e) => ({ status: "error" as const, error: (e as Error).message }));
    setTesting(false);
    setTestOut(res);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          {draft.originalName ? `Edit ${draft.originalName}` : "New tool"}
        </h1>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label>Name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="get_ranked_windows"
          className="font-mono"
        />
        <p className="text-ink-tertiary text-xs">Letters, digits, underscore. Renaming moves the tool.</p>
      </div>

      <div className="space-y-1.5">
        <Label>Description</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What the tool does and its inputs (the model reads this)."
        />
      </div>

      <div className="space-y-1.5">
        <Label>Allowed hosts</Label>
        <Input
          value={allowedHosts}
          onChange={(e) => setAllowedHosts(e.target.value)}
          placeholder="api.open-meteo.com, api.example.com"
          className="font-mono"
        />
        <p className="text-ink-tertiary text-xs">
          Comma/space separated. <span className="font-mono">fetch</span> may only reach these;
          empty = no network.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Input schema (JSON Schema)</Label>
        <Textarea
          value={inputSchema}
          onChange={(e) => setInputSchema(e.target.value)}
          className="min-h-24 font-mono text-xs"
          spellCheck={false}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Code (JS / TypeScript)</Label>
        <CodeEditor value={code} onChange={setCode} />
        <p className="text-ink-tertiary text-xs">
          <span className="font-mono">input</span> = call args; <span className="font-mono">await fetch(url)</span>{" "}
          → <span className="font-mono">{`{ ok, status, json, text }`}</span>; end with{" "}
          <span className="font-mono">return</span>.
        </p>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex gap-2">
        <Button onClick={save} disabled={saving || !name.trim()}>
          {saving ? "Saving…" : "Save tool"}
        </Button>
      </div>

      <div className="border-primary-border space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <Label>Test run</Label>
          <Button size="sm" variant="outline" onClick={runTest} disabled={testing}>
            {testing ? "Running…" : "Run"}
          </Button>
        </div>
        <p className="text-ink-tertiary text-xs">
          Runs the code above with the JSON input below, against your allowed hosts. Real fetches —
          side effects happen.
        </p>
        <Textarea
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          className="min-h-16 font-mono text-xs"
          spellCheck={false}
          placeholder='{ "q": "example" }'
        />
        {testOut && (
          <div className="mt-1">
            {testOut.status === "completed" ? (
              <pre className="text-ink-secondary bg-input/40 overflow-x-auto rounded p-2 text-xs whitespace-pre-wrap">
                {testOut.result}
              </pre>
            ) : (
              <p className="text-destructive text-sm">Error: {testOut.error}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
