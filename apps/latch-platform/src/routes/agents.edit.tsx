import { useCallback, useEffect, useState } from "react";
import {
  createFileRoute,
  Link,
  useLoaderData,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  Check,
  Copy,
  Hash,
  MessageCircle,
  Plug,
  RefreshCw,
  Send,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import {
  connectionToolsFn,
  createSlackAppFn,
  getMemoryStatusFn,
  createTelegramBotFn,
  createWhatsappBotFn,
  deleteTelegramBotFn,
  deleteWhatsappBotFn,
  installSlackAppFn,
  listSlackAppsFn,
  listTelegramBotsFn,
  listWhatsappBotsFn,
  registerTelegramWebhookFn,
  saveAgentFn,
  saveTelegramTokenFn,
  saveWhatsappCredentialsFn,
  setSlackConfigTokenFn,
  slackConfigStatusFn,
  slackManifestFn,
  telegramWebhookStatusFn,
  unbindSlackAppFn,
  whatsappWebhookInfoFn,
} from "@/lib/server";
import { authorizeUrl } from "@/lib/latch-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RichSelect } from "@/components/ui/rich-select";
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

// Default model for a NEW agent: first preferred id present in the catalog, else
// the first non-image/embedding model, else the first. (models.dev includes
// image/embedding models and the list is label-sorted, so models[0] is a poor
// default.) Kept inline (client-safe) to avoid importing the server model lib.
const PREFERRED_DEFAULT_MODELS = ["gpt-5.5", "claude-sonnet-4-6", "gpt-5", "gpt-4o"];
const NON_CHAT_MODEL = /image|embed|whisper|tts|dall|audio|realtime|moderation|transcribe|sora/i;
function defaultModelId(models: { id: string }[]): string {
  for (const id of PREFERRED_DEFAULT_MODELS) if (models.some((m) => m.id === id)) return id;
  return models.find((m) => !NON_CHAT_MODEL.test(m.id))?.id ?? models[0]?.id ?? "";
}

function AgentEditor() {
  const { records, allAgents, models, connections, status, authoredTools } = useLoaderData({
    from: "/agents",
  });
  const { name: editName, scope: editScope } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();

  const initial =
    editName != null
      ? ((records as AgentRec[]).find((a) => a.name === editName && a.scope === editScope) ?? null)
      : null;
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? defaultModelId(models));
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
      (Array.isArray(initial?.exec?.defaultTools) &&
        initial.exec.defaultTools.includes("web_fetch")),
  );
  // render_fetch is its own capability flag (like sandbox), not a defaultTools
  // member — so `defaultTools: true` never implies it.
  const [renderTool, setRenderTool] = useState(initial?.exec?.renderTools ?? false);
  const [providerWebTools, setProviderWebTools] = useState(
    initial?.exec?.providerWebTools ?? false,
  );
  const [authoredSel, setAuthoredSel] = useState<string[]>(initial?.exec?.authoredTools ?? []);
  const toggleAuthored = (n: string) =>
    setAuthoredSel((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));
  const [effort, setEffort] = useState<string>(initial?.exec?.effort ?? "");
  const modelSupportsReasoning = !!models.find((m) => m.id === modelId)?.reasoning;
  // Memory: persistent cross-session memory in one of the agent's connections.
  const [memoryOn, setMemoryOn] = useState(!!initial?.exec?.memory);
  const [memoryScope, setMemoryScope] = useState<"agent-user" | "agent-org" | "user">(
    initial?.exec?.memory?.scope ?? "agent-user",
  );
  const [memoryConnection, setMemoryConnection] = useState(
    initial?.exec?.memory?.connection ?? "",
  );
  // Keep the memory picks coherent with the rest of the form: re-pick the
  // connection if its checkbox is later un-ticked (otherwise the save path
  // would silently drop memory), and fall back from org-shared scope when the
  // agent stops being org-visible (the server rejects that combination).
  useEffect(() => {
    if (memoryOn && memoryConnection && !picked.includes(memoryConnection)) {
      setMemoryConnection(picked.includes("loredex") ? "loredex" : (picked[0] ?? ""));
    }
  }, [picked, memoryOn, memoryConnection]);
  useEffect(() => {
    if (memoryOn && memoryScope === "agent-org" && scope !== "org") {
      setMemoryScope("agent-user");
    }
  }, [scope, memoryOn, memoryScope]);
  // Org agents may only attach org-scoped tools (a personal tool wouldn't resolve
  // for other members); personal agents see all (dedup by name, personal wins).
  const visibleAuthored =
    scope === "org"
      ? authoredTools.filter((t) => t.scope === "org")
      : [...new Map(authoredTools.map((t) => [t.name, t])).values()];
  const validAuthoredSel = authoredSel.filter((n) => visibleAuthored.some((t) => t.name === n));
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
      const useEffort = effort && modelSupportsReasoning ? effort : undefined;
      // Save an explicit defaultTools name list (never bare `true`): the Web
      // tools toggle sets web_fetch, and any OTHER default-tool names the agent
      // already had (e.g. askUser) are preserved. render_fetch is NOT here — it
      // is its own capability (`renderTools` below), like sandbox. Keeps the
      // grant least-privilege and avoids dropping/force-adding askUser.
      const prevDefault = initial?.exec?.defaultTools;
      const preserved = Array.isArray(prevDefault)
        ? prevDefault.filter((n) => n !== "web_fetch" && n !== "render_fetch")
        : prevDefault === true
          ? ["askUser"]
          : [];
      const toolNames = [...(webTools ? ["web_fetch"] : []), ...preserved];
      const defaultTools = toolNames.length ? [...new Set(toolNames)] : undefined;
      // Memory only saves with a valid connection pick (the picker defaults to
      // loredex when the agent declares it).
      const memory =
        memoryOn && memoryConnection && picked.includes(memoryConnection)
          ? { scope: memoryScope, connection: memoryConnection }
          : undefined;
      const exec =
        sandbox || defaultTools || renderTool || providerWebTools || validAuthoredSel.length || useEffort || memory
          ? {
              sandbox: sandbox || undefined,
              provider: sandbox ? provider : undefined,
              defaultTools,
              renderTools: renderTool || undefined,
              providerWebTools: providerWebTools || undefined,
              authoredTools: validAuthoredSel.length ? validAuthoredSel : undefined,
              effort: useEffort as "minimal" | "low" | "medium" | "high" | undefined,
              memory,
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
      // Re-run the /agents loader so the list (and a re-open of this editor)
      // shows the just-saved values instead of stale cached loader data.
      await router.invalidate();
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
          {editing ? `Edit “${initial.name}”` : "New agent"}
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
            <RichSelect
              className="w-full"
              value={scope}
              onValueChange={(v) => setScope(v as "user" | "org")}
              disabled={editing}
              options={[
                { value: "user", label: "Personal", description: "Only you can run it" },
                { value: "org", label: "Org", description: "Shared with everyone in your org" },
              ]}
            />
          </div>
        </div>

        {modelSupportsReasoning && (
          <div className="space-y-1.5">
            <FieldLabel>Reasoning effort</FieldLabel>
            <RichSelect
              className="w-full"
              value={effort}
              onValueChange={setEffort}
              options={[
                { value: "", label: "Default", description: "Let the provider decide" },
                { value: "minimal", label: "Minimal", description: "Fastest, least thinking" },
                { value: "low", label: "Low", description: "Small thinking budget" },
                { value: "medium", label: "Medium", description: "Balanced" },
                { value: "high", label: "High", description: "Most thinking, slowest" },
              ]}
            />
          </div>
        )}

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
              tool, each in its own thread.
            </p>
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <span className="text-ink-secondary">
                Subagents run <span className="font-medium">autonomously</span> — their tools are
                auto-approved (no human-in-the-loop) and OAuth gates are skipped. Only delegate to
                agents you trust.
              </span>
            </div>
            <div className="space-y-2">
              {allAgents
                .filter((a) => a.name !== name)
                .map((a) => {
                  const on = subagents.includes(a.name);
                  return (
                    <div
                      key={a.name}
                      className="border-primary-border flex items-center gap-3 rounded-lg border p-3"
                    >
                      <Switch
                        checked={on}
                        onCheckedChange={() => toggleSubagent(a.name)}
                        aria-label={`Delegate to ${a.name}`}
                      />
                      <div className="bg-tertiary text-ink-secondary grid size-7 shrink-0 place-items-center rounded-md">
                        <Bot className="size-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-ink-primary truncate text-sm font-medium">
                          {a.title ?? a.name}
                        </div>
                        {a.description && (
                          <p className="text-ink-tertiary truncate text-xs">{a.description}</p>
                        )}
                      </div>
                    </div>
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
                <option value="mirage">Mirage (VFS — workspace + read-only Slack/Google)</option>
              </Select>
            </label>
          )}
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={webTools} onCheckedChange={() => setWebTools((v) => !v)} />
            <span>
              Web tools — <span className="font-mono">web_fetch</span> (built-in, any model)
            </span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={renderTool} onCheckedChange={() => setRenderTool((v) => !v)} />
            <span>
              Render tool — <span className="font-mono">render_fetch</span>: fetches JS-rendered
              pages in a headless browser (rendered text + schema.org JSON-LD). Active when the
              renderer service is configured.
            </span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={providerWebTools}
              onCheckedChange={() => setProviderWebTools((v) => !v)}
            />
            <span>
              Provider web tools — native <span className="font-mono">web_search</span> /{" "}
              <span className="font-mono">web_fetch</span>, run by the model provider (Anthropic =
              search + fetch, OpenAI = search). No-op on providers without them.
            </span>
          </label>
          {visibleAuthored.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-ink-secondary text-xs font-medium">
                Authored tools{" "}
                <span className="text-ink-tertiary font-normal">
                  — sandboxed tools (from the Tools page) this agent can call
                  {scope === "org" ? " (org-shared only)" : ""}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {visibleAuthored.map((t) => {
                  const on = authoredSel.includes(t.name);
                  return (
                    <button
                      key={t.scope + t.name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleAuthored(t.name)}
                      title={t.description}
                      className={cn(
                        "rounded-md border px-2 py-1 font-mono text-xs transition-colors",
                        on
                          ? "border-ring bg-base-active text-ink-primary"
                          : "border-input text-ink-secondary hover:bg-input/40",
                      )}
                    >
                      {t.name}
                      {t.scope === "org" ? " ·org" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="border-primary-border space-y-3 rounded-lg border p-3">
          <FieldLabel>Memory</FieldLabel>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={memoryOn}
              onCheckedChange={() => {
                const next = !memoryOn;
                // Sensible default pick on first enable: loredex when declared.
                // (Outside the updater — updaters must stay pure.)
                if (next && !memoryConnection) {
                  setMemoryConnection(
                    picked.includes("loredex") ? "loredex" : (picked[0] ?? ""),
                  );
                }
                setMemoryOn(next);
              }}
            />
            <span>
              Persistent memory — the platform archives durable facts from idle chats, keeps a
              compiled index in the system prompt, and gives the agent{" "}
              <span className="font-mono">memory_search / memory_save</span>
            </span>
          </label>
          {memoryOn && (picked.length === 0 || !picked.includes(memoryConnection)) && (
            <p className="text-destructive text-xs">
              Memory needs a valid connection — add or re-select one above (memory files live in
              its workspace). Saving without one drops the memory setting.
            </p>
          )}
          {memoryOn && picked.length > 0 && (
            <div className="ml-12 space-y-2">
              <label className="text-ink-secondary flex items-center gap-2 text-xs">
                Scope
                <Select
                  value={memoryScope}
                  onChange={(e) =>
                    setMemoryScope(e.target.value as "agent-user" | "agent-org" | "user")
                  }
                >
                  <option value="agent-user">Per user — this agent’s memory of each user</option>
                  <option value="agent-org" disabled={scope !== "org"}>
                    Org-shared — one memory for the whole org (org-visible agents only)
                  </option>
                  <option value="user">User-wide — shared with the user’s other agents</option>
                </Select>
              </label>
              <label className="text-ink-secondary flex items-center gap-2 text-xs">
                Connection
                <Select
                  value={memoryConnection}
                  onChange={(e) => setMemoryConnection(e.target.value)}
                >
                  {picked.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
                <span className="text-ink-tertiary">
                  files land under <span className="font-mono">_memory/</span> in its workspace
                </span>
              </label>
              {memoryScope !== "agent-org" && (
                <p className="text-ink-tertiary text-xs">
                  Note: on an org-shared connection, per-user separation is a folder convention —
                  anyone with workspace access can read the files.
                </p>
              )}
              {editing && <MemoryStatus agent={name} />}
            </div>
          )}
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

      {editing && <SlackSection agent={name} />}
      {editing && <TelegramSection agent={name} />}
      {editing && <WhatsappSection agent={name} />}
    </div>
  );
}

/**
 * Live memory status for the SAVED agent config (the caller's own scope):
 * pending episodes, last consolidation, failures — plus a Loredex link when
 * the deployment configures one. Unsaved editor changes aren't reflected.
 */
function MemoryStatus({ agent }: { agent: string }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getMemoryStatusFn>> | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    getMemoryStatusFn({ data: { name: agent } })
      .then((s) => alive && setStatus(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agent]);
  if (!status || !("enabled" in status) || !status.enabled) return null;
  if (!status.resolvable) {
    return (
      <p className="text-ink-tertiary text-xs">
        Memory is configured but the scope can’t be resolved for your session (per-user scope
        without a user).
      </p>
    );
  }
  return (
    <div className="text-ink-tertiary space-y-0.5 text-xs">
      <p>
        Your store: <span className="font-mono">{status.root}</span>
        {status.loredexUrl && (
          <>
            {" · "}
            <a
              href={status.loredexUrl}
              target="_blank"
              rel="noreferrer"
              className="text-ink-secondary underline"
            >
              open Loredex
            </a>
          </>
        )}
      </p>
      <p>
        {status.pendingEpisodes} episode{status.pendingEpisodes === 1 ? "" : "s"} awaiting
        consolidation · last consolidated{" "}
        {status.lastConsolidatedAt
          ? new Date(status.lastConsolidatedAt).toLocaleString()
          : "never"}
        {" · "}
        {status.trackedMemories} recalled entr{status.trackedMemories === 1 ? "y" : "ies"} tracked
        {status.failures > 0 && (
          <span className="text-destructive"> · {status.failures} recent failures</span>
        )}
      </p>
    </div>
  );
}

/**
 * Turn this agent into its own Slack bot (own-app-per-agent). The manual flow:
 * copy the generated manifest → create the app in Slack → install it → paste
 * the bot token + signing secret back here. Once bound, the agent answers in
 * Slack as its own @-handle. (One-button automation is a later upgrade.)
 */
function SlackSection({ agent }: { agent: string }) {
  const [apps, setApps] = useState<{ appId: string; botName?: string }[]>([]);
  const [manifest, setManifest] = useState<{ manifestJson: string; createUrl: string } | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [cfgToken, setCfgToken] = useState("");
  const [cfgRefresh, setCfgRefresh] = useState("");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [appId, setAppId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [all, man, cfg] = await Promise.all([
      listSlackAppsFn(),
      slackManifestFn({ data: agent }),
      slackConfigStatusFn(),
    ]);
    setApps(all.filter((a) => a.agent === agent).map((a) => ({ appId: a.appId, botName: a.botName })));
    setManifest(man);
    setConfigured(cfg.configured);
  }, [agent]);

  useEffect(() => {
    void load();
  }, [load]);

  // One-button: create + install the agent's Slack app via the org config token.
  async function createBot() {
    if (!configured) {
      setSetupOpen(true);
      return;
    }
    setCreating(true);
    setError(null);
    const res = await createSlackAppFn({ data: agent });
    if (res.ok) {
      window.location.href = res.authorizeUrl; // → Slack install → /api/slack/oauth
      return;
    }
    setCreating(false);
    if (res.error === "no_config_token") setSetupOpen(true);
    else setError(res.error ?? "Couldn't create the Slack app.");
  }

  async function saveConfig(e: React.FormEvent) {
    e.preventDefault();
    if (!cfgToken.trim() || !cfgRefresh.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await setSlackConfigTokenFn({
      data: { token: cfgToken.trim(), refreshToken: cfgRefresh.trim() },
    });
    setBusy(false);
    if (!res.ok) {
      setError("Couldn't save the config token.");
      return;
    }
    setCfgToken("");
    setCfgRefresh("");
    setSetupOpen(false);
    setConfigured(true);
  }

  async function copyManifest() {
    if (!manifest) return;
    await navigator.clipboard.writeText(manifest.manifestJson).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function install(e: React.FormEvent) {
    e.preventDefault();
    if (!appId.trim() || !clientId.trim() || !clientSecret.trim() || !signingSecret.trim() || busy)
      return;
    setBusy(true);
    setError(null);
    const res = await installSlackAppFn({
      data: {
        appId: appId.trim(),
        agent,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        signingSecret: signingSecret.trim(),
      },
    });
    if (res.ok) {
      window.location.href = res.authorizeUrl; // → Slack install → /api/slack/oauth (bot token)
      return;
    }
    setBusy(false);
    setError(res.error ?? "Couldn't start the install.");
  }

  async function disconnect(id: string) {
    await unbindSlackAppFn({ data: id });
    await load();
  }

  return (
    <section className="border-primary-border space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Hash className="text-ink-secondary size-4" />
        <h2 className="text-ink-primary text-sm font-semibold">Slack</h2>
      </div>
      <p className="text-ink-tertiary text-xs">
        Give this agent its own Slack app and @-handle. Mention it or DM it, and it answers as this
        agent — tool approvals show up as buttons right in the thread.
      </p>

      {apps.length > 0 && (
        <div className="space-y-2">
          {apps.map((a) => (
            <div
              key={a.appId}
              className="border-primary-border flex items-center gap-3 rounded-lg border p-3"
            >
              <div className="bg-tertiary text-ink-secondary grid size-7 shrink-0 place-items-center rounded-md">
                <Hash className="size-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-ink-primary truncate text-sm font-medium">
                  {a.botName ?? "Slack bot"}
                </div>
                <p className="text-ink-tertiary truncate font-mono text-xs">{a.appId}</p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => disconnect(a.appId)}>
                <Trash2 className="size-3.5" /> Disconnect
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={createBot} disabled={creating}>
          {creating ? "Creating…" : apps.length ? "Add another Slack bot" : "Create Slack bot"}
        </Button>
        <button
          type="button"
          className="text-ink-tertiary hover:text-ink-secondary text-xs underline"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide manual setup" : "Set up manually"}
        </button>
      </div>
      {error && !open && <p className="text-destructive text-xs">{error}</p>}

      {/* One-time: org Slack config token → enables the one-button create. */}
      {setupOpen && (
        <form className="border-primary-border space-y-2 rounded-lg border p-3" onSubmit={saveConfig}>
          <FieldLabel>One-time: connect your Slack workspace</FieldLabel>
          <p className="text-ink-tertiary text-xs">
            Generate an{" "}
            <a
              href="https://api.slack.com/apps"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              App Configuration token
            </a>{" "}
            (Slack → Your Apps → “Your App Configuration Tokens”) and paste it + its refresh token.
            It can only create/manage apps — never read your messages — and is stored in the Vault.
          </p>
          <Input
            placeholder="Config token (xoxe.xoxp-…)"
            type="password"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={cfgToken}
            onChange={(e) => setCfgToken(e.target.value)}
          />
          <Input
            placeholder="Refresh token (xoxe-…)"
            type="password"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={cfgRefresh}
            onChange={(e) => setCfgRefresh(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : "Save & enable one-button"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSetupOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* Manual (B) fallback: create-from-manifest + paste tokens. */}
      {open && (
        <div className="border-primary-border space-y-4 rounded-lg border p-3">
          {/* Step 1 — manifest */}
          <div className="space-y-1.5">
            <FieldLabel>1 · Create the app from this manifest</FieldLabel>
            <div className="relative">
              <pre className="bg-tertiary text-ink-secondary max-h-40 overflow-auto rounded-md p-2 font-mono text-[11px]">
                {manifest?.manifestJson ?? "Loading…"}
              </pre>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1"
                onClick={copyManifest}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
            </div>
            {manifest && (
              <a
                href={manifest.createUrl}
                target="_blank"
                rel="noreferrer"
                className="text-accent inline-flex items-center gap-1 text-xs hover:underline"
              >
                Open Slack “Create from manifest” ↗
              </a>
            )}
          </div>

          {/* Step 2 — copy static creds (no install needed yet) */}
          <div className="space-y-1">
            <FieldLabel>2 · Copy the app credentials</FieldLabel>
            <p className="text-ink-tertiary text-xs">
              In the new app → <span className="font-mono">Basic Information</span> → App
              Credentials: copy the <span className="font-mono">App ID</span>,{" "}
              <span className="font-mono">Client ID</span>,{" "}
              <span className="font-mono">Client Secret</span>, and{" "}
              <span className="font-mono">Signing Secret</span>. (No install needed — we do it next.)
            </p>
          </div>

          {/* Step 3 — install (OAuth captures the bot token automatically) */}
          <form className="space-y-2" onSubmit={install}>
            <FieldLabel>3 · Install — we grab the bot token for you</FieldLabel>
            <Input
              placeholder="App ID (e.g. A0123ABCD)"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
            <Input
              placeholder="Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
            <Input
              placeholder="Client Secret"
              type="password"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <Input
              placeholder="Signing Secret"
              type="password"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
            />
            {error && <p className="text-destructive text-xs">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? "Starting…" : "Install to Slack"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}
    </section>
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

/** A labeled copyable value (webhook URLs, verify tokens). */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="text-ink-tertiary w-24 shrink-0 text-xs">{label}</span>
      <code className="bg-tertiary text-ink-secondary min-w-0 flex-1 truncate rounded px-1.5 py-0.5 font-mono text-[11px]">
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}

/**
 * Turn this agent into its own Telegram bot: create the bot in BotFather,
 * paste the token here (validated via `getMe`), then register the webhook.
 * Users DM the bot; unlinked users get a signed account-link first.
 */
function TelegramSection({ agent }: { agent: string }) {
  type TgBot = {
    id: string;
    agent: string;
    handle: string;
    displayName?: string;
    botUsername?: string;
    webhookRegisteredAt?: number;
    eventsUrl: string;
  };
  const [bots, setBots] = useState<TgBot[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<{
    botId: string;
    url: string;
    pendingUpdateCount: number;
    lastErrorMessage?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const all = await listTelegramBotsFn();
    setBots(all.filter((b) => b.agent === agent));
  }, [agent]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createBot(e: React.FormEvent) {
    e.preventDefault();
    if (!handle.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await createTelegramBotFn({ data: { agent, handle: handle.trim() } });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't create the bot.");
      return;
    }
    setHandle("");
    setCreateOpen(false);
    setTokenFor(res.botId); // next step: paste the BotFather token
    await load();
  }

  async function saveToken(e: React.FormEvent) {
    e.preventDefault();
    if (!tokenFor || !token.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await saveTelegramTokenFn({ data: { botId: tokenFor, botToken: token.trim() } });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't save the token.");
      return;
    }
    setToken("");
    setTokenFor(null);
    await load();
  }

  async function registerWebhook(botId: string) {
    setBusy(true);
    setError(null);
    const res = await registerTelegramWebhookFn({ data: botId });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't register the webhook.");
      return;
    }
    await Promise.all([load(), checkStatus(botId)]);
  }

  async function checkStatus(botId: string) {
    const info = await telegramWebhookStatusFn({ data: botId });
    setStatus(info ? { botId, ...info } : null);
    if (!info) setError("Couldn't fetch the webhook status — is the token saved?");
  }

  async function remove(botId: string) {
    await deleteTelegramBotFn({ data: botId });
    if (status?.botId === botId) setStatus(null);
    await load();
  }

  return (
    <section className="border-primary-border space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Send className="text-ink-secondary size-4" />
        <h2 className="text-ink-primary text-sm font-semibold">Telegram</h2>
      </div>
      <p className="text-ink-tertiary text-xs">
        Give this agent its own Telegram bot. Users DM it and it answers as this agent — replies
        stream as live message edits, and tool approvals show up as inline buttons.
      </p>

      {bots.map((b) => (
        <div key={b.id} className="border-primary-border space-y-2 rounded-lg border p-3">
          <div className="flex items-center gap-3">
            <div className="bg-tertiary text-ink-secondary grid size-7 shrink-0 place-items-center rounded-md">
              <Send className="size-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-ink-primary truncate text-sm font-medium">
                {b.displayName ?? b.handle}
                {b.botUsername && (
                  <a
                    href={`https://t.me/${b.botUsername}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent ml-2 text-xs hover:underline"
                  >
                    @{b.botUsername}
                  </a>
                )}
              </div>
              <p className="text-ink-tertiary truncate font-mono text-xs">
                {b.botUsername
                  ? b.webhookRegisteredAt
                    ? "webhook registered"
                    : "webhook NOT registered"
                  : "token not saved yet"}
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setTokenFor(b.id)}>
              {b.botUsername ? "Replace token" : "Save token"}
            </Button>
            {b.botUsername && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => registerWebhook(b.id)}
              >
                <RefreshCw className="size-3.5" /> Register webhook
              </Button>
            )}
            {b.botUsername && (
              <Button type="button" variant="ghost" size="sm" onClick={() => checkStatus(b.id)}>
                Status
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => remove(b.id)}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>

          {tokenFor === b.id && (
            <form className="space-y-2" onSubmit={saveToken}>
              <FieldLabel>Paste the BotFather token</FieldLabel>
              <p className="text-ink-tertiary text-xs">
                In Telegram, message{" "}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  @BotFather
                </a>{" "}
                → <span className="font-mono">/newbot</span> → copy the token it prints. Saving
                validates it and generates a fresh webhook secret — register the webhook after.
              </p>
              <Input
                placeholder="1234567890:AAF…"
                type="password"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? "Validating…" : "Save token"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setTokenFor(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {status?.botId === b.id && (
            <div className="bg-tertiary space-y-1 rounded-md p-2 text-xs">
              <p className="text-ink-secondary truncate font-mono">
                url: {status.url || "(not set)"}
              </p>
              <p className="text-ink-secondary font-mono">
                pending updates: {status.pendingUpdateCount}
              </p>
              {status.lastErrorMessage && (
                <p className="text-destructive font-mono">last error: {status.lastErrorMessage}</p>
              )}
            </div>
          )}
        </div>
      ))}

      {createOpen ? (
        <form className="space-y-2" onSubmit={createBot}>
          <Input
            placeholder="Handle (e.g. support-bot)"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !handle.trim()}>
              Create bot
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          {bots.length ? "Add another Telegram bot" : "Create Telegram bot"}
        </Button>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </section>
  );
}

/**
 * Connect this agent to a WhatsApp business number (Meta Cloud API): paste the
 * Meta app credentials, then copy the callback URL + verify token into the
 * Meta dashboard's webhook configuration.
 */
function WhatsappSection({ agent }: { agent: string }) {
  type WaBot = {
    id: string;
    agent: string;
    handle: string;
    displayName?: string;
    phoneNumberId?: string;
    callbackUrl: string;
  };
  const [bots, setBots] = useState<WaBot[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [credsFor, setCredsFor] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [webhook, setWebhook] = useState<{
    botId: string;
    callbackUrl: string;
    verifyToken: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const all = await listWhatsappBotsFn();
    setBots(all.filter((b) => b.agent === agent));
  }, [agent]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createBot(e: React.FormEvent) {
    e.preventDefault();
    if (!handle.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await createWhatsappBotFn({ data: { agent, handle: handle.trim() } });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't create the bot.");
      return;
    }
    setHandle("");
    setCreateOpen(false);
    setCredsFor(res.botId); // next step: paste the Meta credentials
    await load();
  }

  async function saveCreds(e: React.FormEvent) {
    e.preventDefault();
    if (!credsFor || !accessToken.trim() || !phoneNumberId.trim() || !appSecret.trim() || busy)
      return;
    setBusy(true);
    setError(null);
    const res = await saveWhatsappCredentialsFn({
      data: {
        botId: credsFor,
        accessToken: accessToken.trim(),
        phoneNumberId: phoneNumberId.trim(),
        appSecret: appSecret.trim(),
      },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Meta rejected the credentials.");
      return;
    }
    setAccessToken("");
    setPhoneNumberId("");
    setAppSecret("");
    const botId = credsFor;
    setCredsFor(null);
    await Promise.all([load(), showWebhook(botId)]);
  }

  async function showWebhook(botId: string) {
    const info = await whatsappWebhookInfoFn({ data: botId });
    setWebhook(info ? { botId, ...info } : null);
  }

  async function remove(botId: string) {
    await deleteWhatsappBotFn({ data: botId });
    if (webhook?.botId === botId) setWebhook(null);
    await load();
  }

  return (
    <section className="border-primary-border space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <MessageCircle className="text-ink-secondary size-4" />
        <h2 className="text-ink-primary text-sm font-semibold">WhatsApp</h2>
      </div>
      <p className="text-ink-tertiary text-xs">
        Connect this agent to a WhatsApp business number via the Meta Cloud API. Users message the
        number and it answers as this agent; the reply arrives when the turn finishes.
      </p>

      {bots.map((b) => (
        <div key={b.id} className="border-primary-border space-y-2 rounded-lg border p-3">
          <div className="flex items-center gap-3">
            <div className="bg-tertiary text-ink-secondary grid size-7 shrink-0 place-items-center rounded-md">
              <MessageCircle className="size-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-ink-primary truncate text-sm font-medium">
                {b.displayName ?? b.handle}
              </div>
              <p className="text-ink-tertiary truncate font-mono text-xs">
                {b.phoneNumberId
                  ? `phone number id: ${b.phoneNumberId}`
                  : "credentials not saved yet"}
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCredsFor(b.id)}>
              {b.phoneNumberId ? "Replace credentials" : "Save credentials"}
            </Button>
            {b.phoneNumberId && (
              <Button type="button" variant="ghost" size="sm" onClick={() => showWebhook(b.id)}>
                Webhook config
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => remove(b.id)}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>

          {credsFor === b.id && (
            <form className="space-y-2" onSubmit={saveCreds}>
              <FieldLabel>Paste the Meta app credentials</FieldLabel>
              <p className="text-ink-tertiary text-xs">
                From the{" "}
                <a
                  href="https://developers.facebook.com/apps/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  Meta App Dashboard
                </a>
                : a long-lived <b>System User access token</b> (the dashboard's temporary token
                dies in 24h), the <b>Phone number ID</b> (WhatsApp → API Setup), and the{" "}
                <b>App secret</b> (App Settings → Basic).
              </p>
              <Input
                placeholder="Access token (EAAG…)"
                type="password"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
              />
              <Input
                placeholder="Phone number ID (numeric)"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
              />
              <Input
                placeholder="App secret"
                type="password"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? "Validating…" : "Save credentials"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setCredsFor(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {webhook?.botId === b.id && (
            <div className="space-y-1.5">
              <p className="text-ink-tertiary text-xs">
                In the Meta dashboard (WhatsApp → Configuration → Webhook) paste both values, save
                (the deployment must be live — Meta verifies immediately), and subscribe to the{" "}
                <span className="font-mono">messages</span> field.
              </p>
              <CopyRow label="Callback URL" value={webhook.callbackUrl} />
              <CopyRow label="Verify token" value={webhook.verifyToken ?? "(save credentials first)"} />
            </div>
          )}
        </div>
      ))}

      {createOpen ? (
        <form className="space-y-2" onSubmit={createBot}>
          <Input
            placeholder="Handle (e.g. support-whatsapp)"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !handle.trim()}>
              Create bot
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          {bots.length ? "Add another WhatsApp bot" : "Connect WhatsApp"}
        </Button>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </section>
  );
}
