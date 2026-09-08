import { Fragment, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { ToolInfo } from "@/routes/agents";

/**
 * The compiled plan of an extension script, told as a numbered story: what
 * each step does in plain words, which steps happen at the same time, where
 * the run may stop, where it repeats, and — after a run — what each step
 * actually produced. For the person who owns the agent but does not read
 * code: the script explains itself, the story lets them check it.
 *
 * Sentences come from the author first (a call's `reason`, the tool's own
 * description), and from a few recognisable expression shapes second; anything
 * else falls back to showing the expression.
 */

export interface PlanStep {
  id?: string;
  call?: string;
  args?: unknown;
  let?: string;
  if?: string;
  return?: string;
  each?: string;
  max?: number;
  after?: string[];
  suspend?: boolean;
  onError?: "fail" | "skip";
  reason?: string;
}

export interface Plan {
  intent?: string;
  steps: PlanStep[];
  /** The trailing `return` expression — what the script hands to the template. */
  output?: string;
}

type Step = PlanStep & { id: string; index: number };

// ------------------------------------------------------------- analysis

/** Free identifiers in an expression — skips string literals but reads `${}` holes. */
function freeIdents(src: string): Set<string> {
  const out = new Set<string>();
  const expr = src.startsWith("=") ? src.slice(1) : src;
  const scan = (str: string) => {
    let i = 0;
    const n = str.length;
    while (i < n) {
      const c = str[i]!;
      if (c === "'" || c === '"') {
        i++;
        while (i < n && str[i] !== c) i += str[i] === "\\" ? 2 : 1;
        i++;
      } else if (c === "`") {
        i++;
        while (i < n && str[i] !== "`") {
          if (str[i] === "$" && str[i + 1] === "{") {
            let depth = 1;
            let j = i + 2;
            while (j < n && depth) {
              if (str[j] === "{") depth++;
              else if (str[j] === "}") depth--;
              j++;
            }
            scan(str.slice(i + 2, j - 1));
            i = j;
          } else i += str[i] === "\\" ? 2 : 1;
        }
        i++;
      } else if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(str[j]!)) j++;
        const prev = str.slice(0, i).trimEnd().slice(-1);
        if (prev !== ".") out.add(str.slice(i, j));
        i = j;
      } else i++;
    }
  };
  scan(expr);
  return out;
}

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

interface Graph {
  steps: Step[];
  deps: Record<string, string[]>;
}

export function analyze(plan: Plan): Graph {
  const steps: Step[] = plan.steps.map((s, i) => ({ ...s, id: s.id ?? `step${i}`, index: i }));
  const ids = new Set(steps.map((s) => s.id));
  const deps: Record<string, string[]> = {};
  steps.forEach((s) => {
    const refs = new Set<string>();
    const exprs = [s.let, s.each, s.if, s.return].filter((e): e is string => typeof e === "string");
    collectStrings(s.args).forEach((e) => e.startsWith("=") && exprs.push(e));
    exprs.forEach((e) => freeIdents(e).forEach((t) => ids.has(t) && t !== s.id && refs.add(t)));
    (s.after ?? []).forEach((r) => ids.has(r) && refs.add(r));
    deps[s.id] = [...refs];
  });
  return { steps, deps };
}

/** Rows in the author's order; consecutive independent steps share a row. */
export function storyRows(graph: Graph): Step[][] {
  const rows: Step[][] = [];
  let cur: Step[] | null = null;
  graph.steps.forEach((s) => {
    const isStop = s.return != null;
    const dependsOnRow = !!cur && cur.some((r) => graph.deps[s.id]!.includes(r.id));
    const curIsStop = !!cur && cur[0]!.return != null;
    if (!cur || isStop || curIsStop || dependsOnRow) {
      cur = [s];
      rows.push(cur);
    } else cur.push(s);
  });
  return rows;
}

// --------------------------------------------------------------- wording

