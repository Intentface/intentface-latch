import { useEffect, useState } from "react";
import { createFileRoute, Link, useLoaderData, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronLeft, Plug, RefreshCw } from "lucide-react";
import { connectionToolsFn, saveAgentFn } from "@/lib/server";
import { authorizeUrl } from "@/lib/latch-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import type { AgentRec, ToolInfo } from "./agents";

export const Route = createFileRoute("/agents/edit")({
  validateSearch: (s: Record<string, unknown>) => ({
    name: typeof s.name === "string" ? s.name : undefined,
    scope: s.scope === "org" ? ("org" as const) : s.scope === "user" ? ("user" as const) : undefined,
  }),
  component: AgentEditor,
});

/** Small labeled section header used through the editor. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-ink-secondary text-xs font-medium">{children}</label>;
}

function AgentEditor() {
  const { records, allAgents, models, connections, status } = useLoaderData({ from: "/agents" });
  const { name: editName, scope: editScope } = Route.useSearch();
  const navigate = useNavigate();

  const initial =
    editName != null
      ? ((records as AgentRec[]).find((a) => a.name === editName && a.scope === editScope) ?? null)
      : null;
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
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
  const [subagents, setSubagents] = useState<string[]>(initial?.subagents ?? []);
  const toggleSubagent = (n: string) =>
    setSubagents((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));
  const [toolList, setToolList] = useState<ToolInfo[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [approval, setApproval] = useState<Record<string, boolean>>({});
  // Per-tool description overrides (only the ones the user actually customized).
  const [descriptions, setDescriptions] = useState<Record<string, string>>(
    initial?.tools?.descriptions ?? {},
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (c: string) =>
    setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  const toggleExpand = (c: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });

  // Fetch the picked connections' tools; seed enable/approval from the agent's
  // stored selection (editing) or defaults (all enabled, approval = the tool's).
  useEffect(() => {
    let cancelled = false;
    if (picked.length === 0) {
      setToolList([]);
      setEnabled(new Set());
      setApproval({});
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

  // Re-list after authorizing / when the provider's tools change. Preserves the
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

  const toggleEnabled = (n: string) =>
    setEnabled((p) => {
      const s = new Set(p);
      if (s.has(n)) s.delete(n);
      else s.add(n);
      return s;
    });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !instructions.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const allOn = toolList.length > 0 && toolList.every((t) => enabled.has(t.name));
      // Keep only overrides that differ from the tool's own description.
      const descOverrides: Record<string, string> = {};
      for (const t of toolList) {
        const v = descriptions[t.name];
        if (v != null && v.trim() && v.trim() !== (t.description ?? "").trim()) {
          descOverrides[t.name] = v.trim();
        }
      }
      const tools =
        toolList.length > 0
          ? {
              enabled: allOn ? [] : [...enabled],
              approval,
              descriptions: Object.keys(descOverrides).length ? descOverrides : undefined,
            }
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
          description: description || undefined,
          modelId,
          instructions,
          connections: picked,
          maxSteps: unlimited ? "unlimited" : Number(maxSteps) || undefined,
          tools,
          exec,
          subagents: subagents.length ? subagents : undefined,
          scope,
        },
      });
      if (!res.ok) {
        setError(res.error ?? "Failed to save");
        return;
      }
      navigate({ to: "/agents" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="space-y-2">
        <Link
          to="/agents"
          className="text-ink-secondary hover:text-ink-primary inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" /> Agents
        </Link>
        <h1 className="text-ink-primary text-lg font-semibold tracking-tight">
          {editing ? `Edit “${initial!.name}”` : "New agent"}
        </h1>
        <p className="text-ink-secondary text-sm">
          {editing
            ? "Update this agent. Name and scope are fixed (they identify it)."
            : "Define a name, prompt, model, and the connections it can use."}
        </p>
      </div>

      <form className="space-y-5" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="researcher"
              disabled={editing}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel>Title (optional)</FieldLabel>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Researcher" />
          </div>
        </div>

        <div className="space-y-1.5">
          <FieldLabel>Description (optional)</FieldLabel>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One line shown in the chat picker"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <FieldLabel>Model</FieldLabel>
            <Select className="w-full" value={modelId} onChange={(e) => setModelId(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <FieldLabel>Scope</FieldLabel>
            <Select
              className="w-full"
              value={scope}
              onChange={(e) => setScope(e.target.value as never)}
              disabled={editing}
            >
              <option value="user">Personal</option>
              <option value="org">Org</option>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <FieldLabel>System prompt</FieldLabel>
          <Textarea
            className="min-h-64 font-mono text-[13px] leading-relaxed"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="You are a helpful assistant…"
          />
        </div>

        {connections.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <FieldLabel>Connections &amp; tools</FieldLabel>
              <button
                type="button"
                onClick={refreshTools}
                disabled={refreshing || picked.length === 0}
                className="text-ink-secondary hover:text-ink-primary inline-flex items-center gap-1 text-xs disabled:opacity-50"
              >
                <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
                Refresh
              </button>
            </div>
            <div className="space-y-2">
              {connections.map((c) => (
                <ConnectionRow
                  key={c}
                  name={c}
                  on={picked.includes(c)}
                  open={expanded.has(c)}
                  status={status[c]}
                  tools={toolList.filter((t) => t.connection === c)}
                  enabled={enabled}
                  approval={approval}
                  descriptions={descriptions}
                  onToggleOn={() => toggle(c)}
                  onToggleOpen={() => toggleExpand(c)}
                  onToggleTool={toggleEnabled}
                  onToggleApproval={(n) => setApproval((p) => ({ ...p, [n]: !p[n] }))}
                  onDescribe={(n, v) => setDescriptions((p) => ({ ...p, [n]: v }))}
                />
              ))}
            </div>
          </div>
        )}

        {allAgents.filter((a) => a.name !== name).length > 0 && (
          <div className="space-y-2">
            <FieldLabel>Subagents</FieldLabel>
            <p className="text-ink-tertiary text-xs">
              Agents this one may delegate to via a <span className="font-mono">spawn_agent</span>{" "}
              tool. Subagents run autonomously (their tools are auto-approved) in their own thread.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {allAgents
                .filter((a) => a.name !== name)
                .map((a) => {
                  const on = subagents.includes(a.name);
                  return (
                    <button
                      key={a.name}
                      type="button"
                      onClick={() => toggleSubagent(a.name)}
                      title={a.description ?? a.title ?? a.name}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors",
                        on
                          ? "border-accent bg-accent text-white"
                          : "border-input bg-transparent hover:border-accent-border/60",
                      )}
                    >
                      {a.title ?? a.name}
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <label className="text-ink-secondary flex items-center gap-2 text-xs">
            Max steps
            <Input
              className="h-8 w-20"
              type="number"
              min={1}
              value={maxSteps}
              disabled={unlimited}
              onChange={(e) => setMaxSteps(e.target.value)}
            />
          </label>
          <label className="text-ink-secondary flex items-center gap-2 text-xs">
            <Switch checked={unlimited} onCheckedChange={() => setUnlimited((v) => !v)} />
            Run until it stops
          </label>
        </div>

        <div className="border-primary-border space-y-3 rounded-lg border p-3">
          <FieldLabel>Code execution</FieldLabel>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={sandbox} onCheckedChange={() => setSandbox((v) => !v)} />
            <span>
              Sandbox — a per-chat workspace with{" "}
              <span className="font-mono">bash / read_file / write_file / glob / grep</span>
            </span>
          </label>
          {sandbox && (
            <label className="text-ink-secondary ml-12 flex items-center gap-2 text-xs">
              Backend
              <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="just-bash">just-bash (in-process)</option>
                <option value="daytona">Daytona (VM — needs API key)</option>
              </Select>
            </label>
          )}
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={webTools} onCheckedChange={() => setWebTools((v) => !v)} />
            <span>
              Web tools — <span className="font-mono">web_fetch</span>
            </span>
          </label>
        </div>

        {error && <p className="text-destructive text-sm">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !name.trim() || !instructions.trim()}>
            {editing ? "Update agent" : "Create agent"}
          </Button>
          <Button type="button" variant="ghost" render={<Link to="/agents" />}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

function ConnectionRow({
  name,
  on,
  open,
  status,
  tools,
  enabled,
  approval,
  descriptions,
  onToggleOn,
  onToggleOpen,
  onToggleTool,
  onToggleApproval,
  onDescribe,
}: {
  name: string;
  on: boolean;
  open: boolean;
  status?: { oauth: boolean; authorized: boolean };
  tools: ToolInfo[];
  enabled: Set<string>;
  approval: Record<string, boolean>;
  descriptions: Record<string, string>;
  onToggleOn: () => void;
  onToggleOpen: () => void;
  onToggleTool: (n: string) => void;
  onToggleApproval: (n: string) => void;
  onDescribe: (n: string, v: string) => void;
}) {
  const needsAuth = on && status?.oauth && !status.authorized && tools.length === 0;
  return (
    <div className="border-primary-border overflow-hidden rounded-lg border">
      <div className="flex items-center gap-3 p-3">
        <Switch checked={on} onCheckedChange={onToggleOn} aria-label={`Use ${name}`} />
        <div className="bg-tertiary text-ink-secondary grid size-7 shrink-0 place-items-center rounded-md">
          <Plug className="size-3.5" />
        </div>
        <button
          type="button"
          onClick={onToggleOpen}
          disabled={!on}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-60"
        >
          <span className="truncate text-sm font-medium">{name}</span>
          {status?.oauth && (
            <span
              className={cn(
                "size-1.5 rounded-full",
                status.authorized ? "bg-emerald-500" : "bg-amber-500",
              )}
            />
          )}
          {on && (
            <span className="text-ink-tertiary ml-auto flex items-center gap-1 text-xs">
              {tools.length > 0 && `${enabled.size ? [...enabled].filter((n) => tools.some((t) => t.name === n)).length : 0}/${tools.length}`}
              <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
            </span>
          )}
        </button>
      </div>

      {on && open && (
        <div className="border-primary-border space-y-2 border-t p-3">
          {needsAuth ? (
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-ink-secondary">
                Not connected — authorize to list its tools.
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  window.open(authorizeUrl(name, { returnTo: "/connections" }), "_blank", "noopener")
                }
              >
                Connect
              </Button>
            </div>
          ) : tools.length === 0 ? (
            <p className="text-ink-tertiary text-xs">No tools listed yet — try Refresh.</p>
          ) : (
            tools.map((t) => {
              const off = !enabled.has(t.name);
              const desc = descriptions[t.name] ?? t.description ?? "";
              const overridden =
                descriptions[t.name] != null &&
                descriptions[t.name].trim() !== (t.description ?? "").trim();
              return (
                <div key={t.name} className={cn("flex flex-col gap-1.5 py-1.5", off && "opacity-50")}>
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={!off}
                      onCheckedChange={() => onToggleTool(t.name)}
                      aria-label={`Enable ${t.name}`}
                    />
                    <span className="text-ink-primary min-w-0 flex-1 truncate font-mono text-xs">
                      {t.name}
                    </span>
                    <label className="text-ink-secondary flex shrink-0 items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={!!approval[t.name]}
                        disabled={off}
                        onChange={() => onToggleApproval(t.name)}
                      />
                      approval
                    </label>
                  </div>
                  <div className="ml-12 flex items-start gap-1.5">
                    <Textarea
                      className="min-h-0 resize-none py-1.5 text-xs leading-snug"
                      rows={2}
                      value={desc}
                      disabled={off}
                      onChange={(e) => onDescribe(t.name, e.target.value)}
                      placeholder="Tool description (shown to the model)"
                    />
                    {overridden && (
                      <button
                        type="button"
                        onClick={() => onDescribe(t.name, t.description ?? "")}
                        title="Reset to the provider's description"
                        className="text-ink-tertiary hover:text-ink-primary mt-1.5 shrink-0 text-[10px] underline"
                      >
                        reset
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
