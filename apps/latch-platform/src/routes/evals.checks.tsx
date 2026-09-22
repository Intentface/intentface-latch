import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { MessageSquareText, Plus, ScrollText, Trash2, X } from "lucide-react";
import { currentPrincipalFn } from "@/lib/server";
import { getChecksFn, getEvalsIndexFn, saveChecksFn } from "@/lib/evals-server";
import { describeCounted } from "@/lib/evals/v2/counted";
import { checkIdFor } from "@/lib/evals/v2/validate";
import type { AnswerShape, AskedCheck, Check, CountedCheck, CountedSpec, Matcher } from "@/lib/evals/v2/model";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import Drawer from "@/components/ui/drawer";
import { EDITOR_DRAWER, EvalsEmpty, EvalsShell, Field, Picker, useOverview, useSetSearch, validateEvalsSearch } from "@/components/evals/shell";

/**
 * What gets judged. Two kinds of check, and the page keeps them visibly
 * apart because they cost and fail differently: a question for the judge
 * (reads the thread, costs a call, can be wrong — hence Trust) and a fact
 * read from the tool log (free, exact, can only be the wrong question).
 *
 * Every save is a new version. Results stay attached to the version that
 * produced them, so rewording a check never rewrites old numbers.
 */
export const Route = createFileRoute("/evals/checks")({
  head: () => ({ meta: [{ title: "Checks · Evals · Latch" }] }),
  validateSearch: validateEvalsSearch,
  beforeLoad: async () => {
    const principal = await currentPrincipalFn();
    if (!principal) throw redirect({ to: "/login" });
  },
  loader: () => getEvalsIndexFn(),
  component: ChecksPage,
});

type Loaded = { id: string; version: number; defaultJudge: string; checks: Check[]; judges: string[] };
type Editing = { draft: Check; isNew: boolean };

