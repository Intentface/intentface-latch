import type { FileUIPart, ReasoningUIPart, TextUIPart, UIMessage } from "ai";
import { isStaticToolUIPart } from "ai";
import type { AppUIMessage } from "./types.js";
import type { AskUserInput, AskUserQuestion } from "./ask-user.js";

export type ToolLabels = Record<
  string,
  {
    active: (input: Record<string, unknown>) => string;
    complete: (input: Record<string, unknown>) => string;
  }
>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A tool-call part from a UIMessage: a static `tool-*` part OR a `dynamic-tool`
 * part (MCP / runtime-resolved connection tools, incl. `connect_<name>`).
 */
export type ToolPart =
  | Extract<UIMessage["parts"][number], { type: `tool-${string}` }>
  | Extract<UIMessage["parts"][number], { type: "dynamic-tool" }>;

/** Classifies message parts into coarse groups for chronological rendering. */
export type SegmentType = "reasoning" | "tool" | "text" | "file";

/**
 * A contiguous run of same-typed message parts. Used by the message renderer
 * to group reasoning blocks, tool calls, text chunks, etc.
 */
export type MessageSegment =
  | { type: "reasoning"; parts: ReasoningUIPart[] }
  | { type: "tool"; parts: ToolPart[] }
  | { type: "text"; parts: TextUIPart[] }
  | { type: "file"; parts: FileUIPart[] };

// ---------------------------------------------------------------------------
// Segmentation helpers
// ---------------------------------------------------------------------------

/**
 * Maps a single message part to its segment type.
 * Returns `null` for parts that are rendered separately (e.g. askUser).
 */
export const partSegmentType = (part: UIMessage["parts"][number]): SegmentType | null => {
  if (part.type === "reasoning") return "reasoning";
  if (part.type === "text") return "text";
  if (part.type === "file") return "file";
  if (part.type === "tool-askUser") return null; // rendered separately (questionnaire / answered summary)
  if (part.type === "tool-request_secret") return null; // rendered separately (secret form / saved summary)
  if (part.type === "dynamic-tool") return "tool";
  if (isStaticToolUIPart(part)) return "tool";
  return null;
};

/**
 * Groups an array of message parts into contiguous segments of the same type.
 * Adjacent parts with the same type are merged into a single segment. This
 * preserves chronological order for interleaved rendering (e.g. reasoning
 * interspersed with tool calls).
 */
export const getSegmentedParts = (parts: UIMessage["parts"]): MessageSegment[] => {
  const segments: MessageSegment[] = [];
  for (const part of parts) {
    const segType = partSegmentType(part);
    if (!segType) continue;

    const last = segments.at(-1);
    if (last && "parts" in last && last.type === segType) {
      (last.parts as unknown[]).push(part);
    } else {
      segments.push({ type: segType, parts: [part] } as MessageSegment);
    }
  }
  return segments;
};

// ---------------------------------------------------------------------------
// Turn grouping
// ---------------------------------------------------------------------------

/** A conversational turn: a user message plus its trailing assistant/tool replies. */
export type Turn = { key: string; messages: AppUIMessage[] };

/**
 * Groups messages into turns. A new turn starts at every user message;
 * non-user messages attach to the current turn. A conversation that opens with
 * a non-user message still gets a leading turn so nothing is dropped. The turn
 * key is the first message's id — stable while the trailing assistant message
 * streams, so React keys and entrance animations stay put.
 */
export const groupTurns = (messages: AppUIMessage[]): Turn[] => {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) {
      turns.push({ key: message.id, messages: [message] });
    } else {
      turns[turns.length - 1].messages.push(message);
    }
  }
  return turns;
};

// ---------------------------------------------------------------------------
// Per-message derivation helpers
//
// These extract structured info from segments/parts so the message renderer
// can stay declarative instead of doing inline filter/map chains.
// ---------------------------------------------------------------------------

