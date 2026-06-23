import { useEffect, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Bot, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { Dialog } from "@intentface/latch-ui";
import {
  currentPrincipalFn,
  listAgentRecordsFn,
  listModelsFn,
  availableConnectionNamesFn,
  connectionToolsFn,
  connectionsStatusFn,
  listConnectionsFn,
  saveAgentFn,
  deleteAgentFn,
} from "@/lib/server";
import { authorizeUrl } from "@/lib/latch-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface AgentRec {
  name: string;
  title?: string;
  description?: string;
  modelId: string;
  instructions: string;
  connections: string[];
  maxSteps?: number | "unlimited";
  tools?: { enabled: string[]; approval: Record<string, boolean> };
  exec?: {
    sandbox?: boolean;
    provider?: string;
    defaultTools?: boolean | string[];
    disableTools?: string[];
    codeMode?: { tools?: string[] };
  };
  scope: "user" | "org";
}

interface ToolInfo {
  name: string;
  connection: string;
  defaultApproval: boolean;
}

export const Route = createFileRoute("/agents")({
  head: () => ({ meta: [{ title: "Agents · Latch" }] }),
  beforeLoad: async () => {
    if (!(await currentPrincipalFn())) throw redirect({ to: "/login" });
  },
  loader: async () => {
    const [records, models, connections, codeStatus, dynStatus] = await Promise.all([
      listAgentRecordsFn(),
      listModelsFn(),
      availableConnectionNamesFn(),
      connectionsStatusFn(),
      listConnectionsFn(),
    ]);
    // OAuth/authorized per connection (built-in + UI-added) — lets the editor
    // offer a Connect button for an unauthorized OAuth connection.
    const status: Record<string, { oauth: boolean; authorized: boolean }> = {};
    for (const c of codeStatus) status[c.name] = { oauth: c.oauth, authorized: c.authorized };
    for (const c of dynStatus) status[c.name] = { oauth: c.oauth, authorized: c.authorized };
    return { records, models, connections, status };
  },
  component: AgentsPage,
});

