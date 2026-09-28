import { useCallback, useEffect, useState } from "react";
import Drawer from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Link, useNavigate } from "@tanstack/react-router";
import { createQuestionSetFn, getEvalsOverviewFn } from "@/lib/evals-server";
import type { EvalsOverview } from "@/lib/evals-server";
import { cn } from "@/lib/utils";
import { useEvalsChanged } from "@/components/evals/events";
import { Select } from "@/components/ui/select";
import { EvalsAgentDock, askEvalsAgent } from "@/components/evals/agent-panel";
import { Sparkles } from "lucide-react";

/**
 * What the three Evals pages share: the title, the switch between them, and
 * the agent. Everything a page selects lives in the URL, so a link opens the
 * same view and switching pages keeps the agent and question set.
 */

export type EvalsSearch = {
  agent?: string;
  dataset?: string;
  rubric?: string;
  run?: string;
  check?: string;
  version?: string;
  q?: string;
  /** Compared results, baseline first — `runId|version,runId|version`. */
  cols?: string;
  /** Which column the headline compares with the baseline, by label. */
  focus?: string;
  /** The open view tab, by id; absent = All. */
  view?: string;
};

const KEYS = ["agent", "dataset", "rubric", "run", "check", "version", "q", "cols", "focus", "view"] as const;

export function validateEvalsSearch(s: Record<string, unknown>): EvalsSearch {
  const out: EvalsSearch = {};
  for (const k of KEYS) if (typeof s[k] === "string" && s[k]) out[k] = s[k];
  return out;
}

export type EvalsIndex = { agent: string; datasets: { id: string; name: string }[] }[];

type Page = "results" | "failures";

const PAGES: { page: Page; to: "/evals" | "/evals/failures"; label: string; blurb: string }[] = [
  { page: "results", to: "/evals", label: "Results", blurb: "Your inputs, each configuration's answers to them, and what changed." },
  { page: "failures", to: "/evals/failures", label: "Failures", blurb: "Read threads, say what went wrong, and find the patterns worth measuring." },
];

/** Patch the URL's search without adding a history entry. */
export function useSetSearch() {
  const navigate = useNavigate();
  return useCallback(
    (patch: Partial<EvalsSearch>) => void navigate({ to: ".", search: (s: EvalsSearch) => ({ ...s, ...patch }), replace: true }),
    [navigate],
  );
}

const LAST_AGENT = "latch:evals-agent";

/** The selected agent's question sets and checks. Null while loading or when not editable. */
export function useOverview(agent: string | undefined) {
  const [overview, setOverview] = useState<EvalsOverview | null>(null);
  // Null means two things — still loading, or not an agent you can edit — and the page says different things for each.
  const [unavailable, setUnavailable] = useState(false);
  const reload = useCallback(() => {
    if (agent)
      void getEvalsOverviewFn({ data: agent }).then((o) => {
        setOverview(o);
        setUnavailable(o === null);
      });
  }, [agent]);
  useEffect(() => {
    setOverview(null);
    setUnavailable(false);
    reload();
  }, [reload]);
  useEvalsChanged(reload);
  return [overview, reload, unavailable] as const;
}