const OPS = /\.(filter|map|slice|sort|find|flatMap|reduce|some|every)\(/g;
const opsOf = (expr: string) => [...expr.matchAll(OPS)].map((m) => m[1]!);
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const OPWORD: Record<string, string> = {
  "===": "is", "==": "is", "!==": "is not", "!=": "is not",
  ">": "is more than", "<": "is less than", ">=": "is at least", "<=": "is at most",
};

export function condQuestion(cond: string): string {
  let m = cond.match(/^\s*([\w$.]+)\.length\s*===?\s*0\s*$/);
  if (m) return `Is ${m[1]} empty?`;
  m = cond.match(/^\s*([\w$.]+)\.length\s*>\s*0\s*$/);
  if (m) return `Is there anything in ${m[1]}?`;
  m = cond.match(/^\s*!([\w$.]+)\s*$/);
  if (m) return `Is ${m[1]} missing?`;
  return `Is it true that ${cond}?`;
}

export function predicateWords(pred: string): string | null {
  let m = pred.match(/^\(?\s*([\w$]+)\s*\)?\s*=>\s*\1\.([\w$]+)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);
  if (m) return `where ${m[2]} ${OPWORD[m[3]!]} ${m[4]!.trim()}`;
  m = pred.match(/^\(?\s*([\w$]+)\s*\)?\s*=>\s*(!?)\1\.([\w$]+)$/);
  if (m) return m[2] ? `that are not ${m[3]}` : `that are ${m[3]}`;
  return null;
}

function splitFilter(expr: string) {
  const m = expr.match(/^\s*([\w$.]+)\.filter\(([\s\S]*)\)\s*$/);
  return m ? { src: m[1]!, pred: m[2]! } : null;
}

function parseEach(expr: string) {
  const m = expr.match(/^\s*(?:\()?([\w$.]+)(?:\.slice\([^)]*\))?\)?\.map\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\(?([\s\S]*?)\)?\s*\)\s*$/);
  return m ? { list: m[1]!, item: m[2]!, body: m[3]! } : null;
}

/** The first sentence of a description — tool docs are written for the model, the story is not. */
export function firstSentence(text: string, max = 110): string {
  const t = text.trim().replace(/\s+/g, " ");
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  const first = m ? m[1]! : t;
  return first.length > max ? `${first.slice(0, max - 1).replace(/[\s,;:—-]+$/, "")}…` : first;
}

/**
 * A value as one readable line, with values one level deep: a person checking
 * a step wants "files: 3 items", not the key list.
 */
export function summarize(v: unknown, depth = 0): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "empty list";
    const first = v[0];
    const n = `${v.length} item${v.length === 1 ? "" : "s"}`;
    if (depth > 0) return n;
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const keys = Object.keys(first as object);
      return `${n} of { ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""} }`;
    }
    if (typeof first === "string") return `${n} — ${JSON.stringify(first).slice(0, 40)}${v.length > 1 ? ", …" : ""}`;
    return n;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "empty object";
    if (depth > 0) return `{ ${entries.slice(0, 4).map(([k]) => k).join(", ")}${entries.length > 4 ? ", …" : ""} }`;
    const shown = entries.slice(0, 5).map(([k, val]) => `${k}: ${summarize(val, depth + 1)}`);
    return `{ ${shown.join(", ")}${entries.length > 5 ? ", …" : ""} }`;
  }
  if (typeof v === "string") return v.length > 60 ? `"${v.slice(0, 60)}…"` : `"${v}"`;
  return String(v);
}

const count = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);

// ----------------------------------------------------------------- view