/** Aggregated text content from all text segments in a message. */
export type TextInfo = {
  parts: TextUIPart[];
  /** Concatenated text content of all text parts. */
  text: string;
};

/** Extracts all text parts from a message and concatenates their content. */
export const getTextInfo = (segments: MessageSegment[]): TextInfo => {
  const parts = segments
    .filter((s): s is MessageSegment & { type: "text" } => s.type === "text")
    .flatMap((s) => s.parts);
  const text = parts.map((p) => p.text).join("");
  return { parts, text };
};

/** Extracts all file attachment parts from segments. */
export const getFileParts = (segments: MessageSegment[]): FileUIPart[] =>
  segments
    .filter((s): s is MessageSegment & { type: "file" } => s.type === "file")
    .flatMap((s) => s.parts);

/** Info about the reasoning + tool "chain of thought" portion of a message. */
export type ChainInfo = {
  /** Reasoning and tool segments in chronological order. */
  segments: MessageSegment[];
  hasTools: boolean;
  /** True when reasoning is present but no tool calls — renders standalone. */
  onlyReasoning: boolean;
};

/**
 * Filters segments to the steps subset (reasoning + tools) and
 * classifies whether tools are present.
 */
export const getChainInfo = (segments: MessageSegment[]): ChainInfo => {
  const chainSegments = segments.filter((s) => s.type === "reasoning" || s.type === "tool");
  const hasTools = chainSegments.some((s) => s.type === "tool");
  const hasReasoning = chainSegments.some((s) => s.type === "reasoning");
  return {
    segments: chainSegments,
    hasTools,
    onlyReasoning: hasReasoning && !hasTools,
  };
};

/** Standalone reasoning info (used when no tools are present). */
export type ReasoningInfo = {
  parts: ReasoningUIPart[];
  texts: string[];
  /** Bold headers extracted from reasoning text (e.g. **Analyzing data**). */
  headers: string[] | undefined;
  isStreaming: boolean;
};

/**
 * Extracts reasoning parts, their text content, bold headers for the
 * collapsible trigger, and whether reasoning is actively streaming.
 */
export const getReasoningInfo = (
  segments: MessageSegment[],
  isMessageStreaming: boolean,
): ReasoningInfo => {
  const parts = segments
    .filter((s): s is MessageSegment & { type: "reasoning" } => s.type === "reasoning")
    .flatMap((s) => s.parts);
  const texts = parts.map((p) => p.text);
  const isStreaming = isMessageStreaming && segments.at(-1)?.type === "reasoning";
  const headers = texts
    .join("\n\n")
    .match(/\*\*(.+?)\*\*/g)
    ?.map((h) => h.replace(/\*\*/g, ""));
  return { parts, texts, headers, isStreaming };
};

/** A single answered ask-user exchange with parsed questions and answers. */
export type AskUserAnswered = {
  toolCallId: string;
  questions: AskUserQuestion[];
  answers: Record<string, string>;
};

/** Ask-user tool call info for a message. */
export type AskUserInfo = {
  /** True when at least one ask-user tool is waiting for user input. */
  isAwaitingInput: boolean;
  /** Answered ask-user exchanges with parsed Q&A pairs. */
  answered: AskUserAnswered[];
};

/**
 * Extracts ask-user tool parts and returns structured info:
 * whether any are awaiting input, and parsed Q&A pairs for answered ones.
 */