export function EvalsShell({
  page,
  index,
  search,
  children,
  actions,
}: {
  page: Page;
  index: EvalsIndex;
  search: EvalsSearch;
  /** This page's own pickers, after the agent. */
  children?: React.ReactNode;
  /** Right-aligned, on the picker row. */
  actions?: React.ReactNode;
}) {
  const set = useSetSearch();
  const agent = search.agent ?? index[0]?.agent;
  const here = PAGES.find((p) => p.page === page)!;
  // The sidebar's links carry no agent: remember the one you had open, and
  // return to it rather than to the first agent in the list.
  useEffect(() => {
    try {
      if (search.agent) localStorage.setItem(LAST_AGENT, search.agent);
      else {
        const kept = localStorage.getItem(LAST_AGENT);
        if (kept && index.some((a) => a.agent === kept)) set({ agent: kept });
      }
    } catch {
      /* private mode: the first agent opens */
    }
  }, [search.agent, index, set]);
  // Carry the subject across pages; a cell or a selected question is page-local.
  const carry = { agent: search.agent, dataset: search.dataset, rubric: search.rubric };

  // One quiet row: what this is, which agent, the page switch. The results start right under it.
  return (
    <header className="flex flex-wrap items-center gap-2.5">
      <h1 className="text-ink-primary mr-1 text-lg font-semibold" title={here.blurb}>
        Evals
      </h1>
      <Picker label="Agent">
        <Select
          id="evals-agent"
          value={agent}
          onChange={(e) => set({ agent: e.target.value, dataset: undefined, rubric: undefined, run: undefined, check: undefined, version: undefined, q: undefined, cols: undefined, focus: undefined })}
        >
          {index.map((x) => (
            <option key={x.agent} value={x.agent}>
              {x.agent}
            </option>
          ))}
        </Select>
      </Picker>
      {children}
      <span className="flex-1" />
      {actions}
      <nav aria-label="Evals pages" className="flex items-center gap-1 text-sm">
        {PAGES.map((p) => (
          <Link
            key={p.page}
            to={p.to}
            search={carry}
            aria-current={p.page === page ? "page" : undefined}
            className={cn(
              "focus-visible:ring-ring rounded-md px-2.5 py-1 outline-none focus-visible:ring-2",
              p.page === page ? "text-ink-primary font-medium" : "text-ink-tertiary hover:text-ink-primary",
            )}
          >
            {p.label}
          </Link>
        ))}
      </nav>
      {agent && (
        <EvalsAgentDock
          context={{ agent, ...(search.dataset ? { questionSet: search.dataset } : {}), ...(search.run ? { run: search.run } : {}), ...(search.rubric ? { checks: search.rubric } : {}) }}
        />
      )}
    </header>
  );
}

/** A picker in the header row: the control speaks for itself; its label is for screen readers. */
export function Picker({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center">
      <span className="sr-only">{label}</span>
      {children}
    </label>
  );
}

export function EvalsEmpty() {
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-6">
      <h1 className="text-ink-primary text-lg font-semibold">Evals</h1>
      <p className="text-ink-secondary text-sm">
        No agent has a question set yet. A question set is a list of things people ask the agent, each with what a good
        answer conveys. Import one, run it against the versions you want to compare, then judge it:
      </p>
      <pre className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg text-ink-secondary overflow-x-auto rounded-lg p-3 text-xs">
        {`pnpm evals import --agent NAME --name QUESTIONS --file questions.json
pnpm evals run    --dataset ID --versions live,@c_ab12 --only 1,2,3
pnpm evals judge  --dataset ID --rubric CHECKS`}
      </pre>
    </div>
  );
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="text-ink-primary block text-sm font-medium">
          {label}
        </label>
      )}
      {children}
      {hint && <p className="text-ink-tertiary text-xs">{hint}</p>}
    </div>
  );
}

/**
 * The editor drawer: floats over everything, inset from the edges like the
 * shadcn drawer, instead of sitting flush against the window.
 */
export const EDITOR_DRAWER =
  "bg-primary-bg smooth-shadow-ring-xs smooth-ring-primary-border inset-y-2 right-2 h-auto w-[calc(100%-1rem)] gap-0 overflow-hidden rounded-xl border-0 outline-none data-closed:translate-x-[calc(100%+1rem)] sm:max-w-xl";

/**
 * Name something new — a question set or a set of checks — in the same inset
 * drawer the editors use. `fields` adds the optional lines a question set has.
 */
