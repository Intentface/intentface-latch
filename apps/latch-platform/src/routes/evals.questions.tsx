import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Plus, Search, Trash2 } from "lucide-react";
import { currentPrincipalFn } from "@/lib/server";
import { getEvalsIndexFn, getQuestionsFn, saveQuestionsFn } from "@/lib/evals-server";
import { nextInputId } from "@/lib/evals/v2/validate";
import type { EditableQuestion } from "@/lib/evals/v2/validate";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import Drawer from "@/components/ui/drawer";
import { EDITOR_DRAWER, EvalsEmpty, EvalsShell, Field, Picker, useOverview, useSetSearch, validateEvalsSearch } from "@/components/evals/shell";

/**
 * The questions a set asks. A list you can scan — which ones lack a reference
 * answer shows at a glance — and a drawer to edit one. Saving writes the set;
 * a question keeps its id, which is what its past results hang on.
 */
export const Route = createFileRoute("/evals/questions")({
  head: () => ({ meta: [{ title: "Questions · Evals · Latch" }] }),
  validateSearch: validateEvalsSearch,
  beforeLoad: async () => {
    const principal = await currentPrincipalFn();
    if (!principal) throw redirect({ to: "/login" });
  },
  loader: () => getEvalsIndexFn(),
  component: QuestionsPage,
});

type Loaded = NonNullable<Awaited<ReturnType<typeof getQuestionsFn>>>;
type Editing = { kind: "question"; draft: EditableQuestion; isNew: boolean } | { kind: "set" };