export const getAskUserInfo = (allParts: UIMessage["parts"]): AskUserInfo => {
  const parts = allParts.filter(
    (p): p is ToolPart =>
      p.type === "tool-askUser" &&
      "state" in p &&
      (p.state === "input-available" || p.state === "output-available"),
  );

  const answered: AskUserAnswered[] = parts
    .filter((p) => p.state === "output-available")
    .map((p) => {
      const input = p.input as AskUserInput | undefined;
      // The output may arrive as an object (addToolResult) or a JSON string.
      let answers: Record<string, string> = {};
      const out = p.output as unknown;
      if (out && typeof out === "object") {
        answers = out as Record<string, string>;
      } else if (typeof out === "string") {
        try {
          answers = JSON.parse(out) as Record<string, string>;
        } catch {
          // leave empty
        }
      }
      return {
        toolCallId: p.toolCallId,
        questions: input?.questions ?? [],
        answers,
      };
    });

  return {
    isAwaitingInput: parts.some((p) => p.state === "input-available"),
    answered,
  };
};

/** A settled `request_secret` call, for the collapsed summary in the transcript. */
export type SecretRequestAnswered = {
  toolCallId: string;
  title: string;
  /** Vault names written. Never a value — there is none in the part to read. */
  saved: string[];
  /** Non-secret fields the user filled in, label → value. */
  values: { label: string; value: string }[];
  declined: boolean;
};

/**
 * Extracts settled `request_secret` parts. The tool's OUTPUT is the only place
 * a result lives, and by construction it carries names and non-secret values
 * only — so there is nothing here that could leak a credential.
 */
export const getSecretRequestsAnswered = (
  allParts: UIMessage["parts"],
): SecretRequestAnswered[] =>
  allParts
    .filter(
      (p): p is ToolPart =>
        p.type === "tool-request_secret" && "state" in p && p.state === "output-available",
    )
    .map((p) => {
      const input = p.input as { title?: string; fields?: { key: string; label: string }[] } | undefined;
      let out: { saved?: string[]; values?: Record<string, string>; declined?: boolean } = {};
      const raw = p.output as unknown;
      if (raw && typeof raw === "object") {
        out = raw as typeof out;
      } else if (typeof raw === "string") {
        try {
          out = JSON.parse(raw) as typeof out;
        } catch {
          // leave empty
        }
      }
      const labelOf = (key: string) =>
        input?.fields?.find((f) => f.key === key)?.label ?? key;
      return {
        toolCallId: p.toolCallId,
        title: input?.title ?? "Credentials",
        saved: out.saved ?? [],
        values: Object.entries(out.values ?? {}).map(([key, value]) => ({
          label: labelOf(key),
          value,
        })),
        declined: !!out.declined,
      };
    });

// ---------------------------------------------------------------------------
// Source URL helpers
// ---------------------------------------------------------------------------

/** A deduplicated source extracted from `source-url` parts. */
export type SourceInfo = {
  url: string;
  domain: string;
};

/** Aggregated source-url info for a message. */
export type SourcesInfo = {
  sources: SourceInfo[];
  hasSources: boolean;
};

/**
 * Extracts `source-url` parts, deduplicates by hostname (stripping `www.`),
 * and returns an array of unique sources with their display domain.
 */
export const getSourcesInfo = (parts: UIMessage["parts"]): SourcesInfo => {
  const seen = new Set<string>();
  const sources: SourceInfo[] = [];

  for (const part of parts) {
    if (part.type !== "source-url") continue;
    try {
      const url = (part as { url: string }).url;
      const domain = new URL(url).hostname.replace(/^www\./, "");
      if (seen.has(domain)) continue;
      seen.add(domain);
      sources.push({ url, domain });
    } catch {
      // skip malformed URLs
    }
  }

  return { sources, hasSources: sources.length > 0 };
};

// ---------------------------------------------------------------------------
// Reasoning header splitting
// ---------------------------------------------------------------------------

/** A section of reasoning text split by a bold `**Header**` line. */
export type ReasoningSection = { header: string | null; body: string };

/**
 * Splits reasoning text into sections by standalone bold `**Header**` lines.
 * Each header and its following body become a separate section.
 */
