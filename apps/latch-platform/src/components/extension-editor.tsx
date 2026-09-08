import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRightToLine,
  ChevronDown,
  Eye,
  Pencil,
  Play,
  Plus,
  Repeat,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import { snippetCompletion } from "@codemirror/autocomplete";
import type { AgentRecord } from "@/lib/agent-form";
import { previewExtensionFn } from "@/lib/server";
import { paramsOf, parseSchema, signatureOf, snippetOf } from "@/lib/tool-signature";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
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
import { PlanStory, summarize, type Plan } from "@/components/plan-story";
import type { ToolInfo } from "@/routes/agents";

/**
 * The agent editor's Extensions section: a compact list in the form and a
 * dialog to edit one.
 *
 * The dialog is one calm column. A name you type into, a line of description,
 * a row of property pills (trigger · where the result goes · what the user
 * sees · more), then the script and the template as two editors that grow
 * with their content. Nothing else is on screen until you press Run; then a
 * one-line strip under each editor says what happened, and Story / Output /
 * Rendered expand inline on request. Edits apply to the form's record as you
 * type — the agent's Save persists them.
 */

type ExtensionRec = NonNullable<AgentRecord["extensions"]>[number];
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

export function ExtensionsSection({
  rec,
  patch,
  editing,
  tools,
}: {
  rec: AgentRecord;
  patch: (fn: (r: AgentRecord) => AgentRecord) => void;
  editing: boolean;
  /** The connections' tools as last listed — completions + reference for scripts. */
  tools: ToolInfo[];
}) {
  const list = rec.extensions ?? [];
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const update = (i: number, fn: (e: ExtensionRec) => ExtensionRec) =>
    patch((r) => {
      const xs = [...(r.extensions ?? [])];
      xs[i] = fn(xs[i]!);
      return { ...r, extensions: xs };
    });
  const remove = (i: number) => {
    setOpenIndex(null);
    patch((r) => ({ ...r, extensions: (r.extensions ?? []).filter((_, j) => j !== i) }));
  };
  const add = () => {
    patch((r) => ({
      ...r,
      extensions: [...(r.extensions ?? []), { name: "", on: "slash", script: "", template: "" }],
    }));
    setOpenIndex(list.length);
  };
  const current = openIndex !== null ? list[openIndex] : undefined;

  return (
    <div className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg space-y-3 rounded-lg p-3">
      <div className="flex items-center justify-between">
        <span className="text-ink-secondary text-xs font-medium">Extensions</span>
        <Button type="button" variant="ghost" size="sm" onClick={add}>
          <Plus className="size-3.5" /> Add extension
        </Button>
      </div>
      <p className="text-ink-tertiary text-xs">
        A script runs <em>before</em> the model over this agent's tools; a template renders what it
        returned into the prompt. The result is stored on the user's message, so the model reads exactly
        what ran.
      </p>
      {list.length > 0 && (
        <ul className="divide-primary-border border-primary-border divide-y rounded-md border text-xs">
          {list.map((ext, i) => {
            const trigger = TRIGGERS.find((t) => t.value === ext.on) ?? TRIGGERS[0]!;
            return (
              <li key={i} className="flex items-center gap-3 px-2.5 py-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                  onClick={() => setOpenIndex(i)}
                >
                  <span className="text-ink-primary shrink-0 font-mono">
                    {ext.on === "slash" ? "/" : ""}
                    {ext.name || <span className="text-ink-tertiary italic">unnamed</span>}
                  </span>
                  <span className="text-ink-secondary shrink-0">{trigger.label}</span>
                  <span className="text-ink-secondary truncate">{ext.description || summarizeProps(ext)}</span>
                </button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setOpenIndex(i)}>
                  <Pencil className="size-3.5" /> Edit
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)} aria-label="Remove extension">
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={openIndex !== null && !!current} onOpenChange={(o) => !o && setOpenIndex(null)}>
        <Dialog.Content className="max-h-[92vh] w-[min(96vw,46rem)] max-w-[46rem] overflow-y-auto p-6">
          {current && openIndex !== null && (
            <ExtensionEditor
              key={openIndex}
              ext={current}
              agentName={rec.name}
              editing={editing}
              tools={tools}
              onChange={(fn) => update(openIndex, fn)}
              onRemove={() => remove(openIndex)}
              onDone={() => setOpenIndex(null)}
            />
          )}
        </Dialog.Content>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------- editor

function ExtensionEditor({
  ext,
  agentName,
  editing,
  tools,
  onChange,
  onRemove,
  onDone,
}: {
  ext: ExtensionRec;
  agentName: string;
  editing: boolean;
  tools: ToolInfo[];
  onChange: (fn: (e: ExtensionRec) => ExtensionRec) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const [testArgs, setTestArgs] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Preview | null>(null);
  const [showStory, setShowStory] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [showRendered, setShowRendered] = useState(false);
  const set = <K extends keyof ExtensionRec>(key: K, value: ExtensionRec[K]) =>
    onChange((e) => ({ ...e, [key]: value }));
  const target = ext.target ?? "message";
  const trigger = TRIGGERS.find((t) => t.value === ext.on) ?? TRIGGERS[0]!;

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

  const part = result?.ok ? result.part : null;
  const story = useMemo(() => {
    if (!part?.plan) return null;
    try {
      const plan = JSON.parse(part.plan) as Plan;
      if (!Array.isArray(plan.steps)) return null;
      const steps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(part.steps ?? {})) steps[k] = safeParse(v);
      return { plan, steps };
    } catch {
      return null;
    }
  }, [part]);
  const output = useMemo(() => (part?.output ? safeParse(part.output) : undefined), [part]);
  const templateScope = useMemo(
    () =>
      ({ input: { args: "", argv: [] as string[] }, output: output ?? {}, steps: story?.steps ?? {} }) as Record<
        string,
        unknown
      >,
    [output, story],
  );

  async function run() {
    if (testing) return;
    setTesting(true);
    try {
      const text = ext.on === "slash" ? `/${ext.name} ${testArgs}`.trim() : undefined;
      setResult(await previewExtensionFn({ data: { agent: agentName, extension: ext, text } }));
    } finally {
      setTesting(false);
    }
  }

  // A failure with no output belongs to the script; with output, to the template.
  const scriptError =
    result && !result.ok
      ? result.error
      : part?.error && part.output === null && part.error.code !== "media_dropped"
        ? part.error.message
        : null;
  const templateError = part?.error && part.output !== null && part.rendered === null ? part.error.message : null;
  const canRun = editing && !!ext.name && !testing;

  return (
    <div className="space-y-6">
      {/* Title, description, run */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Dialog.Title className="sr-only">{ext.name ? `Extension ${ext.name}` : "New extension"}</Dialog.Title>
          <div className="flex items-baseline gap-1">
            {ext.on === "slash" && <span className="text-ink-tertiary font-mono text-lg">/</span>}
            <input
              value={ext.name}
              onChange={(e) => set("name", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              placeholder={ext.on === "slash" ? "report" : "context"}
              aria-label="Extension name"
              autoFocus={!ext.name}
              spellCheck={false}
              className="text-ink-primary placeholder:text-ink-tertiary w-full min-w-0 bg-transparent font-mono text-lg font-semibold outline-none"
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void run()}
            disabled={!canRun}
            title={editing ? "Run the script and render the template against the agent's live tools" : "Save the agent first"}
          >
            <Play className="size-3.5" /> {testing ? "Running…" : "Run"}
          </Button>
        </div>
      </div>

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
              <DropdownMenuLabel>Render into</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={target} onValueChange={(v) => set("target", v as ExtensionRec["target"])}>
                <DropdownMenuRadioItem value="message">The user message</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="instructions">The system prompt</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              {target === "message" ? (
                <>
                  <DropdownMenuLabel>Placement</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={ext.placement ?? "after"}
                    onValueChange={(v) => set("placement", v as ExtensionRec["placement"])}
                  >
                    <DropdownMenuRadioItem value="after">After the user's text</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="before">Before the user's text</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </>
              ) : (
                <>
                  <DropdownMenuLabel>Applies</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={ext.scope ?? "turn"}
                    onValueChange={(v) => set("scope", v as ExtensionRec["scope"])}
                  >
                    <DropdownMenuRadioItem value="turn">This turn only</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="chat">The whole chat</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </>
              )}
            </>
          }
        />
        <Pill
          icon={Eye}
          label={
            ext.reveal === "prompt" ? "User sees the prompt" : ext.reveal === "both" ? "User sees both" : "User sees their text"
          }
          title="What the user sees on their own message"
          menu={
            <DropdownMenuRadioGroup
              value={ext.reveal ?? "command"}
              onValueChange={(v) => set("reveal", v as ExtensionRec["reveal"])}
            >
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
              <DropdownMenuCheckboxItem
                checked={!!ext.allowMutations}
                onCheckedChange={(on) => set("allowMutations", on || undefined)}
              >
                Allow approval-gated (mutating) tools
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={ext.onError === "fail"}
                onCheckedChange={(on) => set("onError", on ? "fail" : undefined)}
              >
                Fail the turn if the script fails
              </DropdownMenuCheckboxItem>
              {ext.on === "chat-start" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Run again</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={String(ext.refresh?.afterMs ?? "")}
                    onValueChange={(v) => set("refresh", v ? { afterMs: Number(v) } : undefined)}
                  >
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

      {/* Script */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <Eyebrow>Script</Eyebrow>
          <Popover>
            <Popover.Trigger render={<Button type="button" variant="ghost" size="sm" className="text-ink-secondary" />}>
              {tools.length} tool{tools.length === 1 ? "" : "s"}
              <ChevronDown className="size-3" />
            </Popover.Trigger>
            <Popover.Content className="w-[26rem] p-2" align="end">
              <ToolsReference
                tools={tools}
                onInsert={(call) => set("script", `${ext.script ? ext.script.replace(/\s*$/, "\n") : ""}${call}`)}
              />
            </Popover.Content>
          </Popover>
        </div>
        <CodeEditor
          value={ext.script ?? ""}
          onChange={(v) => set("script", v || undefined)}
          completions={scriptCompletions}
          ariaLabel="Script"
          height="auto"
          minHeight="160px"
          maxHeight="360px"
          placeholder={
            "// Fetch what the agent always needs first — type a tool name for its parameters.\nconst hours = await clockify_hours({ period: input.args }, { reason: \"this week's hours\" });\nreturn { hours };"
          }
        />
        {!editing && <p className="text-ink-secondary text-xs">Save the agent once to run against its live tools.</p>}
        {(part || scriptError) && (
          <Strip
            tone={scriptError ? "error" : "ok"}
            text={
              scriptError
                ? scriptError
                : `Ran in ${part!.durationMs} ms${part!.calls.length ? ` · called ${part!.calls.map((c) => c.tool).join(", ")}` : ""}${
                    output !== undefined ? ` · ${summarize(output)}` : ""
                  }`
            }
            actions={[
              ...(story ? [{ label: "Story", on: showStory, toggle: () => setShowStory((o) => !o) }] : []),
              ...(part?.output ? [{ label: "Output", on: showOutput, toggle: () => setShowOutput((o) => !o) }] : []),
            ]}
          />
        )}
        {showStory && story && (
          <Panel>
            <PlanStory
              plan={story.plan}
              steps={story.steps}
              output={output}
              tools={tools}
              ran={!!part && part.output !== null}
              error={part?.error && part.error.code !== "media_dropped" ? part.error : null}
            />
          </Panel>
        )}
        {showOutput && part?.output && (
          <Panel>
            <pre className="text-ink-secondary font-mono text-xs whitespace-pre-wrap">{part.output}</pre>
          </Panel>
        )}
      </section>

      {/* Template */}
      <section className="space-y-2">
        <Eyebrow>Template</Eyebrow>
        <LiquidEditor
          value={ext.template ?? ""}
          onChange={(v) => set("template", v || undefined)}
          scope={templateScope}
          ariaLabel="Template"
          height="auto"
          minHeight="120px"
          maxHeight="300px"
          placeholder={"Write the weekly report for {{ input.args }}.\n{% for h in output.hours %}- {{ h.name }}: {{ h.total }}h\n{% endfor %}"}
        />
        {(part?.rendered != null || templateError) && (
          <Strip
            tone={templateError ? "error" : "ok"}
            text={
              templateError
                ? templateError
                : `Rendered ${part!.rendered!.length.toLocaleString()} characters · ${
                    target === "instructions" ? "into the system prompt" : "into the user turn"
                  }`
            }
            actions={part?.rendered != null ? [{ label: "Show", on: showRendered, toggle: () => setShowRendered((o) => !o) }] : []}
          />
        )}
        {showRendered && part?.rendered != null && (
          <Panel>
            <pre className="text-ink-secondary font-mono text-xs whitespace-pre-wrap">{part.rendered}</pre>
          </Panel>
        )}
      </section>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          <Trash2 className="size-3.5" /> Remove
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <span className="text-ink-secondary text-xs font-medium tracking-wide uppercase">{children}</span>
);

/** A property pill: the current value as a small outlined button that opens a menu. */
function Pill({
  icon: Icon,
  label,
  title,
  menu,
}: {
  icon: typeof Terminal;
  label: string;
  title: string;
  menu: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs font-normal" />}
        title={title}
      >
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

/** One line under an editor saying what happened, with inline toggles. */
function Strip({
  tone,
  text,
  actions,
}: {
  tone: "ok" | "error";
  text: string;
  actions: Array<{ label: string; on: boolean; toggle: () => void }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className={cn("min-w-0 break-words", tone === "error" ? "text-destructive" : "text-ink-secondary")}>
        {tone === "error" && <AlertTriangle className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />}
        {text}
      </span>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          aria-pressed={a.on}
          onClick={a.toggle}
          className={cn(
            "rounded-md border px-1.5 py-0.5 transition-colors",
            a.on ? "border-ring bg-base-active text-ink-primary" : "border-primary-border text-ink-secondary hover:bg-input/40",
          )}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

const Panel = ({ children }: { children: React.ReactNode }) => (
  <div className="border-primary-border max-h-[28rem] overflow-auto rounded-lg border p-3">{children}</div>
);

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function moreLabel(ext: ExtensionRec): string {
  const bits: string[] = [];
  if (ext.allowMutations) bits.push("mutations allowed");
  if (ext.onError === "fail") bits.push("fails the turn on error");
  if (ext.on === "chat-start" && ext.refresh?.afterMs) {
    bits.push(
      REFRESH_PRESETS.find((p) => p.ms === ext.refresh!.afterMs)?.label.toLowerCase() ??
        `refresh ${Math.round(ext.refresh.afterMs / 60_000)} min`,
    );
  }
  return bits.length ? bits.join(" · ") : "More";
}

function summarizeProps(ext: ExtensionRec): string {
  const bits = [
    ext.target === "instructions"
      ? `system prompt, ${ext.scope === "chat" ? "whole chat" : "this turn"}`
      : `user message, ${ext.placement === "before" ? "before" : "after"} their text`,
  ];
  const more = moreLabel(ext);
  if (more !== "More") bits.push(more);
  return bits.join(" · ");
}

function ToolsReference({ tools, onInsert }: { tools: ToolInfo[]; onInsert: (call: string) => void }) {
  if (tools.length === 0) {
    return <p className="text-ink-secondary p-1 text-xs">No tools yet — pick connections in the agent form and save.</p>;
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
              {t.defaultApproval && (
                <span className="text-destructive border-destructive/40 rounded border px-1 py-px text-xs">approval-gated</span>
              )}
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
