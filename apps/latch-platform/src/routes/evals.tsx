import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { FlaskConical, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  currentPrincipalFn,
  deleteEvalSetFn,
  getEvalSetFn,
  listAgentRecordsFn,
  listAgentVersionsFn,
  listEvalRunsFn,
  listEvalSetsFn,
  runEvalSetFn,
  saveEvalSetFn,
} from "@/lib/server";
import type { EvalCase, EvalRun } from "@/lib/evals/store";
import { Button } from "@/components/ui/button";

/**
 * EXPERIMENTAL. The per-input tier of evals, which has had no page until now.
 *
 * A RUBRIC (the agent page's drawer) is one question asked of every input:
 * "is every claim supported by a document it opened?". A CASE is one input
 * with expectations for THAT input: "asked about VPC limits → must open
 * docs/networking/vpc-limits.md". Only the case tier can say that different
 * questions should read different documents, because only it knows what was
 * asked — which is the whole reason this page exists separately.
 *
 * Runs are pinned to a configuration (`live`, a version, or your draft) and
 * never activate it, so measuring a version cannot move production traffic.
 */
export const Route = createFileRoute("/evals")({
  head: () => ({ meta: [{ title: "Evals · Latch" }] }),
  beforeLoad: async () => {
    if (!(await currentPrincipalFn())) throw redirect({ to: "/login" });
  },
  loader: async () => {
    // Records rather than the agent list: only editable (DB-stored) agents can
    // have an eval set, and a record carries the scope `listVersions` needs.
    const [sets, agents] = await Promise.all([listEvalSetsFn(), listAgentRecordsFn()]);
    return { sets, agents };
  },
  component: EvalsPage,
});

const newCase = (n: number): EvalCase => ({
  id: `case-${n}`,
  name: "",
  input: "",
  expected: {},
});

/** "read_file, search" → the tool names, trimmed and de-duplicated. */
const parseList = (text: string): string[] =>
  [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];

/**
 * One "must open" line: `tool` or `tool path/to/doc.md`. The path becomes an
 * arg matcher, which is what makes "this input should read that document" a
 * free deterministic check rather than a judgement call.
 */
function parseExpectedTools(text: string): EvalCase["expected"]["toolCalls"] {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [tool, ...rest] = line.split(/\s+/);
      const arg = rest.join(" ").trim();
      return arg ? { tool: tool!, args: { path: arg } } : { tool: tool! };
    });
  return rows.length ? rows : undefined;
}

const renderExpectedTools = (calls: EvalCase["expected"]["toolCalls"]): string =>
  (calls ?? [])
    .map((c) => {
      const path = (c.args as { path?: unknown } | undefined)?.path;
      return typeof path === "string" ? `${c.tool} ${path}` : c.tool;
    })
    .join("\n");