function AgentsPage() {
  const { records, models, connections, status } = Route.useLoaderData();
  const [editing, setEditing] = useState<AgentRec | null>(null);
  const [open, setOpen] = useState(false);

  const openNew = () => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (a: AgentRec) => {
    setEditing(a);
    setOpen(true);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-ink-primary text-lg font-semibold tracking-tight">Agents</h1>
          <p className="text-ink-secondary mt-0.5 text-sm">
            A name, a system prompt, a model, and the connections it can use. Agents show up in
            the chat picker and can be scheduled. (Code-defined agents live in the repo.)
          </p>
        </div>
        <Button onClick={openNew} className="shrink-0 gap-1.5">
          <Plus className="size-4" /> New agent
        </Button>
      </div>

      {records.length === 0 ? (
        <div className="border-primary-border text-ink-tertiary flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <Bot className="size-6 opacity-60" />
          <p className="text-sm">No custom agents yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(records as AgentRec[]).map((a) => (
            <AgentCard key={`${a.scope}:${a.name}`} agent={a} onEdit={() => openEdit(a)} />
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <Dialog.Content className="max-h-[85vh] max-w-lg overflow-y-auto">
          <Dialog.Title>{editing ? `Edit “${editing.name}”` : "New agent"}</Dialog.Title>
          <Dialog.Description>
            {editing
              ? "Update this agent. Name and scope are fixed (they identify it)."
              : "Scope it to you or your whole org."}
          </Dialog.Description>
          <div className="mt-4">
            <AgentForm
              key={editing ? `${editing.scope}:${editing.name}` : "new"}
              models={models}
              connections={connections}
              status={status}
              initial={editing}
              onDone={() => setOpen(false)}
            />
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  );
}

function AgentForm({
  models,
  connections,
  status,
  initial,
  onDone,
}: {
  models: { id: string; label: string }[];
  connections: string[];
  status: Record<string, { oauth: boolean; authorized: boolean }>;
  initial: AgentRec | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? models[0]?.id ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [picked, setPicked] = useState<string[]>(initial?.connections ?? []);
  const [scope, setScope] = useState<"user" | "org">(initial?.scope ?? "user");
  const [maxSteps, setMaxSteps] = useState(
    typeof initial?.maxSteps === "number" ? String(initial.maxSteps) : "20",
  );
  const [unlimited, setUnlimited] = useState(initial?.maxSteps === "unlimited");
  const [sandbox, setSandbox] = useState(initial?.exec?.sandbox ?? false);
  const [provider, setProvider] = useState(initial?.exec?.provider ?? "just-bash");
  const [webTools, setWebTools] = useState(
    initial?.exec?.defaultTools === true ||
      (Array.isArray(initial?.exec?.defaultTools) && initial!.exec!.defaultTools.length > 0),
  );
  const [toolList, setToolList] = useState<ToolInfo[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [approval, setApproval] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (c: string) =>
    setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));

  // Fetch the picked connections' tools; seed enable/approval from the agent's
  // stored selection (editing) or defaults (all enabled, GET-free/mutating-gated).
  useEffect(() => {
    let cancelled = false;
    if (picked.length === 0) {
      setToolList([]); setEnabled(new Set()); setApproval({});
      return;
    }
    void connectionToolsFn({ data: picked }).then((tools) => {
      if (cancelled) return;
      setToolList(tools);
      const initEnabled = initial?.tools?.enabled;
      const en = new Set<string>();
      const ap: Record<string, boolean> = {};
      for (const t of tools) {
        const on = initEnabled && initEnabled.length ? initEnabled.includes(t.name) : true;
        if (on) en.add(t.name);
        ap[t.name] = initial?.tools?.approval?.[t.name] ?? t.defaultApproval;
      }
      setEnabled(en);
      setApproval(ap);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked.join(",")]);

  // Re-list after authorizing an OAuth connection in another tab. Preserves the
  // current toggles and adds any newly-listable tools enabled-by-default.
  async function refreshTools() {
    if (picked.length === 0) return;
    setRefreshing(true);
    try {
      const tools = await connectionToolsFn({ data: picked });
      const known = new Set(toolList.map((t) => t.name));
      setEnabled((prev) => {
        const en = new Set(prev);
        for (const t of tools) if (!known.has(t.name)) en.add(t.name);
        return en;
      });
      setApproval((prev) => {
        const ap = { ...prev };
        for (const t of tools)
          if (!known.has(t.name))
            ap[t.name] = initial?.tools?.approval?.[t.name] ?? t.defaultApproval;
        return ap;
      });
      setToolList(tools);
    } finally {
      setRefreshing(false);
    }
  }

  const toggleEnabled = (name: string) =>
    setEnabled((p) => {
      const n = new Set(p);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !instructions.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // All tools enabled → store enabled:[] (means "all", future-proof).
      const allOn = toolList.length > 0 && toolList.every((t) => enabled.has(t.name));
      const tools =
        toolList.length > 0
          ? { enabled: allOn ? [] : [...enabled], approval }
          : undefined;
      const exec =
        sandbox || webTools
          ? {
              sandbox: sandbox || undefined,
              provider: sandbox ? provider : undefined,
              defaultTools: webTools || undefined,
            }
          : undefined;
      const res = await saveAgentFn({
        data: {
          name,
          title: title || undefined,
          modelId,
          instructions,
          connections: picked,
          maxSteps: unlimited ? "unlimited" : Number(maxSteps) || undefined,
          tools,
          exec,
          scope,
        },
      });
      if (!res.ok) {
        setError(res.error ?? "Failed to save");
        return;
      }
      if (!editing) {
        setName(""); setTitle(""); setInstructions(""); setPicked([]);
      }
      await router.invalidate();
      onDone();
    } finally {
      setBusy(false);
    }
  }

  // Picked OAuth connections not yet authorized and contributing no tools — the
  // editor can't list their tools until the caller connects (clears on refresh).
  const needsAuth = picked.filter(
    (c) => status[c]?.oauth && !status[c]?.authorized && !toolList.some((t) => t.connection === c),
  );

  return (
    <form className="space-y-2" onSubmit={submit}>
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name (e.g. researcher)"
              disabled={editing}
            />
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="title (optional)" />
          </div>
          <div className="flex gap-2">
            <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </Select>
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value as never)}
              disabled={editing}
            >
              <option value="user">Personal</option>
              <option value="org">Org</option>
            </Select>
          </div>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="System prompt / instructions…"
          />
          {connections.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-muted-foreground mr-1 text-xs">Connections:</span>
              {connections.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => toggle(c)}
                  className={`rounded-full border px-2 py-0.5 text-xs ${picked.includes(c) ? "border-accent bg-accent text-white" : "border-input bg-transparent"}`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          {picked.length > 0 && (
            <div className="space-y-1 rounded-md border p-2">
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-xs">
                  Tools {toolList.length > 0 ? "(uncheck to disable; toggle approval)" : "— authorize/connect to list"}
                </p>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground text-xs underline disabled:opacity-50"
                  disabled={refreshing}
                  onClick={refreshTools}
                >
                  {refreshing ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {needsAuth.map((c) => (
                <div
                  key={`auth-${c}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-dashed p-2 text-xs"
                >
                  <span>
                    <span className="font-mono">{c}</span> isn't connected — authorize to list its tools.
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      window.open(authorizeUrl(c, { returnTo: "/connections" }), "_blank", "noopener")
                    }
                  >
                    Connect {c}
                  </Button>
                </div>
              ))}
              {toolList.map((t) => (
                <div key={t.name} className="flex items-center justify-between text-xs">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={enabled.has(t.name)}
                      onChange={() => toggleEnabled(t.name)}
                    />
                    <span className="font-mono">{t.name}</span>
                  </label>
                  <label
                    className={`flex items-center gap-1 ${enabled.has(t.name) ? "" : "opacity-40"}`}
                  >
                    <input
                      type="checkbox"
                      checked={!!approval[t.name]}
                      disabled={!enabled.has(t.name)}
                      onChange={() => setApproval((p) => ({ ...p, [t.name]: !p[t.name] }))}
                    />
                    needs approval
                  </label>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3">
            <label className="text-muted-foreground flex items-center gap-1 text-xs">
              max steps
              <Input
                className="h-8 w-20"
                type="number"
                min={1}
                value={maxSteps}
                disabled={unlimited}
                onChange={(e) => setMaxSteps(e.target.value)}
              />
            </label>
            <label className="text-muted-foreground flex items-center gap-1 text-xs">
              <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
              run until it stops
            </label>
          </div>
          <div className="space-y-2 rounded-md border p-2">
            <p className="text-muted-foreground text-xs">Code execution</p>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
              Sandbox — a per-chat workspace with{" "}
              <span className="font-mono">bash / read_file / write_file / glob / grep</span>
            </label>
            {sandbox && (
              <label className="text-muted-foreground ml-6 flex items-center gap-2 text-xs">
                backend
                <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="just-bash">just-bash (in-process)</option>
                  <option value="daytona">Daytona (VM — needs API key)</option>
                </Select>
              </label>
            )}
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={webTools} onChange={(e) => setWebTools(e.target.checked)} />
              Web tools — <span className="font-mono">web_fetch</span>
            </label>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !name.trim() || !instructions.trim()}>
              {editing ? "Update agent" : "Create agent"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
  );
}

function AgentCard({ agent, onEdit }: { agent: AgentRec; onEdit: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    await deleteAgentFn({ data: { name: agent.name, scope: agent.scope } });
    await router.invalidate();
    setBusy(false);
  }
  return (
    <Card size="sm">
      <CardContent className="flex items-center gap-3 py-3">
        <div className="bg-tertiary border-primary-border text-ink-secondary grid size-9 shrink-0 place-items-center rounded-lg border">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{agent.title ?? agent.name}</span>
            {agent.exec?.sandbox && (
              <span className="text-ink-tertiary flex items-center gap-1 text-xs">
                <TerminalSquare className="size-3.5" /> sandbox
              </span>
            )}
            <Badge variant="outline" className="ml-auto">
              {agent.scope === "org" ? "org" : "personal"}
            </Badge>
          </div>
          <p className="text-ink-tertiary truncate text-xs">
            <span className="font-mono">{agent.modelId}</span>
            {" · "}
            {agent.connections.length ? agent.connections.join(", ") : "no connections"}
            {" · "}
            {agent.maxSteps === "unlimited" ? "until done" : `${agent.maxSteps ?? "default"} steps`}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={remove} aria-label="Delete">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
