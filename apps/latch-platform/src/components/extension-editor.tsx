import { useMemo, useState } from "react";
import { ChevronDown, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { snippetCompletion } from "@codemirror/autocomplete";
import type { AgentRecord } from "@/lib/agent-form";
import { previewExtensionFn } from "@/lib/server";
import { paramsOf, parseSchema, signatureOf, snippetOf } from "@/lib/tool-signature";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RichSelect } from "@/components/ui/rich-select";
import { Switch } from "@/components/ui/switch";
import { CodeEditor } from "@/components/code-editor";
import { LiquidEditor } from "@/components/liquid-editor";
import { PlanStory, type Plan } from "@/components/plan-story";
import type { ToolInfo } from "@/routes/agents";

/**
 * The agent editor's Extensions section: a compact list in the form, and a
 * wide dialog to edit one.
 *
 * The dialog is laid out as the pipeline a person is actually building —
 * script → output on the left, template → rendered text on the right — with
 * one Run that fills both result slots, so the output sits under the script
 * that produced it and the rendered prompt under the template. Name, trigger,
 * script and template are the whole common case; where the result lands, what
 * the user sees, refresh, mutations and the failure policy live behind
 * "Advanced" with sensible defaults. Edits apply to the form's record as you
 * type — the agent's Save persists them; the dialog only gives room.
 */

type ExtensionRec = NonNullable<AgentRecord["extensions"]>[number];
type Preview = Awaited<ReturnType<typeof previewExtensionFn>>;

const TRIGGERS: Array<{ value: ExtensionRec["on"]; label: string; hint: string }> = [
  { value: "slash", label: "Slash command", hint: "Runs when the user types /name …; the rest of the line is input.args." },
  { value: "chat-start", label: "Chat start", hint: "Runs once per conversation, before the first reply. Refreshable." },
  { value: "every-turn", label: "Every turn", hint: "Runs before every reply. Keep it cheap." },
];

