import { useEffect, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  currentPrincipalFn,
  listAgentRecordsFn,
  listModelsFn,
  availableConnectionNamesFn,
  connectionToolsFn,
  saveAgentFn,
  deleteAgentFn,
} from "@/lib/server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface AgentRec {
  name: string;
  title?: string;
  description?: string;
  modelId: string;
  instructions: string;
  connections: string[];
  maxSteps?: number | "unlimited";
  tools?: { enabled: string[]; approval: Record<string, boolean> };
  scope: "user" | "org";
}

interface ToolInfo {
  name: string;
  connection: string;
  defaultApproval: boolean;
}

export const Route = createFileRoute("/agents")({
  beforeLoad: async () => {
    if (!(await currentPrincipalFn())) throw redirect({ to: "/login" });
  },
  loader: async () => {
    const [records, models, connections] = await Promise.all([
      listAgentRecordsFn(),
      listModelsFn(),
      availableConnectionNamesFn(),
    ]);
    return { records, models, connections };
  },
  component: AgentsPage,
});

function AgentsPage() {
  const { records, models, connections } = Route.useLoaderData();
  const [editing, setEditing] = useState<AgentRec | null>(null);

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Agents</h1>
      <p className="text-muted-foreground text-sm">
        Create an agent: a name, a system prompt, a model, and the connections it
        can use. It shows up in the chat picker and can be scheduled. (Code-defined
        agents like Assistant and Weekly Brief live in the repo and aren't listed
        here.)
      </p>

      <AgentForm
        key={editing ? `${editing.scope}:${editing.name}` : "new"}
        models={models}
        connections={connections}
        initial={editing}
        onDone={() => setEditing(null)}
      />

      <div className="space-y-2">
        {records.length === 0 && (
          <p className="text-muted-foreground text-sm">No custom agents yet.</p>
        )}
        {(records as AgentRec[]).map((a) => (
          <AgentCard key={`${a.scope}:${a.name}`} agent={a} onEdit={() => setEditing(a)} />
        ))}
      </div>
    </div>
  );
}

function AgentForm({
  models,
  connections,
  initial,
  onDone,
}: {
  models: { id: string; label: string }[];
  connections: string[];
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
  const [toolList, setToolList] = useState<ToolInfo[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [approval, setApproval] = useState<Record<string, boolean>>({});
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
      const res = await saveAgentFn({
        data: {
          name,
          title: title || undefined,
          modelId,
          instructions,
          connections: picked,
          maxSteps: unlimited ? "unlimited" : Number(maxSteps) || undefined,
          tools,
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

  const sel = "border-input bg-background h-9 rounded-md border px-2 text-sm";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `Edit “${initial!.name}”` : "New agent"}</CardTitle>
        <CardDescription>
          {editing
            ? "Update this agent. Name and scope are fixed (they identify it)."
            : "Scope it to you or your whole org."}
        </CardDescription>
      </CardHeader>
      <CardContent>
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
            <select className={sel} value={modelId} onChange={(e) => setModelId(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <select
              className={sel}
              value={scope}
              onChange={(e) => setScope(e.target.value as never)}
              disabled={editing}
            >
              <option value="user">Personal</option>
              <option value="org">Org</option>
            </select>
          </div>
          <textarea
            className="border-input bg-background min-h-24 w-full rounded-md border p-2 text-sm"
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
                  className={`rounded-full border px-2 py-0.5 text-xs ${picked.includes(c) ? "bg-primary text-primary-foreground" : "bg-background"}`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          {picked.length > 0 && (
            <div className="space-y-1 rounded-md border p-2">
              <p className="text-muted-foreground text-xs">
                Tools {toolList.length > 0 ? "(uncheck to disable; toggle approval)" : "— authorize/connect to list"}
              </p>
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
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !name.trim() || !instructions.trim()}>
              {editing ? "Update agent" : "Create agent"}
            </Button>
            {editing && (
              <Button type="button" variant="ghost" disabled={busy} onClick={onDone}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
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
    <Card>
      <CardContent className="flex items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{agent.title ?? agent.name}</span>
            <Badge variant="outline">{agent.scope === "org" ? "org" : "personal"}</Badge>
            <Badge variant="secondary">{agent.modelId}</Badge>
          </div>
          <p className="text-muted-foreground truncate text-xs">
            {agent.name} · connections: {agent.connections.join(", ") || "none"} · steps:{" "}
            {agent.maxSteps === "unlimited" ? "until done" : (agent.maxSteps ?? "default")}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