function ChecksPage() {
  const index = Route.useLoaderData();
  const search = Route.useSearch();
  const set = useSetSearch();
  const agent = search.agent ?? index[0]?.agent;
  const [overview] = useOverview(agent);
  const rubricId = search.rubric ?? overview?.rubrics[0]?.id;
  const [data, setData] = useState<Loaded | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    setData(null);
    setSaved(null);
    if (agent && rubricId)
      void getChecksFn({ data: { agent, rubricId } }).then(
        (r) => r && setData({ ...r.rubric, checks: JSON.parse(r.rubric.checks) as Check[], judges: r.judges }),
      );
  }, [agent, rubricId]);

  useEffect(() => {
    if (!data || !search.check || editing) return;
    const c = data.checks.find((x) => x.id === search.check);
    if (c) setEditing({ draft: c, isNew: false });
  }, [data, search.check, editing]);

  const close = () => {
    setEditing(null);
    set({ check: undefined });
  };

  const save = async (checks: Check[]) => {
    if (!agent || !data) return "Nothing to save to.";
    const res = await saveChecksFn({ data: { agent, rubricId: data.id, defaultJudge: data.defaultJudge, checks: JSON.stringify(checks) } });
    if (!res.ok) return res.error;
    setData({ ...data, checks, version: res.version });
    setSaved(res.version);
    close();
    return null;
  };

  const add = (kind: Check["kind"]) => {
    if (!data) return;
    const taken = data.checks.map((c) => c.id);
    const draft: Check =
      kind === "asked"
        ? { kind: "asked", id: checkIdFor("new check", taken), label: "", ask: "", shape: { type: "boolean" } }
        : { kind: "counted", id: checkIdFor("new rule", taken), label: "", spec: { op: "called", tool: "" } };
    setEditing({ draft, isNew: true });
  };

  if (!index.length) return <EvalsEmpty />;

  const asked = data?.checks.filter((c): c is AskedCheck => c.kind === "asked") ?? [];
  const counted = data?.checks.filter((c): c is CountedCheck => c.kind === "counted") ?? [];

  return (
    <div className="mx-auto max-w-[1000px] space-y-5 p-6">
      <EvalsShell page="checks" index={index} search={search}>
        <Picker label="Checks">
          <Select id="evals-rubric" value={rubricId ?? ""} onChange={(e) => set({ rubric: e.target.value, check: undefined })}>
            {overview?.rubrics.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </Select>
        </Picker>
      </EvalsShell>

      {data && (
        <>
          <p className="text-ink-tertiary text-sm">
            Version {data.version}. Each save makes a new version; results stay with the version that produced them.
            {saved !== null && (
              <span className="text-ink-secondary">
                {" "}
                Saved as v{saved}. Nothing has judged it yet: run <code>pnpm evals judge</code> to score it.
              </span>
            )}
          </p>

          <CheckGroup
            icon={<MessageSquareText className="size-4" />}
            title="Questions for the judge"
            blurb="Plain-English questions a judge model answers about each thread. They cost a call each and can be wrong, which is what your calls on the Results page measure."
            onAdd={() => add("asked")}
            addLabel="Ask the judge"
          >
            {asked.map((c) => (
              <CheckRow key={c.id} onOpen={() => (setEditing({ draft: c, isNew: false }), set({ check: c.id }))}>
                <div className="text-ink-primary font-medium">{c.label}</div>
                <div className="text-ink-secondary mt-0.5 line-clamp-2">{c.ask}</div>
                <div className="text-ink-tertiary mt-1 text-xs">
                  {shapeSummary(c.shape)} · {c.judge ?? `${data.defaultJudge} (default)`}
                </div>
              </CheckRow>
            ))}
          </CheckGroup>

          <CheckGroup
            icon={<ScrollText className="size-4" />}
            title="Facts from the tool log"
            blurb="Rules read straight from which tools the agent called and how. Free, exact and instant: they cannot misread a thread, only ask the wrong thing."
            onAdd={() => add("counted")}
            addLabel="Add a rule"
          >
            {counted.map((c) => (
              <CheckRow key={c.id} onOpen={() => (setEditing({ draft: c, isNew: false }), set({ check: c.id }))}>
                <div className="text-ink-primary font-medium">{c.label}</div>
                <div className="text-ink-secondary mt-0.5 font-mono text-xs">{readable(c)}</div>
                {c.because && <div className="text-ink-tertiary mt-1 text-xs">Because {c.because}</div>}
              </CheckRow>
            ))}
          </CheckGroup>
        </>
      )}

      <Drawer open={!!editing} onOpenChange={(o) => !o && close()}>
        <Drawer.Content className={EDITOR_DRAWER}>
          {editing && data && (
            <CheckEditor
              key={editing.draft.id}
              initial={editing.draft}
              isNew={editing.isNew}
              judges={data.judges}
              defaultJudge={data.defaultJudge}
              version={data.version}
              taken={data.checks.map((c) => c.id).filter((id) => id !== editing.draft.id)}
              onCancel={close}
              onSave={(c) => save(editing.isNew ? [...data.checks, c] : data.checks.map((x) => (x.id === editing.draft.id ? c : x)))}
              onDelete={() => save(data.checks.filter((x) => x.id !== editing.draft.id))}
            />
          )}
        </Drawer.Content>
      </Drawer>
    </div>
  );
}

function CheckGroup({
  icon,
  title,
  blurb,
  onAdd,
  addLabel,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
  onAdd: () => void;
  addLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-start gap-3">
        <span className="text-ink-secondary mt-0.5">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-ink-primary text-sm font-semibold">{title}</h2>
          <p className="text-ink-tertiary max-w-[70ch] text-xs">{blurb}</p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="smooth-shadow-ring-xs smooth-ring-primary-border text-ink-primary hover:bg-primary-bg-hover flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm"
        >
          <Plus className="size-4" /> {addLabel}
        </button>
      </div>
      <ul className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg divide-primary-border divide-y overflow-hidden rounded-lg">
        {children}
      </ul>
    </section>
  );
}

