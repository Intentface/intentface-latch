/**
 * Evals v2 — the model.
 *
 * Eight nouns, all of them words the runtime already uses or a person would
 * use anyway. Input · Dataset · Version · Thread · Turn · Check · Verdict ·
 * Ruling. Nothing here is specific to retrieval, to advisory agents, or to
 * any tool: a Linear agent and a knowledge agent are both instances.
 *
 * The thread is the unit of judging. An input produces exactly one thread
 * (with one or more turns); a production conversation is a thread that
 * nobody wrote an input for. Both go through the same checks.
 */

/** An owner key, same convention as every other latch_* table. */
export type Owner = string;

/**
 * Values an input supplies for checks to read. Free-form on purpose — a check
 * says "compared with the reference answer, …" and reads `facts.answer`. The
 * two named fields are the ones every dataset seems to want; anything else
 * rides along under its own key.
 */
export interface InputFacts {
  /** What a good answer CONVEYS — substance, not wording. Judge-only. */
  answer?: string;
  /** Things the response must not do or say, in plain English. Judge-only. */
  mustNot?: string[];
  /** Things the response must say, in plain English. Judge-only. */
  mustSay?: string[];
  /** The right answer is a polite refusal. */
  decline?: boolean;
  /** Yes/no questions for the grader about this input's answer — "is the tone friendly?". */
  asks?: string[];
  /** Tools this input should (or should never) call, read exactly from the log. */
  calls?: CallExpectation[];
  /** Questions for the judge about this input's answer, of any type — yes/no, choice or score. */
  judged?: JudgedItem[];
  [key: string]: unknown;
}

/**
 * A judge question one input asks of its own answer. The same three types a
 * shared check has; it is graded with the input's other items, under the
 * check that reads them, and can be promoted to a shared check.
 */
export interface JudgedItem {
  ask: string;
  shape: AnswerShape;
  /** Judge model id. Omit → the checks' default. */
  judge?: string;
}

/**
 * One tool call an input expects. `never` inverts it. Every match must hold
 * on the same call: the tool, and each argument or the result.
 */
export interface CallExpectation {
  tool: string;
  never?: boolean;
  match?: CallMatch[];
}

/** `path` is an argument name, a dot path into the args, or `result`. */
export interface CallMatch {
  path: string;
  op: "contains" | "equals" | "not_contains" | "any";
  value?: string;
}

export interface Input {
  id: string;
  /** The first user message. */
  prompt: string;
  /** Further user messages into the same thread, after the first answer. */
  followUps?: string[];
  facts?: InputFacts;
  /** Sent with the first message on every run — the same bytes each time, so answers compare. */
  files?: InputFile[];
}

/** A file an input carries, as chat sends one: a data URL. */
export interface InputFile {
  filename: string;
  mediaType: string;
  /** `data:` URL. */
  url: string;
  /** Bytes, for display. */
  size: number;
}

/**
 * A named set of things to judge. Members are either inputs — a recipe,
 * runnable against any version, grows over time — or threads — a catch, a
 * snapshot of real traffic that cannot be re-run. Everything except running
 * behaves identically for both.
 */
