import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { getEvalsOverviewFn } from "@/lib/evals-server";
import type { EvalsOverview } from "@/lib/evals-server";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import { Sparkles } from "lucide-react";
import { EvalsAgentPanel, usePanelOpen } from "@/components/evals/agent-panel";

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
};

const KEYS = ["agent", "dataset", "rubric", "run", "check", "version", "q"] as const;

export function validateEvalsSearch(s: Record<string, unknown>): EvalsSearch {
  const out: EvalsSearch = {};
  for (const k of KEYS) if (typeof s[k] === "string" && s[k]) out[k] = s[k];
  return out;
}

export type EvalsIndex = { agent: string; datasets: { id: string; name: string }[] }[];

type Page = "results" | "failures" | "questions" | "checks";

const PAGES: { page: Page; to: "/evals" | "/evals/failures" | "/evals/questions" | "/evals/checks"; label: string; blurb: string }[] = [
  { page: "results", to: "/evals", label: "Results", blurb: "How each version answers the same questions, and whether the judge can be believed." },
  { page: "failures", to: "/evals/failures", label: "Failures", blurb: "Read threads, say what went wrong, and find the patterns worth measuring." },
  { page: "questions", to: "/evals/questions", label: "Questions", blurb: "What gets asked. Each question says what a good answer conveys and what it must not do." },
  { page: "checks", to: "/evals/checks", label: "Checks", blurb: "What gets judged. A check is a question for the judge, or a fact read from the tool log." },
];

/** Patch the URL's search without adding a history entry. */
export function useSetSearch() {
  const navigate = useNavigate();
  return useCallback(
    (patch: Partial<EvalsSearch>) => void navigate({ to: ".", search: (s: EvalsSearch) => ({ ...s, ...patch }), replace: true }),
    [navigate],
  );
}

/** The selected agent's question sets and checks. Null while loading or when not editable. */
export function useOverview(agent: string | undefined) {
  const [overview, setOverview] = useState<EvalsOverview | null>(null);
  const reload = useCallback(() => {
    if (agent) void getEvalsOverviewFn({ data: agent }).then(setOverview);
  }, [agent]);
  useEffect(() => {
    setOverview(null);
    reload();
  }, [reload]);
  return [overview, reload] as const;
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
  // Carry the subject across pages; a cell or a selected question is page-local.
  const carry = { agent: search.agent, dataset: search.dataset, rubric: search.rubric };
  const [panel, setPanel] = usePanelOpen();

  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-ink-primary text-lg font-semibold">Evals</h1>
          <p className="text-ink-tertiary text-sm">{here.blurb}</p>
        </div>
        <div className="flex items-center gap-2">
        {!panel && (
          <button
            type="button"
            onClick={() => setPanel(true)}
            className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg text-ink-primary hover:bg-primary-bg-hover flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm"
          >
            <Sparkles className="size-4" /> Ask the evals agent
          </button>
        )}
        <nav aria-label="Evals pages" className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg flex rounded-lg p-0.5">
          {PAGES.map((p) => (
            <Link
              key={p.page}
              to={p.to}
              search={carry}
              aria-current={p.page === page ? "page" : undefined}
              className={cn(
                "focus-visible:ring-ring rounded-md px-3 py-1 text-sm outline-none focus-visible:ring-2",
                p.page === page ? "bg-primary-bg-active text-ink-primary font-medium" : "text-ink-secondary hover:text-ink-primary",
              )}
            >
              {p.label}
            </Link>
          ))}
        </nav>
        </div>
      </div>
      {agent && (
        <EvalsAgentPanel
          open={panel}
          onClose={() => setPanel(false)}
          context={{ agent, ...(search.dataset ? { questionSet: search.dataset } : {}), ...(search.run ? { run: search.run } : {}), ...(search.rubric ? { checks: search.rubric } : {}) }}
        />
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Picker label="Agent">
          <Select
            id="evals-agent"
            value={agent}
            onChange={(e) => set({ agent: e.target.value, dataset: undefined, rubric: undefined, run: undefined, check: undefined, version: undefined, q: undefined })}
          >
            {index.map((x) => (
              <option key={x.agent} value={x.agent}>
                {x.agent}
              </option>
            ))}
          </Select>
        </Picker>
        {children}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Picker({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-ink-secondary text-xs font-medium">{label}</span>
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
pnpm evals run    --dataset ID --versions live,@draft --only 1,2,3
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