function EvalsPage() {
  const { sets, agents } = Route.useLoaderData();
  const editable = agents;
  const scopeOf = useMemo(
    () => new Map(agents.map((a) => [a.name, a.scope])),
    [agents],
  );

  const [agent, setAgent] = useState(sets[0]?.agentName ?? editable[0]?.name ?? "");
  const [setName, setSetName] = useState(sets[0]?.name ?? "default");
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [versions, setVersions] = useState<{ version: number; createdAt: number }[]>([]);
  const [pin, setPin] = useState<string>("live");
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!agent) return;
    setLoaded(false);
    const [set, vs, rs] = await Promise.all([
      getEvalSetFn({ data: { agent, name: setName } }),
      listAgentVersionsFn({ data: { name: agent, scope: scopeOf.get(agent) ?? "user" } }).catch(
        () => [],
      ),
      listEvalRunsFn({ data: { agent, name: setName, limit: 10 } }),
    ]);
    setCases(set?.cases ?? []);
    setVersions(vs as { version: number; createdAt: number }[]);
    setRuns(rs as EvalRun[]);
    setLoaded(true);
  }, [agent, setName, scopeOf]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (i: number, patch: Partial<EvalCase>) =>
    setCases((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const updateExpected = (i: number, patch: Partial<EvalCase["expected"]>) =>
    setCases((cs) => cs.map((c, j) => (j === i ? { ...c, expected: { ...c.expected, ...patch } } : c)));

  const save = async () => {
    setBusy(true);
    const res = await saveEvalSetFn({ data: { agent, name: setName, cases } });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Saved ${cases.length} case${cases.length === 1 ? "" : "s"}`);
  };

  const run = async () => {
    setBusy(true);
    const version = pin === "live" ? undefined : pin === "draft" ? ("draft" as const) : Number(pin);
    const res = await runEvalSetFn({ data: { agent, name: setName, version } });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.ref}: ${res.run.passCount} passed, ${res.run.failCount} failed`);
    setRuns((r) => [res.run as EvalRun, ...r]);
  };

  const remove = async () => {
    if (!confirm(`Delete eval set "${setName}"?`)) return;
    const res = await deleteEvalSetFn({ data: { agent, name: setName } });
    if (!res.ok) return toast.error(res.error);
    setCases([]);
    toast.success("Deleted");
  };

  /** Which configuration produced a run — the label a comparison hangs on. */
  const runLabel = (r: EvalRun): string => {
    const snap = r.agentSnapshot as { name?: string } | null;
    return snap?.name ? `${r.passCount}/${r.passCount + r.failCount}` : "—";
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        <FlaskConical className="size-5" />
        <h1 className="text-lg font-semibold">Evals</h1>
        <span className="text-ink-tertiary text-xs">experimental</span>
      </div>

      <p className="text-ink-tertiary max-w-2xl text-sm">
        A case is one input plus what should happen for <em>that</em> input — which documents it
        should open, which tools it must not call. Runs are pinned to a configuration and never
        make it live.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-ink-tertiary text-xs">
          Agent
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="border-secondary-border text-ink-primary ml-2 rounded border bg-transparent px-2 py-1 text-xs"
          >
            {editable.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-ink-tertiary text-xs">
          Set
          <input
            value={setName}
            onChange={(e) => setSetName(e.target.value)}
            className="border-secondary-border text-ink-primary ml-2 rounded border bg-transparent px-2 py-1 text-xs"
          />
        </label>
        <label className="text-ink-tertiary text-xs">
          Run against
          <select
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="border-secondary-border text-ink-primary ml-2 rounded border bg-transparent px-2 py-1 text-xs"
          >
            <option value="live">live</option>
            <option value="draft">draft</option>
            {versions.map((v) => (
              <option key={v.version} value={String(v.version)}>
                v{v.version}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={run} disabled={busy || !cases.length} className="gap-1">
          <Play className="size-3.5" />
          Run
        </Button>
        <Button variant="secondary" onClick={save} disabled={busy}>
          Save
        </Button>
        <Button variant="ghost" onClick={remove} disabled={busy || !cases.length}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {!loaded && <p className="text-ink-tertiary text-sm">Loading…</p>}

      {loaded && (
        <div className="space-y-3">
          {cases.map((c, i) => (
            <div key={i} className="border-secondary-border space-y-2 rounded border p-3">
              <div className="flex items-center gap-2">
                <input
                  value={c.id}
                  onChange={(e) => update(i, { id: e.target.value })}
                  placeholder="stable-case-id"
                  className="border-secondary-border text-ink-primary w-48 rounded border bg-transparent px-2 py-1 text-xs"
                />
                <input
                  value={c.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  placeholder="what this checks"
                  className="border-secondary-border text-ink-primary min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  aria-label="Remove case"
                  onClick={() => setCases((cs) => cs.filter((_, j) => j !== i))}
                  className="text-ink-tertiary hover:text-ink-primary"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <textarea
                value={c.input}
                onChange={(e) => update(i, { input: e.target.value })}
                placeholder="The user message to send"
                rows={2}
                className="border-secondary-border text-ink-primary w-full resize-none rounded border bg-transparent p-2 text-xs"
              />
              <div className="grid gap-2 md:grid-cols-2">
                <label className="text-ink-tertiary text-xs">
                  Must open — one per line, <code>tool path/to/doc.md</code>
                  <textarea
                    value={renderExpectedTools(c.expected.toolCalls)}
                    onChange={(e) => updateExpected(i, { toolCalls: parseExpectedTools(e.target.value) })}
                    placeholder={"read_file docs/networking/vpc-limits.md"}
                    rows={2}
                    className="border-secondary-border text-ink-primary mt-1 w-full resize-none rounded border bg-transparent p-2"
                  />
                </label>
                <label className="text-ink-tertiary text-xs">
                  Must NOT call — comma separated
                  <input
                    value={(c.expected.forbiddenTools ?? []).join(", ")}
                    onChange={(e) =>
                      updateExpected(i, {
                        forbiddenTools: parseList(e.target.value).length
                          ? parseList(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="delete_stack"
                    className="border-secondary-border text-ink-primary mt-1 w-full rounded border bg-transparent p-2"
                  />
                </label>
              </div>
              <label className="text-ink-tertiary block text-xs">
                Criteria in plain English — one per line, judged by a model
                <textarea
                  value={(c.expected.rubric ?? []).join("\n")}
                  onChange={(e) => {
                    const rubric = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                    updateExpected(i, { rubric: rubric.length ? rubric.slice(0, 5) : undefined });
                  }}
                  placeholder="Every number in the answer appears in a document the agent opened."
                  rows={2}
                  className="border-secondary-border text-ink-primary mt-1 w-full resize-none rounded border bg-transparent p-2"
                />
              </label>
            </div>
          ))}

          <Button
            variant="secondary"
            onClick={() => setCases((cs) => [...cs, newCase(cs.length + 1)])}
            className="gap-1"
          >
            <Plus className="size-3.5" />
            Add case
          </Button>
        </div>
      )}

      {runs.length > 0 && (
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Recent runs</h2>
          <div className="border-secondary-border divide-secondary-border divide-y rounded border text-xs">
            {runs.map((r) => (
              <div key={r.id} className="flex items-center justify-between px-3 py-2">
                <span className="text-ink-tertiary">
                  {new Date(r.createdAt).toLocaleString()} · {r.setName}
                </span>
                <span className={r.failCount ? "text-red-500" : "text-ink-primary"}>
                  {runLabel(r)} passed
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