const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="text-ink-secondary text-xs font-medium">{children}</label>
);

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
        <Label>Extensions</Label>
        <Button type="button" variant="ghost" size="sm" onClick={add}>
          <Plus className="size-3.5" /> Add extension
        </Button>
      </div>
      <p className="text-ink-tertiary text-xs">
        A script runs <em>before</em> the model over this agent's tools; a template renders what it
        returned into the prompt. Use one for a slash command, a once-per-chat data loader, or
        every-turn context. The result is stored on the user's message, so the model reads exactly
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
                  <span className="text-ink-tertiary shrink-0">{trigger.label}</span>
                  <span className="text-ink-tertiary truncate">
                    {ext.description || summarize(ext)}
                  </span>
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
        <Dialog.Content className="max-h-[92vh] w-[min(96vw,78rem)] max-w-[78rem] overflow-y-auto p-5">
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
  const [advanced, setAdvanced] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [testText, setTestText] = useState("");
  const [testJson, setTestJson] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Preview | null>(null);
  const [scriptTab, setScriptTab] = useState<"script" | "story" | "input" | "output">("script");
  const [templateTab, setTemplateTab] = useState<"template" | "rendered">("template");
  const set = <K extends keyof ExtensionRec>(key: K, value: ExtensionRec[K]) =>
    onChange((e) => ({ ...e, [key]: value }));
  const target = ext.target ?? "message";
  const trigger = TRIGGERS.find((t) => t.value === ext.on) ?? TRIGGERS[0]!;

  // Script completions: each tool as a snippet with its required parameters as
  // tab stops, the full signature + parameter docs in the info card.
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

  // Template completions come from the last run's real output.
  const templateScope = useMemo(() => {
    let output: unknown = {};
    if (result?.ok && result.part.output) {
      try {
        output = JSON.parse(result.part.output);
      } catch {
        output = {};
      }
    }
    return { input: { args: "", argv: [] as string[] }, output, steps: {} } as Record<string, unknown>;
  }, [result]);

  const testJsonError = useMemo(() => {
    if (!testJson.trim()) return null;
    try {
      JSON.parse(testJson);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [testJson]);

  async function run() {
    if (testing || testJsonError) return;
    setTesting(true);
    try {
      const text = ext.on === "slash" ? testText.trim() || `/${ext.name}` : undefined;
      const input = testJson.trim() ? (JSON.parse(testJson) as unknown) : undefined;
      setResult(await previewExtensionFn({ data: { agent: agentName, extension: ext, text, input } }));
      // Show what the run produced, in both columns: the story on the left
      // (the plan with every step's real value), the rendered text on the right.
      setScriptTab("story");
      setTemplateTab("rendered");
    } finally {
      setTesting(false);
    }
  }

  const part = result?.ok ? result.part : null;
  const story = useMemo(() => {
    if (!part?.plan) return null;
    try {
      const plan = JSON.parse(part.plan) as Plan;
      if (!Array.isArray(plan.steps)) return null;
      const steps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(part.steps ?? {})) {
        try {
          steps[k] = JSON.parse(v);
        } catch {
          steps[k] = v;
        }
      }
      return { plan, steps };
    } catch {
      return null;
    }
  }, [part]);
  // A failure with no output belongs to the script stage; with output, to the template.
  const scriptError = result && !result.ok ? result.error : part?.error && part.output === null && part.error.code !== "media_dropped" ? part.error.message : null;
  const templateError = part?.error && part.output !== null && part.rendered === null ? part.error.message : null;
  const note = part?.error?.code === "media_dropped" ? part.error.message : null;

  return (
    <div className="space-y-4">
      {/* Header: identity + trigger + description; Run controls on the right */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Dialog.Title className="text-sm">
            {ext.on === "slash" ? `/${ext.name || "…"}` : ext.name || "New extension"}
            <span className="text-ink-tertiary ml-2 text-xs font-normal">{trigger.label}</span>
          </Dialog.Title>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_auto_minmax(0,1fr)]">
            <div className="flex items-center gap-1.5">
              {ext.on === "slash" && <span className="text-ink-tertiary font-mono text-sm">/</span>}
              <Input
                value={ext.name}
                onChange={(e) => set("name", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
                placeholder={ext.on === "slash" ? "report" : "context"}
                className="font-mono"
                autoFocus={!ext.name}
              />
            </div>
            <div className="flex gap-1" role="radiogroup" aria-label="Runs">
              {TRIGGERS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={ext.on === t.value}
                  onClick={() => set("on", t.value)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors",
                    ext.on === t.value
                      ? "border-ring bg-base-active text-ink-primary"
                      : "border-input text-ink-secondary hover:bg-input/40",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <Input
              value={ext.description ?? ""}
              onChange={(e) => set("description", e.target.value || undefined)}
              placeholder="What it fetches — shown in the / menu"
            />
          </div>
          <p className="text-ink-tertiary text-xs">{trigger.hint}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void run()}
            disabled={testing || !editing || !ext.name || !!testJsonError}
            title={editing ? "Run the script and render the template against the agent's live tools" : "Save the agent first"}
          >
            <Play className="size-3.5" /> {testing ? "Running…" : "Run"}
          </Button>
        </div>
      </div>
      {!editing && <p className="text-ink-tertiary text-xs">Save the agent once to run against its live tools.</p>}

      {/* Two columns, each a tab strip: script · input · output | template · rendered.
          Run switches both to their result tab; the badge keeps the numbers in view. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="min-w-0 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Tabs
              value={scriptTab}
              onChange={setScriptTab}
              tabs={[
                { value: "script", label: "1 · Script" },
                {
                  value: "story",
                  label: "Story",
                  badge: story ? `${story.plan.steps.length} steps` : undefined,
                  tone: story && scriptError ? "error" : undefined,
                },
                { value: "input", label: "Input", badge: testText.trim() || testJson.trim() ? "set" : undefined },
                {
                  value: "output",
                  label: "Output",
                  badge: part ? `${part.durationMs} ms` : result && !result.ok ? "error" : undefined,
                  tone: scriptError ? "error" : undefined,
                },
              ]}
            />
            {scriptTab === "script" && (
              <button
                type="button"
                className="text-ink-secondary hover:text-ink-primary text-xs underline-offset-2 hover:underline"
                onClick={() => setToolsOpen((o) => !o)}
              >
                {tools.length} tool{tools.length === 1 ? "" : "s"} available
              </button>
            )}
          </div>
          {scriptTab === "script" && (
            <>
              {toolsOpen && (
                <ToolsReference
                  tools={tools}
                  onInsert={(call) => set("script", `${ext.script ? ext.script.replace(/\s*$/, "\n") : ""}${call}`)}
                />
              )}
              <CodeEditor
                value={ext.script ?? ""}
                onChange={(v) => set("script", v || undefined)}
                completions={scriptCompletions}
                height="340px"
                placeholder={"const hours = await clockify_hours({ period: input.args });\nreturn { hours, total: hours.reduce((s, h) => s + h.total, 0) };"}
              />
              <p className="text-ink-tertiary text-xs">
                Call tools with <span className="font-mono">await tool_name({"{…}"})</span> — type a name for its
                parameters. Transform with filter/map/reduce, end with <span className="font-mono">return</span>.
                No loops, no globals; validated before it runs.
              </p>
            </>
          )}
          {scriptTab === "story" && (
            <div className="border-input h-[340px] overflow-auto rounded-lg border p-3">
              {story ? (
                <PlanStory
                  plan={story.plan}
                  steps={story.steps}
                  output={part?.output ? safeParse(part.output) : undefined}
                  tools={tools}
                  ran={!!part && part.output !== null}
                  error={part?.error && part.error.code !== "media_dropped" ? part.error : null}
                />
              ) : (
                <p className="text-ink-tertiary text-xs">
                  {result && !result.ok
                    ? result.error
                    : scriptError
                      ? `The script did not compile: ${scriptError}`
                      : "Run once and the compiled plan appears here as a numbered story, with what each step produced."}
                </p>
              )}
            </div>
          )}
          {scriptTab === "input" && (
            <div className="space-y-2 text-xs">
              {ext.on === "slash" ? (
                <>
                  <Label>Invocation, as the user would type it</Label>
                  <Input
                    value={testText}
                    onChange={(e) => setTestText(e.target.value)}
                    placeholder={`/${ext.name || "name"} week`}
                    className="font-mono"
                  />
                  <p className="text-ink-tertiary">
                    The text after the name becomes <span className="font-mono">input.args</span>; its words{" "}
                    <span className="font-mono">input.argv</span>.
                  </p>
                </>
              ) : (
                <p className="text-ink-tertiary">
                  This extension runs on its own, without a slash invocation. Provide a structured{" "}
                  <span className="font-mono">input</span> below only if your script reads one.
                </p>
              )}
              <Label>Structured input (JSON, optional)</Label>
              <textarea
                value={testJson}
                onChange={(e) => setTestJson(e.target.value)}
                spellCheck={false}
                placeholder={'{ "period": "this-week" }'}
                className={cn(
                  "border-input h-40 w-full rounded-lg border bg-transparent px-2.5 py-2 font-mono text-xs",
                  testJsonError && "border-destructive",
                )}
              />
              {testJsonError && <p className="text-destructive">{testJsonError}</p>}
              <p className="text-ink-tertiary">
                When set, this is <span className="font-mono">input</span> for the run, instead of the parsed text.
              </p>
            </div>
          )}
          {scriptTab === "output" && (
            <ResultPane
              empty="Run to see what the script returns."
              status={part ? `${part.calls.length ? `called ${part.calls.map((c) => c.tool).join(", ")} · ` : ""}${part.durationMs} ms` : undefined}
              error={scriptError}
              body={part?.output ?? null}
            />
          )}
        </section>

        <section className="min-w-0 space-y-1.5">
          <Tabs
            value={templateTab}
            onChange={setTemplateTab}
            tabs={[
              { value: "template", label: "2 · Template" },
              {
                value: "rendered",
                label: "Rendered",
                badge: part?.rendered != null ? `${part.rendered.length} chars` : undefined,
                tone: templateError ? "error" : undefined,
              },
            ]}
          />
          {templateTab === "template" && (
            <>
              <LiquidEditor
                value={ext.template ?? ""}
                onChange={(v) => set("template", v || undefined)}
                scope={templateScope}
                height="340px"
                placeholder={"Write the weekly report for {{ input.args }}.\n{% for h in output.hours %}- {{ h.name }}: {{ h.total }}h\n{% endfor %}"}
              />
              <p className="text-ink-tertiary text-xs">
                Liquid over <span className="font-mono">output</span> (the script's return),{" "}
                <span className="font-mono">input</span> and <span className="font-mono">steps</span>. After a run,{" "}
                <span className="font-mono">output.</span> completes with the real keys. Objects and lists need{" "}
                <span className="font-mono">| json</span> or a loop. Blank = the output as JSON.
              </p>
            </>
          )}
          {templateTab === "rendered" && (
            <ResultPane
              empty="Run to see what the model would read."
              status={target === "instructions" ? "added to the system prompt" : "in the user turn, what the model reads"}
              error={templateError}
              note={note}
              body={part?.rendered ?? null}
            />
          )}
        </section>
      </div>

      {/* Advanced */}
      <div className="border-primary-border rounded-md border">
        <button
          type="button"
          className="text-ink-secondary flex w-full items-center gap-1 px-2 py-1.5 text-left text-xs"
          onClick={() => setAdvanced((o) => !o)}
        >
          <ChevronDown className={cn("size-3 transition-transform", !advanced && "-rotate-90")} />
          Advanced
          <span className="text-ink-tertiary">· {summarize(ext)}</span>
        </button>
        {advanced && (
          <div className="border-primary-border space-y-3 border-t p-2 text-xs">
            <Sentence>
              Render into
              <RichSelect
                value={target}
                onValueChange={(v) => set("target", v as ExtensionRec["target"])}
                options={[
                  { value: "message", label: "the user message", description: "Next to what the user typed" },
                  { value: "instructions", label: "the system prompt", description: "After the agent's instructions" },
                ]}
              />
              {target === "message" ? (
                <>
                  <RichSelect
                    value={ext.placement ?? "after"}
                    onValueChange={(v) => set("placement", v as ExtensionRec["placement"])}
                    options={[
                      { value: "after", label: "after", description: "User text, then the block" },
                      { value: "before", label: "before", description: "Block, then the user text" },
                    ]}
                  />
                  their text.
                </>
              ) : (
                <>
                  for
                  <RichSelect
                    value={ext.scope ?? "turn"}
                    onValueChange={(v) => set("scope", v as ExtensionRec["scope"])}
                    options={[
                      { value: "turn", label: "this turn", description: "Only the turn that ran it" },
                      { value: "chat", label: "the whole chat", description: "Every later turn too" },
                    ]}
                  />
                  .
                </>
              )}
            </Sentence>
            <Sentence>
              The user sees
              <RichSelect
                value={ext.reveal ?? "command"}
                onValueChange={(v) => set("reveal", v as ExtensionRec["reveal"])}
                options={[
                  { value: "command", label: "only their text", description: "The result stays server-side" },
                  { value: "prompt", label: "the rendered prompt", description: "In place of their text" },
                  { value: "both", label: "both", description: "Their text, with the result expandable" },
                ]}
              />
              on their message.
            </Sentence>
            {ext.on === "chat-start" && (
              <Sentence>
                Run again after
                <Input
                  type="number"
                  min={1}
                  value={ext.refresh?.afterMs ? String(Math.round(ext.refresh.afterMs / 60_000)) : ""}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    set("refresh", n > 0 ? { afterMs: n * 60_000 } : undefined);
                  }}
                  placeholder="never"
                  className="h-7 w-20 text-xs"
                />
                minutes, when the chat continues.
              </Sentence>
            )}
            <label className="flex items-center gap-2">
              <Switch checked={!!ext.allowMutations} onCheckedChange={(on) => set("allowMutations", on || undefined)} />
              <span>Allow approval-gated (mutating) tools in the script</span>
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={ext.onError === "fail"} onCheckedChange={(on) => set("onError", on ? "fail" : undefined)} />
              <span>Fail the turn if the script fails (default: tell the model and continue)</span>
            </label>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          <Trash2 className="size-3.5" /> Remove extension
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-ink-tertiary text-xs">Changes apply to the agent form; save the agent to persist.</span>
          <Button type="button" size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** One line of prose with inline controls — reads as a sentence, not a form. */
const Sentence = ({ children }: { children: React.ReactNode }) => (
  <div className="text-ink-secondary flex flex-wrap items-center gap-1.5">{children}</div>
);

function summarize(ext: ExtensionRec): string {
  const bits = [
    ext.target === "instructions"
      ? `system prompt, ${ext.scope === "chat" ? "whole chat" : "this turn"}`
      : `user message, ${ext.placement === "before" ? "before" : "after"} their text`,
    `user sees ${ext.reveal === "prompt" ? "the prompt" : ext.reveal === "both" ? "both" : "only their text"}`,
  ];
  if (ext.allowMutations) bits.push("mutations allowed");
  if (ext.onError === "fail") bits.push("fails the turn on error");
  if (ext.on === "chat-start" && ext.refresh?.afterMs) bits.push(`refresh ${Math.round(ext.refresh.afterMs / 60_000)} min`);
  return bits.join(" · ");
}

/** A small tab strip; a tab may carry a badge (a count, a duration, "error"). */
function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: Array<{ value: T; label: string; badge?: string; tone?: "error" }>;
}) {
  return (
    <div role="tablist" className="flex items-center gap-1">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            "rounded-md px-2 py-1 text-xs transition-colors",
            value === t.value ? "bg-base-active text-ink-primary font-medium" : "text-ink-secondary hover:bg-input/40",
          )}
        >
          {t.label}
          {t.badge && (
            <span className={cn("ml-1.5 text-[10px]", t.tone === "error" ? "text-destructive" : "text-ink-tertiary")}>
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** A result tab's body: the stage's output at full editor height, or its error. */
function ResultPane({
  empty,
  status,
  body,
  error,
  note,
}: {
  empty: string;
  status?: string;
  body: string | null;
  error?: string | null;
  note?: string | null;
}) {
  return (
    <div className="border-input flex h-[340px] flex-col overflow-hidden rounded-lg border text-xs">
      <div className="text-ink-tertiary border-input flex items-center justify-between gap-2 border-b px-2.5 py-1.5">
        <span className="truncate">{status ?? ""}</span>
      </div>
      <div className="flex-1 overflow-auto p-2.5">
        {error && <p className="text-destructive mb-2 whitespace-pre-wrap">{error}</p>}
        {note && <p className="text-ink-tertiary mb-2 whitespace-pre-wrap">{note}</p>}
        {body !== null ? (
          <pre className="text-ink-secondary font-mono whitespace-pre-wrap">{body}</pre>
        ) : (
          !error && <p className="text-ink-tertiary">{empty}</p>
        )}
      </div>
    </div>
  );
}

function ToolsReference({ tools, onInsert }: { tools: ToolInfo[]; onInsert: (call: string) => void }) {
  if (tools.length === 0) {
    return <p className="text-ink-tertiary text-xs">No tools yet — pick connections above and save.</p>;
  }
  return (
    <ul className="border-primary-border max-h-56 space-y-2 overflow-auto rounded-md border p-2 text-xs">
      {tools.map((t) => {
        const schema = parseSchema(t.inputSchemaJson);
        const params = paramsOf(schema);
        return (
          <li key={t.name} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="text-ink-primary font-mono hover:underline"
                title="Insert a call"
                onClick={() => onInsert(`const result = ${snippetOf(t.name, schema).replace(/\$\{(\w+)\}/g, "$1")};`)}
              >
                {signatureOf(t.name, schema)}
              </button>
              {t.defaultApproval && (
                <span className="text-destructive rounded border border-destructive/40 px-1 py-px text-[10px]">
                  approval-gated
                </span>
              )}
            </div>
            {t.description && <p className="text-ink-tertiary">{t.description}</p>}
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

function toolInfoCard(
  t: ToolInfo,
  schema: ReturnType<typeof parseSchema>,
  params: ReturnType<typeof paramsOf>,
): HTMLElement {
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
    g.textContent = "approval-gated: needs “Allow approval-gated tools” on this extension";
    el.appendChild(g);
  }
  return el;
}
