import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRightToLine, Check, ChevronDown, Eye, Play, Plus, Repeat, Sparkles, Terminal, Trash2, X } from "lucide-react";
import { snippetCompletion } from "@codemirror/autocomplete";
import type { AgentExtensionRecord } from "@intentface/latch-agent-builder";
import { analyzeExtensionScriptFn, deleteAgentExtensionFn, previewExtensionFn, saveAgentExtensionFn } from "@/lib/server";
import { pathPresent, renderLiquid, templateRefs } from "@/lib/liquid-preview";
import { paramsOf, parseSchema, signatureOf, snippetOf } from "@/lib/tool-signature";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover } from "@/components/ui/popover";
import { CodeEditor } from "@/components/code-editor";
import { LiquidEditor } from "@/components/liquid-editor";
import { PlanStory, type Plan } from "@/components/plan-story";
import type { ToolInfo } from "@/routes/agents";

/**
 * The extension page: two columns, side by side, each with a segmented toggle.
 *
 *   left:  Script · Story · Data     right:  Template · Preview
 *
 * The story is the compiled plan and needs no run — the same compile that
 * lints the script produces it; a run fills in each step's value. Data is the
 * run's output, or sample JSON before one. The preview renders the template
 * live in the browser against Data. A variables check marks each path the
 * template reads. Properties are pills in the header. Save writes this one
 * extension onto the stored agent.
 */

export type ExtensionRec = AgentExtensionRecord;
type Preview = Awaited<ReturnType<typeof previewExtensionFn>>;

const TRIGGERS: Array<{ value: ExtensionRec["on"]; label: string; hint: string; icon: typeof Terminal }> = [
  { value: "slash", label: "Slash command", hint: "Runs when the user types /name …; the rest of the line is input.args", icon: Terminal },
  { value: "chat-start", label: "Chat start", hint: "Runs once per conversation, before the first reply", icon: Sparkles },
  { value: "every-turn", label: "Every turn", hint: "Runs before every reply", icon: Repeat },
];

const REFRESH_PRESETS: Array<{ label: string; ms: number | null }> = [
  { label: "Never", ms: null },
  { label: "After 15 minutes", ms: 15 * 60_000 },
  { label: "After 1 hour", ms: 60 * 60_000 },
  { label: "After 6 hours", ms: 6 * 60 * 60_000 },
  { label: "After a day", ms: 24 * 60 * 60_000 },
];

const EMPTY: ExtensionRec = { name: "", on: "slash", script: "", template: "" };