function QuestionsPage() {
  const index = Route.useLoaderData();
  const search = Route.useSearch();
  const set = useSetSearch();
  const agent = search.agent ?? index[0]?.agent;
  const [overview] = useOverview(agent);
  const datasetId = search.dataset ?? overview?.datasets[0]?.id;
  const [data, setData] = useState<Loaded | null>(null);
  const [filter, setFilter] = useState("");
  // An existing question is open when the URL names it — the URL is the only
  // record, so closing cannot race a second copy. Local state holds only what
  // has no id in the URL yet: a new question, or the set's details.
  const [local, setLocal] = useState<Editing | null>(null);

  useEffect(() => {
    setData(null);
    if (agent && datasetId) void getQuestionsFn({ data: { agent, datasetId } }).then(setData);
  }, [agent, datasetId]);

  const selected = search.q ? data?.questions.find((x) => x.id === search.q) : undefined;
  const editing: Editing | null = local ?? (selected ? { kind: "question", draft: selected, isNew: false } : null);
  // Keep the last content while the drawer animates shut.
  const last = useRef(editing);
  if (editing) last.current = editing;
  const inDrawer = editing ?? last.current;

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const qs = data?.questions ?? [];
    return f ? qs.filter((q) => `${q.id} ${q.prompt} ${q.answer}`.toLowerCase().includes(f)) : qs;
  }, [data, filter]);

  const close = () => {
    setLocal(null);
    if (search.q) set({ q: undefined });
  };

  /** Save the whole set with one question replaced, added or removed. */
  const save = async (questions: EditableQuestion[], meta?: { audience: string; note: string }) => {
    if (!agent || !datasetId || !data) return "Nothing to save to.";
    const res = await saveQuestionsFn({
      data: {
        agent,
        datasetId,
        audience: meta?.audience ?? data.dataset.audience,
        note: meta?.note ?? data.dataset.note,
        questions,
      },
    });
    if (!res.ok) return res.error;
    setData({ dataset: { ...data.dataset, ...meta }, questions: res.questions });
    close();
    return null;
  };

  if (!index.length) return <EvalsEmpty />;

  const missingAnswers = data?.questions.filter((q) => !q.answer).length ?? 0;

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 p-6">
      <EvalsShell
        page="questions"
        index={index}
        search={search}
        actions={
          data && (
            <>
              <button
                type="button"
                onClick={() => setLocal({ kind: "set" })}
                className="text-ink-secondary hover:text-ink-primary smooth-shadow-ring-xs smooth-ring-primary-border h-8 rounded-lg px-3 text-sm"
              >
                About this set
              </button>
              <button
                type="button"
                onClick={() =>
                  setLocal({
                    kind: "question",
                    isNew: true,
                    draft: { id: nextInputId(data.questions), prompt: "", followUps: [], answer: "", mustNot: [], docs: [], extra: "{}" },
                  })
                }
                className="bg-ink-primary text-primary-bg flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium"
              >
                <Plus className="size-4" /> Add question
              </button>
            </>
          )
        }
      >
        <Picker label="Question set">
          <Select id="evals-dataset" value={datasetId ?? ""} onChange={(e) => set({ dataset: e.target.value, q: undefined })}>
            {overview?.datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Picker>
      </EvalsShell>

      {data && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="relative">
              <span className="sr-only">Filter questions</span>
              <Search className="text-ink-tertiary pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input id="evals-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="w-60 pl-8" />
            </label>
            <span className="text-ink-tertiary">
              {data.questions.length} questions
              {missingAnswers > 0 && (
                <span className="text-amber-700 dark:text-amber-400"> · {missingAnswers} without a good answer, so "got it right" cannot be judged</span>
              )}
            </span>
          </div>

          <div className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg overflow-x-auto rounded-lg">
            <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-ink-secondary text-left text-xs">
                  <th className="w-12 px-4 py-2.5 font-medium">#</th>
                  <th className="px-3 py-2.5 font-medium">Question</th>
                  <th className="w-[34%] px-3 py-2.5 font-medium">A good answer conveys</th>
                  <th className="w-24 px-3 py-2.5 font-medium">Must not</th>
                  <th className="w-24 px-3 py-2.5 font-medium">Documents</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((q) => (
                  <tr
                    key={q.id}
                    onClick={() => set({ q: q.id })}
                    className="hover:bg-primary-bg-hover cursor-pointer align-top"
                  >
                    <td className="border-primary-border text-ink-tertiary border-t px-4 py-2.5 tabular-nums">{q.id}</td>
                    <td className="border-primary-border border-t px-3 py-2.5">
                      <button type="button" className="text-ink-primary line-clamp-2 text-left focus-visible:underline focus-visible:outline-none">
                        {q.prompt}
                      </button>
                      {q.followUps.length > 0 && (
                        <div className="text-ink-tertiary mt-0.5 text-xs">
                          then {q.followUps.length} follow-up{q.followUps.length === 1 ? "" : "s"}
                        </div>
                      )}
                    </td>
                    <td className="border-primary-border border-t px-3 py-2.5">
                      {q.answer ? (
                        <span className="text-ink-secondary line-clamp-2">{q.answer}</span>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-400">Not written yet</span>
                      )}
                    </td>
                    <td className="border-primary-border text-ink-secondary border-t px-3 py-2.5 tabular-nums">{q.mustNot.length || "—"}</td>
                    <td className="border-primary-border text-ink-secondary border-t px-3 py-2.5 tabular-nums">{q.docs.length || "—"}</td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr>
                    <td colSpan={5} className="text-ink-tertiary border-primary-border border-t px-4 py-6 text-center">
                      {filter ? "No question matches the filter." : "No questions yet. Add the first one."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Drawer open={!!editing} onOpenChange={(o) => !o && close()}>
        <Drawer.Content className={EDITOR_DRAWER}>
          {inDrawer?.kind === "question" && data && (
            <QuestionEditor
              key={inDrawer.draft.id}
              initial={inDrawer.draft}
              isNew={inDrawer.isNew}
              onCancel={close}
              onSave={(q) => save(inDrawer.isNew ? [...data.questions, q] : data.questions.map((x) => (x.id === inDrawer.draft.id ? q : x)))}
              onDelete={() => save(data.questions.filter((x) => x.id !== inDrawer.draft.id))}
            />
          )}
          {inDrawer?.kind === "set" && data && (
            <SetEditor initial={data.dataset} onCancel={close} onSave={(meta) => save(data.questions, meta)} />
          )}
        </Drawer.Content>
      </Drawer>
    </div>
  );
}

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function QuestionEditor({
  initial,
  isNew,
  onCancel,
  onSave,
  onDelete,
}: {
  initial: EditableQuestion;
  isNew: boolean;
  onCancel: () => void;
  onSave: (q: EditableQuestion) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
}) {
  const [prompt, setPrompt] = useState(initial.prompt);
  const [followUps, setFollowUps] = useState(initial.followUps.join("\n"));
  const [answer, setAnswer] = useState(initial.answer);
  const [mustNot, setMustNot] = useState(initial.mustNot.join("\n"));
  const [docs, setDocs] = useState(initial.docs.join("\n"));
  const [extra, setExtra] = useState(initial.extra);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const run = async (fn: () => Promise<string | null>) => {
    setSaving(true);
    setError(await fn());
    setSaving(false);
  };
  const draft = (): EditableQuestion => ({
    id: initial.id,
    prompt,
    followUps: lines(followUps),
    answer,
    mustNot: lines(mustNot),
    docs: lines(docs),
    extra,
  });

  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => onSave(draft()));
      }}
    >
      <Drawer.Header className="border-primary-border border-b px-5">
        <Drawer.Title className="text-ink-primary">{isNew ? "New question" : `Question #${initial.id}`}</Drawer.Title>
        <Drawer.Description className="text-ink-tertiary text-xs">
          {isNew
            ? "It is asked in the next run, of every version you compare."
            : "Past runs keep their results. Edits apply from the next run, and a changed question is worth re-running."}
        </Drawer.Description>
      </Drawer.Header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <Field id="q-prompt" label="Question" hint="Word it the way a real person would ask it.">
          <Textarea id="q-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} autoFocus={isNew} />
        </Field>
        <Field id="q-answer" label="A good answer conveys" hint="The substance, not the wording. The judge compares against this for “got the answer right”.">
          <Textarea id="q-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4} />
        </Field>
        <Field id="q-mustnot" label="Must not" hint="One per line, in plain words: “recommend an accessibility overlay”.">
          <Textarea id="q-mustnot" value={mustNot} onChange={(e) => setMustNot(e.target.value)} rows={2} />
        </Field>
        <Field id="q-docs" label="Documents that hold the answer" hint="One file name per line. Tool-log checks can require that these were read.">
          <Textarea id="q-docs" value={docs} onChange={(e) => setDocs(e.target.value)} rows={2} className="font-mono text-xs" />
        </Field>
        <Field id="q-followups" label="Follow-ups" hint="One per line, sent in the same thread after the first answer.">
          <Textarea id="q-followups" value={followUps} onChange={(e) => setFollowUps(e.target.value)} rows={2} />
        </Field>
        <details className="text-sm">
          <summary className="text-ink-secondary hover:text-ink-primary cursor-pointer text-xs font-medium">Other facts</summary>
          <div className="mt-2">
            <Field id="q-extra" label="" hint={"JSON. Checks read these as {{facts.name}}, for example an issue id a tool must be called with."}>
              <Textarea id="q-extra" value={extra} onChange={(e) => setExtra(e.target.value)} rows={4} className="font-mono text-xs" />
            </Field>
          </div>
        </details>
      </div>

      <div className="border-primary-border flex items-center gap-2 border-t px-5 py-3">
        {!isNew &&
          (confirmDelete ? (
            <span className="flex items-center gap-2 text-sm">
              <span className="text-ink-secondary">Delete #{initial.id}?</span>
              <button type="button" disabled={saving} onClick={() => void run(onDelete)} className="font-medium text-red-600 dark:text-red-400">
                Delete
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-ink-tertiary">
                Keep
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} aria-label="Delete question" className="text-ink-tertiary rounded p-1 hover:text-red-600">
              <Trash2 className="size-4" />
            </button>
          ))}
        {error && <span className="min-w-0 flex-1 text-sm text-red-600 dark:text-red-400">{error}</span>}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onCancel} className="text-ink-secondary hover:text-ink-primary px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={saving || !prompt.trim()} className="bg-ink-primary text-primary-bg rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : isNew ? "Add question" : "Save question"}
          </button>
        </div>
      </div>
    </form>
  );
}

function SetEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: Loaded["dataset"];
  onCancel: () => void;
  onSave: (m: { audience: string; note: string }) => Promise<string | null>;
}) {
  const [audience, setAudience] = useState(initial.audience);
  const [note, setNote] = useState(initial.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        void onSave({ audience, note }).then((err) => (setError(err), setSaving(false)));
      }}
    >
      <Drawer.Header className="border-primary-border border-b px-5">
        <Drawer.Title className="text-ink-primary">{initial.name}</Drawer.Title>
        <Drawer.Description className="text-ink-tertiary text-xs">
          The judge reads both of these before every question in the set.
        </Drawer.Description>
      </Drawer.Header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <Field id="set-audience" label="Who is asking" hint="One line. Steers the judge on register: “a product lead at a client, not an engineer”.">
          <Input id="set-audience" value={audience} onChange={(e) => setAudience(e.target.value)} />
        </Field>
        <Field id="set-note" label="How answers should read" hint="Without this, a judge marks a correct answer down for not citing its source when it never should.">
          <Textarea id="set-note" value={note} onChange={(e) => setNote(e.target.value)} rows={4} />
        </Field>
      </div>
      <div className="border-primary-border flex items-center gap-2 border-t px-5 py-3">
        {error && <span className="min-w-0 flex-1 text-sm text-red-600 dark:text-red-400">{error}</span>}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onCancel} className="text-ink-secondary hover:text-ink-primary px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="bg-ink-primary text-primary-bg rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}