function CheckRow({ onOpen, children }: { onOpen: () => void; children: React.ReactNode }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="hover:bg-primary-bg-hover focus-visible:bg-primary-bg-hover block w-full px-4 py-3 text-left text-sm outline-none">
        {children}
      </button>
    </li>
  );
}

const shapeSummary = (s: AnswerShape) =>
  s.type === "boolean"
    ? `Yes or no; fails on ${s.bad === "true" ? "yes" : "no"}`
    : s.type === "choice"
      ? `Pick one of ${Object.keys(s.options).length}; fails on ${s.bad.map(human).join(", ")}`
      : `Scale of ${s.levels.length}; fails at ${human(s.levels[s.bad ?? 0]?.name ?? "the bottom")} or below`;

const human = (id: string) => id.replace(/_/g, " ");

/** The rule as a sentence; per-question values read as what they are. */
const readable = (c: CountedCheck) =>
  describeCounted(c).replace(/"?\{\{facts\.(\w+)\}\}"?/g, (_, k: string) => (k === "docs" ? "each question's documents" : `each question's ${k}`));

// ─── The editor ────────────────────────────────────────────────────────────

function CheckEditor({
  initial,
  isNew,
  judges,
  defaultJudge,
  version,
  taken,
  onCancel,
  onSave,
  onDelete,
}: {
  initial: Check;
  isNew: boolean;
  judges: string[];
  defaultJudge: string;
  version: number;
  taken: string[];
  onCancel: () => void;
  onSave: (c: Check) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<Check>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const run = async (fn: () => Promise<string | null>) => {
    setSaving(true);
    setError(await fn());
    setSaving(false);
  };
  // A new check takes its id from its name; an existing one keeps its id, which its results hang on.
  const finished = (): Check => (isNew ? { ...draft, id: checkIdFor(draft.label || "check", taken) } : draft);

  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => onSave(finished()));
      }}
    >
      <Drawer.Header className="border-primary-border border-b px-5">
        <Drawer.Title className="text-ink-primary">
          {isNew ? (draft.kind === "asked" ? "New question for the judge" : "New rule from the tool log") : draft.label || "Check"}
        </Drawer.Title>
        <Drawer.Description className="text-ink-tertiary text-xs">Saving makes version {version + 1}. Version {version} and its results stay as they are.</Drawer.Description>
      </Drawer.Header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <Field id="c-label" label="Name" hint="What the results grid shows. Say what passing means: “Read the document that holds the answer”.">
          <Input id="c-label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} autoFocus={isNew} />
        </Field>

        {draft.kind === "asked" ? (
          <AskedFields check={draft} judges={judges} defaultJudge={defaultJudge} onChange={setDraft} />
        ) : (
          <CountedFields check={draft} onChange={setDraft} />
        )}

        <Field id="c-because" label="Why this check exists" hint="A promise the agent makes, a tool it has, or a failure you saw. Helps whoever edits it next.">
          <Input id="c-because" value={draft.because ?? ""} onChange={(e) => setDraft({ ...draft, because: e.target.value || undefined })} />
        </Field>
      </div>

      <div className="border-primary-border flex items-center gap-2 border-t px-5 py-3">
        {!isNew &&
          (confirmDelete ? (
            <span className="flex items-center gap-2 text-sm">
              <span className="text-ink-secondary">Remove from v{version + 1}?</span>
              <button type="button" disabled={saving} onClick={() => void run(onDelete)} className="font-medium text-red-600 dark:text-red-400">
                Remove
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-ink-tertiary">
                Keep
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} aria-label="Remove check" className="text-ink-tertiary rounded p-1 hover:text-red-600">
              <Trash2 className="size-4" />
            </button>
          ))}
        {error && <span className="min-w-0 flex-1 text-sm text-red-600 dark:text-red-400">{error}</span>}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onCancel} className="text-ink-secondary hover:text-ink-primary px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="bg-ink-primary text-primary-bg rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : `Save as v${version + 1}`}
          </button>
        </div>
      </div>
    </form>
  );
}