export function PlanStory({
  plan,
  steps,
  tools,
  error,
  ran,
  output,
}: {
  plan: Plan;
  /** Settled step values after a run. */
  steps?: Record<string, unknown>;
  /** The run's final value (what the template received). */
  output?: unknown;
  tools: ToolInfo[];
  /** The run's error, when it failed (`at` names the step). */
  error?: { message: string; code?: string | null; at?: string | null } | null;
  /** Whether a run happened (so absent step values mean "did not run"). */
  ran: boolean;
}) {
  const graph = useMemo(() => analyze(plan), [plan]);
  const rows = useMemo(() => storyRows(graph), [graph]);
  const toolByName = useMemo(() => new Map(tools.map((t) => [t.name, t])), [tools]);
  let n = 0;
  return (
    <div className="space-y-0 text-xs">
      {plan.intent && <p className="text-ink-tertiary mb-3 italic">{plan.intent}</p>}
      {rows.map((row, ri) => {
        n += 1;
        const parallel = row.length > 1;
        return (
          <div key={ri} className="grid grid-cols-[28px_1fr] gap-3">
            <div className="flex flex-col items-center">
              <span className="bg-ink-primary text-primary-bg mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                {n}
              </span>
              {ri < rows.length - 1 && <span className="bg-primary-border my-1.5 w-px flex-1" />}
            </div>
            <div className="pb-4">
              {parallel && <div className="text-ink-tertiary mt-1.5 mb-1.5">Meanwhile — these {row.length} happen together</div>}
              <div className={cn("grid gap-2", parallel && "sm:grid-cols-2")}>
                {row.map((s) => (
                  <StoryCard
                    key={s.id}
                    step={s}
                    deps={graph.deps[s.id]!}
                    depValues={steps}
                    value={steps?.[s.id]}
                    tool={s.call ? toolByName.get(s.call) : undefined}
                    failed={error?.at === s.id ? error : null}
                    ran={ran}
                    nextNum={ri < rows.length - 1 ? n + 1 : null}
                  />
                ))}
              </div>
            </div>
          </div>
        );
      })}
      {plan.output && (
        <div className="grid grid-cols-[28px_1fr] gap-3">
          <div className="flex flex-col items-center">
            <span className="border-ink-primary text-ink-primary mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold">
              ✓
            </span>
          </div>
          <div className="border-primary-border rounded-lg border p-2.5">
            <div className="text-ink-primary font-semibold">Done — hand this to the template</div>
            <div className="text-ink-secondary font-mono break-words">{plan.output}</div>
            {ran && output !== undefined && summarize(output) !== plan.output && (
              <div className="text-ink-secondary mt-1 font-mono break-words">{summarize(output)}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StoryCard({
  step,
  deps,
  depValues,
  value,
  tool,
  failed,
  ran,
  nextNum,
}: {
  step: Step;
  deps: string[];
  depValues?: Record<string, unknown>;
  value: unknown;
  tool?: ToolInfo;
  failed: { message: string; code?: string | null } | null;
  ran: boolean;
  nextNum: number | null;
}) {
  const stop = step.return != null;
  const kind = stop ? "exit" : step.let != null ? "let" : "call";
  const dataDeps = deps.filter((x) => !(step.after ?? []).includes(x));
  const settled = ran && value !== undefined;
  const inCount = dataDeps.length ? count(depValues?.[dataDeps[0]!]) : null;
  const outCount = count(value);

  let title: React.ReactNode;
  let detail: string | null = null;
  let repeat: string | null = null;
  let question: { q: string; yes: string } | null = null;

  if (stop) {
    question = { q: step.if ? condQuestion(step.if) : "Always", yes: `Stop and return ${step.return}` };
  } else if (step.let != null) {
    const ops = opsOf(step.let);
    const f = splitFilter(step.let);
    const words = f ? predicateWords(f.pred) : null;
    const src = f ? f.src : [...freeIdents(step.let)][0] ?? step.id;
    title =
      f && words ? `Keep the ${src} ${words}`
      : ops[0] === "filter" ? `Keep only some of ${src}`
      : ops[0] === "slice" ? `Take part of ${src}`
      : ops[0] === "map" ? `Reshape ${src}`
      : ops[0] === "sort" ? `Sort ${src}`
      : ops[0] === "reduce" ? `Total up ${src}`
      : `Work out ${step.id}`;
    if (!words) detail = step.let;
  } else {
    const desc = step.reason ? cap(step.reason) : tool?.description ? cap(firstSentence(tool.description)) : step.call!;
    const conn = tool?.connection;
    title = (
      <>
        {conn && <span className="text-ink-secondary mr-1.5 text-xs font-semibold tracking-wide uppercase">{conn}</span>}
        {desc}
      </>
    );
    if (step.each) {
      const info = parseEach(step.each);
      const list = info?.list ?? "the list";
      const listCount = settled ? outCount : inCount;
      repeat = listCount != null ? `Repeat for each of the ${listCount} ${list}` : `Repeat for each of the ${list}`;
      detail = info?.body ? `with ${info.body}` : step.each;
    } else if (step.args && typeof step.args === "object") {
      detail = Object.entries(step.args as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${typeof v === "string" && v.startsWith("=") ? v.slice(1) : JSON.stringify(v)}`)
        .join(", ");
    }
    if (step.reason && tool?.description) detail = detail ? `${tool.name} — ${detail}` : tool.name;
  }

  return (
    <div
      className={cn(
        "border-primary-border rounded-lg border p-2.5",
        kind === "call" && "border-l-4 border-l-ring",
        kind === "let" && "bg-input/40",
        kind === "exit" && "border-destructive/40 bg-destructive/5 border-l-4 border-l-destructive/60",
        step.each && "border-dashed border-l-solid",
        failed && "border-destructive",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-px inline-flex size-5 shrink-0 items-center justify-center rounded text-xs",
            kind === "call" && "bg-ring/10 text-ring",
            kind === "let" && "bg-primary-border text-ink-secondary",
            kind === "exit" && "bg-destructive/10 text-destructive",
          )}
          aria-hidden
        >
          {stop ? "■" : step.each ? "↻" : step.let != null ? "⤳" : "→"}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          {repeat && <div className="text-ring font-semibold">{repeat}</div>}
          {question ? (
            <div className="space-y-1">
              <div className="text-ink-primary font-semibold">{question.q}</div>
              <div className="flex gap-2"><b className="text-destructive w-7">Yes</b><span>{question.yes}</span></div>
              <div className="flex gap-2"><b className="w-7">No</b><span>Carry on{nextNum ? ` to step ${nextNum}` : ""}</span></div>
            </div>
          ) : (
            <div className="text-ink-primary font-semibold leading-snug">
              {title}
              {settled && outCount != null && (
                <span className="text-ink-tertiary ml-2 font-mono font-normal">
                  {inCount != null && step.let != null ? `${inCount} → ${outCount}` : outCount}
                </span>
              )}
            </div>
          )}
          {detail && <div className="text-ink-secondary font-mono break-words">{detail}</div>}
          {(dataDeps.length > 0 || step.after?.length || step.max || step.suspend || step.onError === "skip") && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {dataDeps.length > 0 && (
                <Tag>
                  from{" "}
                  {dataDeps.map((x, i) => (
                    <Fragment key={x}>
                      {i > 0 && ", "}
                      <span className="text-ink-primary font-mono">{x}</span>
                    </Fragment>
                  ))}
                </Tag>
              )}
              {step.after?.length ? <Tag>waits for <span className="text-ink-primary font-mono">{step.after.join(", ")}</span></Tag> : null}
              {step.max ? <Tag>at most {step.max} calls</Tag> : null}
              {step.suspend && <Tag tone="warn">pauses and asks you first</Tag>}
              {step.onError === "skip" && <Tag>a failure here is caught</Tag>}
            </div>
          )}
          {failed ? (
            <div className="text-destructive font-mono">
              failed{failed.code ? ` [${failed.code}]` : ""}: {failed.message}
            </div>
          ) : settled ? (
            <div className="text-ink-secondary font-mono">{stop ? "run ended here" : summarize(value)}</div>
          ) : ran && !stop ? (
            <div className="text-ink-secondary font-mono">did not run</div>
          ) : ran && stop ? (
            <div className="text-ink-secondary font-mono">not needed — carried on</div>
          ) : null}
        </div>
        <span className="text-ink-secondary shrink-0 font-mono text-xs">{step.id}</span>
      </div>
    </div>
  );
}

const Tag = ({ children, tone }: { children: React.ReactNode; tone?: "warn" }) => (
  <span
    className={cn(
      "border-primary-border text-ink-secondary inline-flex items-center gap-1 rounded border px-1.5 py-px text-xs",
      tone === "warn" && "border-destructive/40 text-destructive",
    )}
  >
    {children}
  </span>
);
