import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { FlaskConical, Play, Plus, Sparkles, Trash2 } from "lucide-react";
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
  connectionToolsFn,
  draftEvalCasesFn,
} from "@/lib/server";
import type { EvalCase, EvalRun, JsonValue } from "@/lib/evals/store";
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
 * One expected call per line: `tool` or `tool key=value, key=value`.
 *
 * Deliberately not tied to any particular argument name. An earlier version of
 * this form assumed `path`, which quietly encoded one example agent's document
 * tool into the UI — every other agent's tools (`fetch_top_hn_posts({limit:5})`)
 * could not be expressed at all. Args are matched as a SUBSET of the real call,
 * so naming one key is enough.
 */
function parseExpectedTools(text: string): EvalCase["expected"]["toolCalls"] {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [tool, ...rest] = line.split(/\s+/);
      const args: Record<string, JsonValue> = {};
      for (const pair of rest.join(" ").split(",")) {
        const [k, ...v] = pair.split("=");
        const key = k?.trim();
        const raw = v.join("=").trim();
        if (!key || !raw) continue;
        // Numbers and booleans compare as themselves; everything else is text.
        args[key] = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
      }
      return Object.keys(args).length ? { tool: tool!, args } : { tool: tool! };
    });
  return rows.length ? rows : undefined;
}

const renderExpectedTools = (calls: EvalCase["expected"]["toolCalls"]): string =>
  (calls ?? [])
    .map((c) => {
      const args = Object.entries(c.args ?? {})
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
      return args ? `${c.tool} ${args}` : c.tool;
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
  const [tools, setTools] = useState<string[]>([]);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!agent) return;
    setLoaded(false);
    const [set, vs, rs, ts] = await Promise.all([
      getEvalSetFn({ data: { agent, name: setName } }),
      listAgentVersionsFn({ data: { name: agent, scope: scopeOf.get(agent) ?? "user" } }).catch(
        () => [],
      ),
      listEvalRunsFn({ data: { agent, name: setName, limit: 10 } }),
      // The agent's REAL tools, so the editor's hints describe this agent
      // rather than whichever one the form was first written against.
      connectionToolsFn({ data: agents.find((a) => a.name === agent)?.connections ?? [] }).catch(
        () => [],
      ),
    ]);
    setCases(set?.cases ?? []);
    setVersions(vs as { version: number; createdAt: number }[]);
    setRuns(rs as EvalRun[]);
    setTools((ts as { name: string }[]).map((t) => t.name));
    setLoaded(true);
  }, [agent, setName, scopeOf, agents]);

  useEffect(() => {
    void load();
  }, [load]);

  // Hints come from the agent in front of you, never from an example.
  const toolHint = tools.length ? `${tools[0]} key=value` : "tool_name key=value";
  const forbidHint = tools.length > 1 ? tools[1]! : "tool_name";

  const generate = async () => {
    setBusy(true);
    const res = await draftEvalCasesFn({ data: { agent, brief } });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    // Drafts land UNSAVED, appended: reviewing and cutting is the job.
    setCases((cs) => [...cs, ...res.cases]);
    toast.success(`Drafted ${res.cases.length} case${res.cases.length === 1 ? "" : "s"} — review and save`);
  };

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

      <div className="border-secondary-border space-y-2 rounded border border-dashed p-3">
        <label className="text-ink-tertiary block text-xs">
          Describe what to test — the agent writes the cases, grounded in its real tools
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="It should always fetch before summarising, ask which region when the question is ambiguous, and never act on a destructive request without confirming."
            rows={2}
            className="border-secondary-border text-ink-primary mt-1 w-full resize-none rounded border bg-transparent p-2"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={generate} disabled={busy || !agent} className="gap-1">
            <Sparkles className="size-3.5" />
            Generate cases
          </Button>
          <span className="text-ink-tertiary text-xs">
            {tools.length ? `${tools.length} tools available to this agent` : "no connection tools"}
          </span>
        </div>
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
                  Must call — one per line, <code>tool key=value</code>
                  <textarea
                    value={renderExpectedTools(c.expected.toolCalls)}
                    onChange={(e) => updateExpected(i, { toolCalls: parseExpectedTools(e.target.value) })}
                    placeholder={toolHint}
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
                    placeholder={forbidHint}
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
                  placeholder="Only when no tool check can express it — each line costs a judge call."
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