export interface Dataset {
  owner: Owner;
  id: string;
  agentName: string;
  name: string;
  kind: "inputs" | "threads";
  /** Who is asking, in one line. Steers the judge on register. */
  audience?: string;
  /**
   * How answers should read — e.g. "free-standing advice, never cites the
   * source". A judge without this marks a correct answer down for not citing.
   */
  note?: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Checks ────────────────────────────────────────────────────────────────

/**
 * Three answer shapes, and they are the three a spreadsheet already has: a
 * yes/no column, a dropdown, a rating scale.
 */
export type AnswerShape =
  | {
      type: "boolean";
      /** Which answer is the failure. Default "false" — phrase so YES is good. */
      bad?: "true" | "false";
    }
  | {
      type: "choice";
      /** Option id → what it means. The selected option IS the diagnosis. */
      options: Record<string, string>;
      /** Option ids that count as a failure. */
      bad: string[];
    }
  | {
      type: "score";
      /** Rungs, worst → best. */
      levels: { name: string; means: string }[];
      /** Rungs at or below this index fail. Default 0. */
      bad?: number;
    };

/** A plain-English question a judge answers about a thread. */
export interface AskedCheck {
  kind: "asked";
  id: string;
  /** What the grid shows. */
  label: string;
  /** The question, written as you would brief a reviewer. */
  ask: string;
  shape: AnswerShape;
  /** Judge model id. Omit → the rubric's default. */
  judge?: string;
  /** Why this check exists — a promise, a tool, an observed failure. */
  because?: string;
  /**
   * `says`: the question comes from each input — its must say, must not say,
   * should decline and grader questions, each asked as a yes/no. `ask` is
   * only the description then. Skipped for inputs that list none.
   */
  fromInput?: "says";
}

/** How a value in a tool call is compared. */
export type Matcher =
  | { equals: unknown }
  | { contains: string }
  /** A regular expression, JS syntax. */
  | { matches: string }
  | { oneOf: unknown[] };

/**
 * Nine operators over the tool-call log. Not a DSL — each is a dropdown, and
 * each renders as a sentence. `tool` accepts a glob: `linear_*`, `*_read_file`.
 */
export type CountedSpec =
  | { op: "called"; tool: string }
  | { op: "never_called"; tool: string }
  | {
      op: "called_with";
      tool: string;
      /** Dot path into the args (default) or the result: `args.state`, `result.files[0].name`. */
      path: string;
      match: Matcher;
    }
  | { op: "at_least"; tool: string; n: number }
  | { op: "at_most"; tool: string; n: number }
  /** The same tool called twice with identical arguments — thrashing. */
  | { op: "repeated"; tool: string }
  /** `tool` was called before `then` was. Others may interleave. */
  | { op: "before"; tool: string; then: string }
  /** `tool` was called at some point before the final response. */
  | { op: "before_answering"; tool: string }
  /** `tool` hit its approval gate — a fact only the runtime has. */
  | { op: "stopped_for_approval"; tool: string }
  /** The tool calls each input lists under `facts.calls` — skipped for inputs that list none. */
  | { op: "expected_calls" };

/** A fact read from the log by code. Free, exact, cannot be wrong. */
export interface CountedCheck {
  kind: "counted";
  id: string;
  label: string;
  spec: CountedSpec;
  because?: string;
}

export type Check = AskedCheck | CountedCheck;

/**
 * A versioned set of checks for one agent. Re-judging under a new version
 * APPENDS verdicts, so rubric versions can be compared like agent versions —
 * rewording a question no longer destroys the numbers it replaced.
 */
export interface Rubric {
  owner: Owner;
  id: string;
  agentName: string;
  version: number;
  /** Judge for asked checks that name none. Cheap by default. */
  defaultJudge: string;
  checks: Check[];
  createdAt: number;
}

/**
 * A version with one thing changed, run without saving a version: the model,
 * the reasoning effort, or a line added to the instructions. It resolves as
 * `name[@base]~id`, and its fingerprint is that of the changed configuration,
 * so it is its own column, reused and compared like any other.
 */
export interface Variant {
  owner: Owner;
  id: string;
  agentName: string;
  /** `live`, `@draft`, `@3`. */
  base: string;
  /** What the column says, e.g. `live · sonnet-5`. */
  name: string;
  change: { model?: string; effort?: "minimal" | "low" | "medium" | "high"; addInstructions?: string };
  createdAt: number;
}

// ─── Threads, verdicts, rulings ────────────────────────────────────────────

/**
 * An annotation on a thread the runtime already stores. Never a copy: the
 * messages stay in `latch_messages`, this row says why the thread is of
 * interest to evals and which configuration produced it.
 */
export interface ThreadRef {
  owner: Owner;
  /** `latch_chats.id` */
  threadId: string;
  agentName: string;
  datasetId?: string;
  inputId?: string;
  /**
   * The run this thread came from. Every thread of one run was produced
   * under the same conditions; threads from different runs must never be
   * mixed in one comparison — the same agent swung 17%→30% between runs.
   */
  runId?: string;
  /** Which repeat of this (input, version) — 0-based. */
  attempt?: number;
  /** What the column says: `live`, `@3`, `@draft`. */
  version: string;
  /** Hash of everything behaviour can turn on — see `configFingerprint`. */
  configFingerprint: string;
  origin: "run" | "production";
  /** The agent's final answer, kept here so a report never re-reads the thread. */
  answer: string;
  /** Set when the run itself failed — not a failed grade. Such threads are not judged. */
  error?: string;
  durationMs?: number;
  createdAt: number;
}

export interface Verdict {
  threadId: string;
  checkId: string;
  rubricVersion: number;
  /** Model id, or `"counted"` for a code check. */
  judgeId: string;
  /** "true"/"false", the option id, or the rung name. */
  answer: string;
  /** Confidence in the answer GIVEN — not P(true). Counted checks have none. */
  confidence?: number;
  /** Fractional rung, for a score shape. */
  score?: number;
  /** The judge's probability for every label — option ids for a choice, level indexes ("0", "1"…) for a score. */
  probabilities?: Record<string, number>;
  failed: boolean;
  /** Set when the cascade sent this verdict to a bigger judge. */
  escalatedTo?: string;
  createdAt: number;
}

/**
 * A person's call, recorded BESIDE the judge's, never over it. The pair is
 * the only thing that can say whether this judge is reliable on this check.
 */
export interface Ruling {
  threadId: string;
  checkId: string;
  failed: boolean;
  by?: string;
  createdAt: number;
}

/** A configuration under test — what a column in a report is. */
export interface Version {
  /** `live`, `@3`, `@draft`. */
  label: string;
  /** The agent reference that resolves it: `edge-v2`, `edge-v2@3`, `edge-v2@draft`. */
  ref: string;
}