export function ExtensionPage({
  agentName,
  scope,
  initial,
  tools,
  onSaved,
  onDeleted,
}: {
  agentName: string;
  scope: "user" | "org";
  /** The saved extension, or null for a new one. */
  initial: ExtensionRec | null;
  tools: ToolInfo[];
  onSaved: (name: string) => void;
  onDeleted: () => void;
}) {
  const [ext, setExt] = useState<ExtensionRec>(initial ?? EMPTY);
  const [savedName, setSavedName] = useState<string | undefined>(initial?.name);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = JSON.stringify(ext) !== JSON.stringify(initial ?? EMPTY) || !savedName;
  const set = useCallback(
    <K extends keyof ExtensionRec>(key: K, value: ExtensionRec[K]) => setExt((e) => ({ ...e, [key]: value })),
    [],
  );
  const target = ext.target ?? "message";
  const trigger = TRIGGERS.find((t) => t.value === ext.on) ?? TRIGGERS[0]!;

  // ---- run (script) --------------------------------------------------------
  const [testArgs, setTestArgs] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Preview | null>(null);
  const part = result?.ok ? result.part : null;
  const runError =
    result && !result.ok
      ? result.error
      : part?.error && part.output === null && part.error.code !== "media_dropped"
        ? part.error.message
        : null;

  async function run() {
    if (testing) return;
    setTesting(true);
    try {
      const text = ext.on === "slash" ? `/${ext.name} ${testArgs}`.trim() : undefined;
      const r = await previewExtensionFn({ data: { agent: agentName, extension: ext, text } });
      setResult(r);
      if (r.ok && r.part.output) setDataText(pretty(r.part.output));
    } finally {
      setTesting(false);
    }
  }

  // ---- compile (shared by lint and the story) ------------------------------
  type Analysis = { issues: string[]; calls: string[]; plan: string | null };
  const toolNames = useMemo(() => tools.map((t) => t.name), [tools]);
  const analyses = useRef(new Map<string, Promise<Analysis>>());
  const analyze = useCallback(
    (source: string): Promise<Analysis> => {
      const key = `${toolNames.join(",")}\u0000${source}`;
      const cached = analyses.current.get(key);
      if (cached) return cached;
      const p: Promise<Analysis> = analyzeExtensionScriptFn({ data: { script: source, toolNames } });
      analyses.current.set(key, p);
      if (analyses.current.size > 50) analyses.current.delete(analyses.current.keys().next().value!);
      return p;
    },
    [toolNames],
  );
  const [compiled, setCompiled] = useState<Analysis | null>(null);
  useEffect(() => {
    const source = ext.script ?? "";
    if (!source.trim()) {
      setCompiled(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      analyze(source).then((a) => !cancelled && setCompiled(a));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [ext.script, analyze]);

  // ---- data panel ----------------------------------------------------------
  const [dataText, setDataText] = useState("{}");
  const data = useMemo<{ value: unknown; error: string | null }>(() => {
    try {
      return { value: dataText.trim() ? JSON.parse(dataText) : {}, error: null };
    } catch (e) {
      return { value: undefined, error: e instanceof Error ? e.message : String(e) };
    }
  }, [dataText]);
  const [leftPane, setLeftPane] = useState<"script" | "story" | "data">("script");
  const [rightPane, setRightPane] = useState<"template" | "preview">("template");
  const story = useMemo(() => {
    const planJson = part?.plan ?? compiled?.plan ?? null;
    if (!planJson) return null;
    try {
      const plan = JSON.parse(planJson) as Plan;
      if (!Array.isArray(plan.steps)) return null;
      const steps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(part?.steps ?? {})) steps[k] = safeParse(v);
      return { plan, steps, ran: !!part && part.output !== null };
    } catch {
      return null;
    }
  }, [part, compiled]);

  // ---- template preview (live, client-side) -------------------------------
  const scope_ = useMemo(
    () =>
      ({
        input: { args: testArgs || "", argv: testArgs ? testArgs.split(/\s+/) : [] },
        output: data.value ?? {},
        steps: story?.steps ?? {},
        ...(story?.steps ?? {}),
      }) as Record<string, unknown>,
    [data.value, story, testArgs],
  );
  const [preview, setPreview] = useState<{ text: string; error: string | null }>({ text: "", error: null });
  useEffect(() => {
    const tpl = ext.template ?? "";
    if (!tpl.trim()) {
      setPreview({ text: data.value !== undefined ? `\`\`\`json\n${pretty(JSON.stringify(data.value))}\n\`\`\`` : "", error: null });
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      renderLiquid(tpl, scope_).then(
        (text) => !cancelled && setPreview({ text, error: null }),
        (e) => !cancelled && setPreview({ text: "", error: e instanceof Error ? e.message : String(e) }),
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [ext.template, scope_, data.value]);

  const refs = useMemo(() => templateRefs(ext.template ?? ""), [ext.template]);
  const refChecks = useMemo(
    () =>
      refs.map((path) => ({
        path,
        ok: pathPresent(scope_, path),
        // paths not under a known root (output/input/steps/a step id) are noted, not judged
        known: /^(input|output|steps)\b/.test(path) || Object.keys(story?.steps ?? {}).some((k) => path === k || path.startsWith(`${k}.`)),
      })),
    [refs, scope_, story],
  );

  // ---- script editor helpers -----------------------------------------------
  const lint = useCallback(
    async (source: string) => {
      const r = await analyze(source);
      const gated = tools.filter((t) => t.defaultApproval && r.calls.includes(t.name)).map((t) => t.name);
      return [
        ...r.issues,
        ...(gated.length && !ext.allowMutations
          ? [`line 1: ${gated.join(", ")} need${gated.length === 1 ? "s" : ""} approval — allow mutating tools on this extension, or drop the call`]
          : []),
      ];
    },
    [analyze, tools, ext.allowMutations],
  );
  const toolByName = useMemo(() => new Map(tools.map((t) => [t.name, t])), [tools]);
  const hover = useCallback(
    (word: string) => {
      const t = toolByName.get(word);
      if (!t) return null;
      const schema = parseSchema(t.inputSchemaJson);
      return toolInfoCard(t, schema, paramsOf(schema));
    },
    [toolByName],
  );
  const scriptCompletions = useMemo(
    () => [
      { label: "input", type: "variable", detail: "{ args, argv } or structured input" },
      ...tools.map((t) => {
        const schema = parseSchema(t.inputSchemaJson);
        const params = paramsOf(schema);
        return snippetCompletion(snippetOf(t.name, schema), {
          label: t.name,
          type: "function",
          detail: params.length ? `(${params.map((p) => `${p.name}${p.required ? "" : "?"}`).join(", ")})` : "()",
          info: () => toolInfoCard(t, schema, params),
        });
      }),
    ],
    [tools],
  );

  // ---- save / delete -------------------------------------------------------
  async function save() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveAgentExtensionFn({ data: { agent: agentName, scope, extension: ext, previousName: savedName } });
      if (!res.ok) {
        setSaveError(res.error);
        return;
      }
      setSavedName(res.name);
      onSaved(res.name);
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (savedName && !confirm(`Remove extension “${savedName}”?`)) return;
    if (savedName) await deleteAgentExtensionFn({ data: { agent: agentName, scope, name: savedName } });
    onDeleted();
  }

  return (
    <div className="space-y-6">
      {/* Header: title, description, actions */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1">
            {ext.on === "slash" && <span className="text-ink-tertiary font-mono text-xl">/</span>}
            <input
              value={ext.name}
              onChange={(e) => set("name", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              placeholder={ext.on === "slash" ? "report" : "context"}
              aria-label="Extension name"
              autoFocus={!ext.name}
              spellCheck={false}
              className="text-ink-primary placeholder:text-ink-tertiary w-full min-w-0 bg-transparent font-mono text-xl font-semibold tracking-tight outline-none"
            />
          </div>
          <input
            value={ext.description ?? ""}
            onChange={(e) => set("description", e.target.value || undefined)}
            placeholder="Add a description…"
            aria-label="Description"
            className="text-ink-secondary placeholder:text-ink-tertiary mt-0.5 w-full bg-transparent text-sm outline-none"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {ext.on === "slash" && (
            <label className="border-primary-border focus-within:ring-ring/50 flex h-8 items-center rounded-lg border px-2 font-mono text-xs focus-within:ring-3">
              <span className="text-ink-tertiary">/{ext.name || "name"}</span>
              <span className="sr-only">Arguments for the test run</span>
              <input
                value={testArgs}
                onChange={(e) => setTestArgs(e.target.value)}
                placeholder="args"
                className="text-ink-primary placeholder:text-ink-tertiary ml-1 w-24 bg-transparent outline-none"
              />
            </label>
          )}
          <Button type="button" size="sm" variant="outline" onClick={() => void run()} disabled={testing || !ext.name}>
            <Play className="size-3.5" /> {testing ? "Running…" : "Run script"}
          </Button>
          <Button type="button" size="sm" onClick={() => void save()} disabled={saving || !dirty || !ext.name}>
            {saving ? "Saving…" : savedName && !dirty ? <><Check className="size-3.5" /> Saved</> : "Save"}
          </Button>
        </div>
      </div>
      {saveError && (
        <p className="text-destructive text-xs" role="alert">
          {saveError}
        </p>
      )}

      {/* Properties */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill
          icon={trigger.icon}
          label={trigger.label}
          title={trigger.hint}
          menu={
            <DropdownMenuRadioGroup value={ext.on} onValueChange={(v) => set("on", v as ExtensionRec["on"])}>
              {TRIGGERS.map((t) => (
                <DropdownMenuRadioItem key={t.value} value={t.value}>
                  <div>
                    <div>{t.label}</div>
                    <div className="text-ink-secondary text-xs">{t.hint}</div>
                  </div>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          }
        />
        <Pill
          icon={ArrowRightToLine}
          label={
            target === "instructions"
              ? `System prompt · ${ext.scope === "chat" ? "whole chat" : "this turn"}`
              : `User message · ${ext.placement === "before" ? "before" : "after"} their text`
          }
          title="Where the rendered text goes"
          menu={
            <>
              <DropdownMenuRadioGroup value={target} onValueChange={(v) => set("target", v as ExtensionRec["target"])}>
                <DropdownMenuLabel>Render into</DropdownMenuLabel>
                <DropdownMenuRadioItem value="message">The user message</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="instructions">The system prompt</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              {target === "message" ? (
                <DropdownMenuRadioGroup value={ext.placement ?? "after"} onValueChange={(v) => set("placement", v as ExtensionRec["placement"])}>
                  <DropdownMenuLabel>Placement</DropdownMenuLabel>
                  <DropdownMenuRadioItem value="after">After the user's text</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="before">Before the user's text</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              ) : (
                <DropdownMenuRadioGroup value={ext.scope ?? "turn"} onValueChange={(v) => set("scope", v as ExtensionRec["scope"])}>
                  <DropdownMenuLabel>Applies</DropdownMenuLabel>
                  <DropdownMenuRadioItem value="turn">This turn only</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="chat">The whole chat</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              )}
            </>
          }
        />
        <Pill
          icon={Eye}
          label={ext.reveal === "prompt" ? "User sees the prompt" : ext.reveal === "both" ? "User sees both" : "User sees their text"}
          title="What the user sees on their own message"
          menu={
            <DropdownMenuRadioGroup value={ext.reveal ?? "command"} onValueChange={(v) => set("reveal", v as ExtensionRec["reveal"])}>
              <DropdownMenuRadioItem value="command">Only their text</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="prompt">The rendered prompt</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="both">Both, result expandable</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          }
        />
        <Pill
          icon={ext.allowMutations || ext.onError === "fail" || ext.refresh?.afterMs ? AlertTriangle : Plus}
          label={moreLabel(ext)}
          title="Mutations, failure policy, refresh"
          menu={
            <>
              <DropdownMenuCheckboxItem checked={!!ext.allowMutations} onCheckedChange={(on) => set("allowMutations", on || undefined)}>
                Allow approval-gated (mutating) tools
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={ext.onError === "fail"} onCheckedChange={(on) => set("onError", on ? "fail" : undefined)}>
                Fail the turn if the script fails
              </DropdownMenuCheckboxItem>
              {ext.on === "chat-start" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup
                    value={String(ext.refresh?.afterMs ?? "")}
                    onValueChange={(v) => set("refresh", v ? { afterMs: Number(v) } : undefined)}
                  >
                    <DropdownMenuLabel>Run again</DropdownMenuLabel>
                    {REFRESH_PRESETS.map((p) => (
                      <DropdownMenuRadioItem key={p.label} value={p.ms === null ? "" : String(p.ms)}>
                        {p.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
            </>
          }
        />
      </div>

      {/* Two columns, each with a segmented toggle */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Left: Script · Story · Data */}
        <section className="min-w-0 space-y-2">
          <div className="flex h-7 items-center justify-between gap-2">
            <Segmented
              value={leftPane}
              onChange={setLeftPane}
              options={[
                { value: "script", label: "Script" },
                { value: "story", label: "Story", badge: story ? `${story.plan.steps.length} steps` : undefined },
                { value: "data", label: "Data", badge: part?.output ? "from run" : undefined },
              ]}
            />
            {leftPane === "script" && (
              <Popover>
                <Popover.Trigger render={<Button type="button" variant="ghost" size="sm" className="text-ink-secondary" />}>
                  {tools.length} tool{tools.length === 1 ? "" : "s"}
                  <ChevronDown className="size-3" />
                </Popover.Trigger>
                <Popover.Content className="w-[26rem] p-2" align="end">
                  <ToolsReference tools={tools} onInsert={(call) => set("script", `${ext.script ? ext.script.replace(/\s*$/, "\n") : ""}${call}`)} />
                </Popover.Content>
              </Popover>
            )}
          </div>
          {leftPane === "script" && (
            <CodeEditor
              value={ext.script ?? ""}
              onChange={(v) => set("script", v || undefined)}
              completions={scriptCompletions}
              lint={lint}
              hover={hover}
              ariaLabel="Script"
              height="480px"
              placeholder={
                "// Fetch what the agent always needs first — type a tool name for its parameters.\nconst hours = await clockify_hours({ period: input.args }, { reason: \"this week's hours\" });\nreturn { hours };"
              }
            />
          )}
          {leftPane === "story" && (
            <div className="border-input h-[480px] overflow-auto rounded-lg border p-3">
              {story ? (
                <PlanStory
                  plan={story.plan}
                  steps={story.steps}
                  output={story.ran ? data.value : undefined}
                  tools={tools}
                  ran={story.ran}
                  error={part?.error && part.error.code !== "media_dropped" ? part.error : null}
                />
              ) : (
                <p className="text-ink-secondary text-xs">
                  {compiled?.issues.length
                    ? `The script does not compile yet: ${compiled.issues[0]}`
                    : ext.script?.trim()
                      ? "Compiling…"
                      : "Write a script and its plan appears here as numbered steps — before you run anything."}
                </p>
              )}
            </div>
          )}
          {leftPane === "data" && (
            <>
              <textarea
                value={dataText}
                onChange={(e) => setDataText(e.target.value)}
                aria-label="Data the template renders against (JSON)"
                spellCheck={false}
                className={cn(
                  "border-input focus-visible:ring-ring/50 h-[480px] w-full resize-none rounded-lg border bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:ring-3",
                  data.error && "border-destructive",
                )}
              />
              {data.error && <p className="text-destructive text-xs">{data.error}</p>}
            </>
          )}
          {(part || runError) && (
            <Strip
              tone={runError ? "error" : "ok"}
              text={
                runError
                  ? runError
                  : `Ran in ${part!.durationMs} ms${part!.calls.length ? ` · called ${part!.calls.map((c) => c.tool).join(", ")}` : ""} — the data panel holds the output`
              }
            />
          )}
          {!part && !runError && leftPane === "data" && (
            <p className="text-ink-secondary text-xs">Sample data until you run the script; edit it to try other cases.</p>
          )}
        </section>

        {/* Right: Template · Preview */}
        <section className="min-w-0 space-y-2">
          <div className="flex h-7 flex-wrap items-center justify-between gap-2">
            <Segmented
              value={rightPane}
              onChange={setRightPane}
              options={[
                { value: "template", label: "Template" },
                { value: "preview", label: "Preview", badge: preview.error ? "error" : preview.text ? `${preview.text.length.toLocaleString()} chars` : undefined, tone: preview.error ? "error" : undefined },
              ]}
            />
            {refChecks.length > 0 && (
              <ul className="flex flex-wrap items-center gap-1 text-xs" aria-label="Variables the template reads">
                {refChecks.map((r) => (
                  <li
                    key={r.path}
                    className={cn(
                      "inline-flex items-center gap-0.5 rounded px-1 font-mono",
                      r.ok ? "text-ink-secondary" : r.known ? "text-destructive" : "text-ink-tertiary",
                    )}
                    title={r.ok ? "present in the data" : r.known ? "not in the data — the model would see a blank" : "not something the data provides"}
                  >
                    {r.ok ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
                    {r.path}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {rightPane === "template" && (
            <LiquidEditor
              value={ext.template ?? ""}
              onChange={(v) => set("template", v || undefined)}
              scope={scope_}
              ariaLabel="Template"
              height="480px"
              placeholder={"Write the weekly report for {{ input.args }}.\n{% for h in output.hours %}- {{ h.name }}: {{ h.total }}h\n{% endfor %}"}
            />
          )}
          {rightPane === "preview" && (
            <div className="border-input h-[480px] overflow-auto rounded-lg border px-3 py-2">
              {preview.error ? (
                <p className="text-destructive text-xs whitespace-pre-wrap">{preview.error}</p>
              ) : preview.text ? (
                <pre className="text-ink-primary font-sans text-sm leading-relaxed whitespace-pre-wrap">{preview.text}</pre>
              ) : (
                <p className="text-ink-tertiary text-xs">Type a template, or run the script — the preview updates as you type.</p>
              )}
            </div>
          )}
          <p className="text-ink-secondary text-xs">
            {rightPane === "template"
              ? "Renders live against the data panel; switch to Preview to read it as the model will."
              : `What the model reads${target === "instructions" ? ", in the system prompt" : ", in the user turn"}.`}
          </p>
        </section>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => void remove()}>
          <Trash2 className="size-3.5" /> {savedName ? "Remove extension" : "Discard"}
        </Button>
        {dirty && savedName && <span className="text-ink-secondary text-xs">Unsaved changes</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

/** A small segmented control switching a column's pane. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; badge?: string; tone?: "error" }>;
}) {
  return (
    <div className="border-primary-border inline-flex items-center rounded-lg border p-0.5" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-2 py-0.5 text-xs transition-colors",
            value === o.value ? "bg-base-active text-ink-primary font-medium" : "text-ink-secondary hover:bg-input/40",
          )}
        >
          {o.label}
          {o.badge && <span className={cn("ml-1.5 text-xs", o.tone === "error" ? "text-destructive" : "text-ink-tertiary")}>{o.badge}</span>}
        </button>
      ))}
    </div>
  );
}

function Pill({ icon: Icon, label, title, menu }: { icon: typeof Terminal; label: string; title: string; menu: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs font-normal" />} title={title}>
        <Icon className="text-ink-secondary size-3.5" />
        {label}
        <ChevronDown className="text-ink-tertiary size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {menu}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Strip({ tone, text }: { tone: "ok" | "error"; text: string }) {
  return (
    <p className={cn("text-xs break-words", tone === "error" ? "text-destructive" : "text-ink-secondary")}>
      {tone === "error" && <AlertTriangle className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />}
      {text}
    </p>
  );
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

export function moreLabel(ext: ExtensionRec): string {
  const bits: string[] = [];
  if (ext.allowMutations) bits.push("mutations allowed");
  if (ext.onError === "fail") bits.push("fails the turn on error");
  if (ext.on === "chat-start" && ext.refresh?.afterMs) {
    bits.push(REFRESH_PRESETS.find((p) => p.ms === ext.refresh!.afterMs)?.label.toLowerCase() ?? `refresh ${Math.round(ext.refresh.afterMs / 60_000)} min`);
  }
  return bits.length ? bits.join(" · ") : "More";
}

export function summarizeProps(ext: ExtensionRec): string {
  const bits = [
    ext.target === "instructions"
      ? `system prompt, ${ext.scope === "chat" ? "whole chat" : "this turn"}`
      : `user message, ${ext.placement === "before" ? "before" : "after"} their text`,
  ];
  const more = moreLabel(ext);
  if (more !== "More") bits.push(more);
  return bits.join(" · ");
}

export const TRIGGER_LABEL: Record<ExtensionRec["on"], string> = Object.fromEntries(TRIGGERS.map((t) => [t.value, t.label])) as Record<
  ExtensionRec["on"],
  string
>;

function ToolsReference({ tools, onInsert }: { tools: ToolInfo[]; onInsert: (call: string) => void }) {
  if (tools.length === 0) {
    return <p className="text-ink-secondary p-1 text-xs">No tools yet — pick connections on the agent and save it.</p>;
  }
  return (
    <ul className="max-h-80 space-y-2 overflow-auto text-xs">
      {tools.map((t) => {
        const schema = parseSchema(t.inputSchemaJson);
        const params = paramsOf(schema);
        return (
          <li key={t.name} className="space-y-0.5 px-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-1 py-0.5 font-mono text-xs font-normal"
                title="Insert a call"
                onClick={() => onInsert(`const result = ${snippetOf(t.name, schema).replace(/\$\{(\w+)\}/g, "$1")};`)}
              >
                {signatureOf(t.name, schema)}
              </Button>
              {t.defaultApproval && <span className="text-destructive border-destructive/40 rounded border px-1 py-px text-xs">approval-gated</span>}
            </div>
            {t.description && <p className="text-ink-secondary">{t.description}</p>}
            {params.length > 0 && (
              <ul className="text-ink-secondary ml-3 list-disc">
                {params.map((p) => (
                  <li key={p.name}>
                    <span className="font-mono">
                      {p.name}
                      {p.required ? "" : "?"}: {p.type}
                    </span>
                    {p.description ? ` — ${p.description}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function toolInfoCard(t: ToolInfo, schema: ReturnType<typeof parseSchema>, params: ReturnType<typeof paramsOf>): HTMLElement {
  const el = document.createElement("div");
  el.className = "cm-tool-info";
  const sig = document.createElement("div");
  sig.className = "cm-tool-info-sig";
  sig.textContent = signatureOf(t.name, schema);
  el.appendChild(sig);
  if (t.description) {
    const d = document.createElement("div");
    d.className = "cm-tool-info-desc";
    d.textContent = t.description;
    el.appendChild(d);
  }
  for (const p of params) {
    const row = document.createElement("div");
    row.className = "cm-tool-info-param";
    row.textContent = `${p.name}${p.required ? "" : "?"}: ${p.type}${p.description ? " — " + p.description : ""}`;
    el.appendChild(row);
  }
  if (t.defaultApproval) {
    const g = document.createElement("div");
    g.className = "cm-tool-info-gated";
    g.textContent = "approval-gated: allow mutating tools on this extension to call it";
    el.appendChild(g);
  }
  return el;
}