function Segmented<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div id={id} role="radiogroup" className="smooth-shadow-ring-xs smooth-ring-primary-border inline-flex rounded-lg p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-1 text-sm",
            value === o.value ? "bg-primary-bg-active text-ink-primary font-medium" : "text-ink-secondary hover:text-ink-primary",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Asked ─────────────────────────────────────────────────────────────────

type Option = { name: string; means: string; bad: boolean };

const optionsOf = (s: AnswerShape): Option[] =>
  s.type === "choice" ? Object.entries(s.options).map(([id, means]) => ({ name: human(id), means, bad: s.bad.includes(id) })) : [];
const optionId = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function AskedFields({
  check,
  judges,
  defaultJudge,
  onChange,
}: {
  check: AskedCheck;
  judges: string[];
  defaultJudge: string;
  onChange: (c: Check) => void;
}) {
  const shape = check.shape;
  const setShape = (s: AnswerShape) => onChange({ ...check, shape: s });
  const switchTo = (type: AnswerShape["type"]) => {
    if (type === shape.type) return;
    if (type === "boolean") setShape({ type: "boolean" });
    if (type === "choice")
      setShape({ type: "choice", options: { good: "It does what was asked", bad: "It does not" }, bad: ["bad"] });
    if (type === "score")
      setShape({
        type: "score",
        levels: [
          { name: "poor", means: "Misses the point" },
          { name: "fair", means: "Partly there" },
          { name: "good", means: "Does it well" },
        ],
        bad: 0,
      });
  };
  const opts = optionsOf(shape);
  const setOpts = (next: Option[]) =>
    setShape({
      type: "choice",
      options: Object.fromEntries(next.map((o) => [optionId(o.name) || "answer", o.means])),
      bad: next.filter((o) => o.bad).map((o) => optionId(o.name) || "answer"),
    });

  return (
    <>
      <Field
        id="c-ask"
        label="Question for the judge"
        hint="Write it as you would brief a colleague reviewing the thread. The judge also sees the question, the tools used, the answer, and the question's good answer and must-nots."
      >
        <Textarea id="c-ask" value={check.ask} onChange={(e) => onChange({ ...check, ask: e.target.value })} rows={4} />
      </Field>

      <Field id="c-shape" label="The judge answers with">
        <Segmented
          id="c-shape"
          value={shape.type}
          onChange={switchTo}
          options={[
            { value: "boolean", label: "Yes or no" },
            { value: "choice", label: "Pick one" },
            { value: "score", label: "A scale" },
          ]}
        />
      </Field>

      {shape.type === "boolean" && (
        <Field id="c-bad" label="It fails when the judge says" hint="Phrase the question so yes is good; then leave this on no.">
          <Segmented
            id="c-bad"
            value={shape.bad ?? "false"}
            onChange={(v) => setShape({ type: "boolean", bad: v })}
            options={[
              { value: "false", label: "No" },
              { value: "true", label: "Yes" },
            ]}
          />
        </Field>
      )}

      {shape.type === "choice" && (
        <Field id="c-options" label="Answers to pick from" hint="The answer the judge picks is the diagnosis, so make each one say what went wrong. Tick the ones that count as a fail.">
          <div id="c-options" className="space-y-2">
            {opts.map((o, i) => (
              <div key={i} className="flex items-start gap-2">
                <Input
                  aria-label={`Answer ${i + 1} name`}
                  value={o.name}
                  onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  className="w-36 shrink-0"
                />
                <Textarea
                  aria-label={`Answer ${i + 1} meaning`}
                  value={o.means}
                  onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, means: e.target.value } : x)))}
                  rows={2}
                  className="min-h-0 min-w-0 flex-1 text-sm"
                />
                <label className="text-ink-secondary flex h-8 shrink-0 items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={o.bad} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, bad: e.target.checked } : x)))} />
                  Fail
                </label>
                <button
                  type="button"
                  aria-label={`Remove answer ${i + 1}`}
                  onClick={() => setOpts(opts.filter((_, j) => j !== i))}
                  className="text-ink-tertiary hover:text-ink-primary flex h-8 items-center"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setOpts([...opts, { name: `answer ${opts.length + 1}`, means: "", bad: false }])}
              className="text-ink-secondary hover:text-ink-primary flex items-center gap-1 text-sm"
            >
              <Plus className="size-4" /> Add an answer
            </button>
          </div>
        </Field>
      )}

      {shape.type === "score" && (
        <Field id="c-levels" label="Levels, worst first" hint="A scale suits “how well”, not “whether”. Everything at or below the fail line fails.">
          <div id="c-levels" className="space-y-2">
            {shape.levels.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-ink-tertiary w-4 text-xs tabular-nums">{i + 1}</span>
                <Input
                  aria-label={`Level ${i + 1} name`}
                  value={l.name}
                  onChange={(e) => setShape({ ...shape, levels: shape.levels.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                  className="w-32 shrink-0"
                />
                <Input
                  aria-label={`Level ${i + 1} meaning`}
                  value={l.means}
                  onChange={(e) => setShape({ ...shape, levels: shape.levels.map((x, j) => (j === i ? { ...x, means: e.target.value } : x)) })}
                  className="min-w-0 flex-1"
                />
                <button
                  type="button"
                  aria-label={`Remove level ${i + 1}`}
                  onClick={() => setShape({ ...shape, levels: shape.levels.filter((_, j) => j !== i), bad: Math.min(shape.bad ?? 0, shape.levels.length - 3) })}
                  className="text-ink-tertiary hover:text-ink-primary"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShape({ ...shape, levels: [...shape.levels, { name: "", means: "" }] })}
                className="text-ink-secondary hover:text-ink-primary flex items-center gap-1 text-sm"
              >
                <Plus className="size-4" /> Add a level
              </button>
              <label className="text-ink-secondary ml-auto flex items-center gap-2 text-xs">
                Fails at or below
                <Select id="c-fail-line" value={String(shape.bad ?? 0)} onChange={(e) => setShape({ ...shape, bad: Number(e.target.value) })}>
                  {shape.levels.slice(0, -1).map((l, i) => (
                    <option key={i} value={i}>
                      {l.name || `level ${i + 1}`}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          </div>
        </Field>
      )}

      <Field id="c-judge" label="Judge" hint="The default is cheap and fast. Pick a bigger model when a check needs real reading.">
        <Select id="c-judge" className="w-full" value={check.judge ?? ""} onChange={(e) => onChange({ ...check, judge: e.target.value || undefined })}>
          <option value="">Default ({defaultJudge})</option>
          {judges.map((j) => (
            <option key={j} value={j}>
              {j}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

// ─── Counted ───────────────────────────────────────────────────────────────

const RULES: { op: CountedSpec["op"]; label: string }[] = [
  { op: "called", label: "Calls a tool" },
  { op: "never_called", label: "Never calls a tool" },
  { op: "called_with", label: "Calls a tool with a certain value" },
  { op: "at_least", label: "Calls a tool at least N times" },
  { op: "at_most", label: "Calls a tool at most N times" },
  { op: "repeated", label: "Never repeats the exact same call" },
  { op: "before", label: "Calls one tool before another" },
  { op: "before_answering", label: "Calls a tool before answering" },
  { op: "stopped_for_approval", label: "Waits for approval on a tool" },
];

function specFor(op: CountedSpec["op"], prev: CountedSpec): CountedSpec {
  const tool = prev.tool;
  switch (op) {
    case "called_with":
      return { op, tool, path: "path" in prev ? prev.path : "", match: "match" in prev ? prev.match : { equals: "" } };
    case "at_least":
    case "at_most":
      return { op, tool, n: "n" in prev ? prev.n : 1 };
    case "before":
      return { op, tool, then: "then" in prev ? prev.then : "" };
    default:
      return { op, tool };
  }
}

type MatchKind = "equals" | "contains" | "matches" | "oneOf";
const kindOf = (m: Matcher): MatchKind => ("equals" in m ? "equals" : "contains" in m ? "contains" : "matches" in m ? "matches" : "oneOf");
const textOf = (m: Matcher) =>
  "equals" in m ? (typeof m.equals === "string" ? m.equals : JSON.stringify(m.equals)) : "contains" in m ? m.contains : "matches" in m ? m.matches : m.oneOf.map(String).join(", ");
/** `equals 3` means the number 3; anything that is not JSON is taken as text. */
const loose = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const matcherOf = (kind: MatchKind, text: string): Matcher =>
  kind === "equals"
    ? { equals: loose(text) }
    : kind === "contains"
      ? { contains: text }
      : kind === "matches"
        ? { matches: text }
        : { oneOf: text.split(",").map((x) => loose(x.trim())).filter((x) => x !== "") };

function CountedFields({ check, onChange }: { check: CountedCheck; onChange: (c: Check) => void }) {
  const s = check.spec;
  const setSpec = (spec: CountedSpec) => onChange({ ...check, spec });
  return (
    <>
      <Field id="c-op" label="Rule">
        <Select id="c-op" className="w-full" value={s.op} onChange={(e) => setSpec(specFor(e.target.value as CountedSpec["op"], s))}>
          {RULES.map((r) => (
            <option key={r.op} value={r.op}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="c-tool" label={s.op === "before" ? "This tool first" : "Tool"} hint="The tool's name as the agent sees it. A * matches anything: linear_* or *_read_file.">
        <Input id="c-tool" value={s.tool} onChange={(e) => setSpec({ ...s, tool: e.target.value })} className="font-mono text-sm" />
      </Field>
      {s.op === "before" && (
        <Field id="c-then" label="Then this tool">
          <Input id="c-then" value={s.then} onChange={(e) => setSpec({ ...s, then: e.target.value })} className="font-mono text-sm" />
        </Field>
      )}
      {(s.op === "at_least" || s.op === "at_most") && (
        <Field id="c-n" label="Number of calls">
          <Input id="c-n" type="number" min={0} value={s.n} onChange={(e) => setSpec({ ...s, n: Number(e.target.value) })} className="w-28" />
        </Field>
      )}
      {s.op === "called_with" && (
        <>
          <Field id="c-path" label="Look at" hint="A field of the call's arguments, like state or issue.id. Start with result. to look at what the tool returned.">
            <Input id="c-path" value={s.path} onChange={(e) => setSpec({ ...s, path: e.target.value })} className="font-mono text-sm" />
          </Field>
          <Field
            id="c-match"
            label="It must"
            hint="Use {{facts.name}} to compare with each question's own value. {{facts.docs}} is the question's list of documents, and every one must match."
          >
            <div className="flex gap-2">
              <Select id="c-match" value={kindOf(s.match)} onChange={(e) => setSpec({ ...s, match: matcherOf(e.target.value as MatchKind, textOf(s.match)) })}>
                <option value="equals">equal</option>
                <option value="contains">contain</option>
                <option value="matches">match the pattern</option>
                <option value="oneOf">be one of (comma-separated)</option>
              </Select>
              <Input
                aria-label="Value"
                value={textOf(s.match)}
                onChange={(e) => setSpec({ ...s, match: matcherOf(kindOf(s.match), e.target.value) })}
                className="min-w-0 flex-1 font-mono text-sm"
              />
            </div>
          </Field>
        </>
      )}
      <div className="bg-primary-bg-hover text-ink-secondary rounded-md px-3 py-2 text-xs">
        <span className="text-ink-tertiary">Passes when </span>
        <span className="font-mono">{s.tool.trim() ? readable(check) : "…name a tool"}</span>
      </div>
    </>
  );
}