export function CreateDrawer({
  open,
  title,
  description,
  withSetFields,
  onClose,
  onCreate,
}: {
  open: boolean;
  title: string;
  description: string;
  withSetFields?: boolean;
  onClose: () => void;
  onCreate: (v: { name: string; audience: string; note: string }) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [audience, setAudience] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) (setName(""), setAudience(""), setNote(""), setError(null));
  }, [open]);
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content className={EDITOR_DRAWER}>
        <form
          className="flex h-full flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            setSaving(true);
            void onCreate({ name, audience, note }).then((err) => (setError(err), setSaving(false)));
          }}
        >
          <Drawer.Header className="border-primary-border border-b px-5">
            <Drawer.Title className="text-ink-primary">{title}</Drawer.Title>
            <Drawer.Description className="text-ink-tertiary text-xs">{description}</Drawer.Description>
          </Drawer.Header>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <Field id="new-name" label="Name">
              <Input id="new-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            {withSetFields && (
              <>
                <Field id="new-audience" label="Who is asking" hint="One line. Steers the judge on register.">
                  <Input id="new-audience" value={audience} onChange={(e) => setAudience(e.target.value)} />
                </Field>
                <Field id="new-note" label="How answers should read" hint="E.g. free-standing advice that never cites its source.">
                  <Textarea id="new-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
                </Field>
              </>
            )}
          </div>
          <div className="border-primary-border flex items-center gap-2 border-t px-5 py-3">
            {error && <span className="min-w-0 flex-1 text-sm text-red-600 dark:text-red-400">{error}</span>}
            <div className="ml-auto flex gap-2">
              <button type="button" onClick={onClose} className="text-ink-secondary hover:text-ink-primary px-3 py-1.5 text-sm">
                Cancel
              </button>
              <button type="submit" disabled={saving || !name.trim()} className="bg-ink-primary text-primary-bg rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50">
                {saving ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </form>
      </Drawer.Content>
    </Drawer>
  );
}

/**
 * An agent with no evals yet: the three steps, and two ways to take the
 * first — write the questions, or have the Evals agent draft them from the
 * agent's own instructions and tools, for you to approve.
 */
export function NoEvalsYet({ agent, onCreated }: { agent: string; onCreated: (datasetId: string) => void }) {
  const [creating, setCreating] = useState(false);
  const draft = () =>
    askEvalsAgent(
      `For ${agent}: it has no evals yet. Read its instructions and tools with read_agent, then draft a question set of 8 realistic questions its users would ask — each with what a good answer conveys, and anything the answer must not do. Say briefly what the set covers, then create it with create_question_set; I will approve it.`,
    );
  return (
    <div className="border-primary-border bg-primary-bg max-w-2xl space-y-5 rounded-lg border px-6 py-5">
      <div className="space-y-1">
        <h2 className="text-ink-primary text-lg font-semibold tracking-tight">{agent} has no evals yet</h2>
        <p className="text-ink-secondary text-sm">
          Evals ask the agent the same questions every time and judge the answers, so versions can be compared on equal terms.
        </p>
      </div>
      <ol className="text-ink-secondary space-y-2 text-sm">
        <li>
          <span className="text-ink-primary font-medium">1. Questions.</span> What people really ask it, each with what a good answer conveys.
        </li>
        <li>
          <span className="text-ink-primary font-medium">2. Checks.</span> Created for you with one starter check. Better ones come from reading
          the first answers on the Failures page.
        </li>
        <li>
          <span className="text-ink-primary font-medium">3. A first run.</span> A few questions on live (and any candidates), priced before it
          starts.
        </li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="bg-ink-primary text-primary-bg h-9 rounded-lg px-4 text-sm font-medium"
        >
          Create a question set
        </button>
        <button
          type="button"
          onClick={draft}
          className="border-primary-border text-ink-primary hover:bg-primary-bg-hover flex h-9 items-center gap-1.5 rounded-lg border px-4 text-sm"
        >
          <Sparkles className="size-4" /> Draft questions with the evals agent
        </button>
      </div>
      <CreateDrawer
        open={creating}
        title="New question set"
        description={`The questions ${agent} is tested on. Add them next, or ask the evals agent to draft them.`}
        withSetFields
        onClose={() => setCreating(false)}
        onCreate={async (v) => {
          const r = await createQuestionSetFn({ data: { agent, ...v } });
          if (!r.ok) return r.error;
          setCreating(false);
          onCreated(r.id);
          return null;
        }}
      />
    </div>
  );
}