export const splitReasoningByHeaders = (texts: string[]): ReasoningSection[] => {
  const combined = texts.join("\n\n");
  const parts = combined.split(/(?=^\*\*[^*]+\*\*$)/m);

  const sections: ReasoningSection[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const headerMatch = trimmed.match(/^\*\*([^*]+)\*\*\s*/);
    if (headerMatch) {
      sections.push({
        header: headerMatch[1].trim(),
        body: trimmed.slice(headerMatch[0].length).trim(),
      });
    } else {
      sections.push({ header: null, body: trimmed });
    }
  }
  return sections;
};

// ---------------------------------------------------------------------------
// Tool label map
//
// Maps tool names to human-readable labels for the steps UI.
// Each entry provides an active (in-progress) and complete (finished) label
// generator that receives the tool's input for dynamic text.
// ---------------------------------------------------------------------------

export const DEFAULT_TOOL_LABELS: ToolLabels = {
  create_connection: {
    active: (i) => `Creating the ${i.name ?? "connection"} connection`,
    complete: (i) => `Created the ${i.name ?? "connection"} connection`,
  },
  delete_connection: {
    active: (i) => `Deleting the ${i.name ?? "connection"} connection`,
    complete: (i) => `Deleted the ${i.name ?? "connection"} connection`,
  },
  connect_connection: {
    active: (i) => `Connecting ${i.name ?? "the integration"}`,
    complete: (i) => `Connected ${i.name ?? "the integration"}`,
  },
  list_secrets: {
    active: () => "Checking stored credentials",
    complete: () => "Checked stored credentials",
  },
  webSearch: {
    active: (i) => `Searching for '${i.query ?? ""}'`,
    complete: (i) => `Searched for '${i.query ?? ""}'`,
  },
  createArtifact: {
    active: (i) => `Creating '${i.title ?? "Untitled"}'`,
    complete: (i) => `Created '${i.title ?? "Untitled"}'`,
  },
  listDataSources: {
    active: () => "Discovering data sources",
    complete: () => "Discovered data sources",
  },
  connectDataSource: {
    active: (i) => `Connecting to ${i.sourceId ?? "source"}`,
    complete: (i) => `Connected to ${i.sourceId ?? "source"}`,
  },
  queryData: {
    active: () => "Querying data",
    complete: () => "Queried data",
  },
  filterData: {
    active: () => "Filtering results",
    complete: () => "Filtered results",
  },
  aggregateData: {
    active: () => "Aggregating data",
    complete: () => "Aggregated data",
  },
  sortData: {
    active: (i) => `Sorting by ${i.column ?? "column"}`,
    complete: (i) => `Sorted by ${i.column ?? "column"}`,
  },
  computeStats: {
    active: (i) => `Computing stats for ${i.column ?? "column"}`,
    complete: (i) => `Computed stats for ${i.column ?? "column"}`,
  },
  detectAnomalies: {
    active: (i) => `Detecting anomalies in ${i.column ?? "column"}`,
    complete: (i) => `Detected anomalies in ${i.column ?? "column"}`,
  },
  createVisualization: {
    active: (i) => `Creating ${i.chartType ?? ""} chart`,
    complete: (i) => `Created ${i.chartType ?? ""} chart`,
  },
  exportReport: {
    active: (i) => `Exporting report "${i.title ?? ""}"`,
    complete: (i) => `Exported report "${i.title ?? ""}"`,
  },
  save_eval_set: {
    active: (i) => `Saving eval set for ${i.agentName ?? "agent"}`,
    complete: (i) => `Saved eval set for ${i.agentName ?? "agent"}`,
  },
  list_eval_sets: {
    active: () => "Reading eval sets",
    complete: () => "Read eval sets",
  },
  run_evals: {
    active: (i) => `Running evals for ${i.agentName ?? "agent"}`,
    complete: (i) => `Ran evals for ${i.agentName ?? "agent"}`,
  },
  list_eval_runs: {
    active: () => "Reading eval history",
    complete: () => "Read eval history",
  },
};

export const toolLabels = DEFAULT_TOOL_LABELS;
