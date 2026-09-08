import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { liquid, liquidCompletionSource } from "@codemirror/lang-liquid";
import { markdown } from "@codemirror/lang-markdown";
import {
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { cn } from "@/lib/utils";

/**
 * A Liquid template editor: the official CodeMirror Liquid grammar over a
 * markdown base (templates render to prose for the model, not HTML), every
 * `{{ }}` / `{% %}` / comment drawn as a chip so the tags stand out from the
 * text, and completions for tags, filters, and the variables of `scope` —
 * typically the last Test run's output, so `output.` lists real keys.
 * Client-only like `CodeEditor`.
 */
export function LiquidEditor({
  value,
  onChange,
  scope,
  height = "160px",
  className,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Sample data the template renders over — drives variable/property completions. */
  scope?: Record<string, unknown>;
  height?: string;
  className?: string;
  placeholder?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const extensions = useMemo(() => {
    const config = {
      variables: variableCompletions(scope ?? {}),
      properties: (path: readonly string[]) => propertyCompletions(scope ?? {}, path),
    };
    return [
      liquid({ base: markdown(), ...config }),
      autocompletion({
        activateOnTyping: true,
        icons: false,
        override: [delimiterCompletions, liquidCompletionSource(config)],
      }),
      liquidInput,
      liquidChips,
      EditorView.lineWrapping,
    ];
  }, [scope]);

  if (!mounted) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        style={{ height }}
        className={cn(
          "border-input w-full rounded-lg border bg-transparent px-2.5 py-2 font-mono text-xs",
          className,
        )}
      />
    );
  }

  return (
    <div className={cn("border-input liquid-editor overflow-hidden rounded-lg border", className)}>
      <CodeMirror
        value={value}
        height={height}
        placeholder={placeholder}
        extensions={extensions}
        onChange={onChange}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          autocompletion: false,
          closeBrackets: false,
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ chips

const chipOut = Decoration.mark({ class: "cm-liquid-chip cm-liquid-chip-out" });
const chipTag = Decoration.mark({ class: "cm-liquid-chip cm-liquid-chip-tag" });
const chipCmt = Decoration.mark({ class: "cm-liquid-chip cm-liquid-chip-cmt" });

/**
 * Every Liquid construct becomes a chip. Text-based rather than tree-based on
 * purpose: the grammar's node for an empty or half-typed `{{ }}` ends early,
 * which would leave the closing braces outside the chip while the person is
 * still typing. Comment and raw blocks chip as one muted span.
 */
const CONSTRUCT =
  /\{%-?\s*(comment|raw)\b[\s\S]*?\{%-?\s*end\1\s*-?%\}|\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g;

export function buildChips(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  CONSTRUCT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONSTRUCT.exec(text))) {
    const deco = m[1] ? chipCmt : m[0].startsWith("{{") ? chipOut : chipTag;
    builder.add(m.index, m.index + m[0].length, deco);
  }
  return builder.finish();
}

export const liquidChips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildChips(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = buildChips(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// -------------------------------------------------------------------- typing

/**
 * Typing the second `{` of `{{`, or the `%` of `{%`, closes the construct with
 * a space on each side and puts the cursor in the middle, then opens the
 * suggestions — the artifact's behaviour, without a generic bracket closer
 * fighting it.
 */
export function handleLiquidInput(view: EditorView, from: number, to: number, text: string): boolean {
  if (from !== to || (text !== "{" && text !== "%")) return false;
  const line = view.state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  const after = line.text.slice(from - line.from);
  if (!before.endsWith("{")) return false;
  const close = text === "{" ? "}}" : "%}";
  if (after.trimStart().startsWith(close)) return false;
  view.dispatch({
    changes: { from, to, insert: `${text}  ${close}` },
    selection: { anchor: from + 2 },
    userEvent: "input.type",
  });
  startCompletion(view);
  return true;
}

const liquidInput = EditorView.inputHandler.of(handleLiquidInput);

/** A lone `{` offers the two constructs, like the artifact did. */
export function delimiterCompletions(ctx: CompletionContext): CompletionResult | null {
  const brace = ctx.matchBefore(/\{$/);
  if (!brace) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, brace.from - line.from);
  // Only at the start of a construct, not for the `{` inside one already open.
  if (/\{\{[^}]*$|\{%[^%]*$/.test(before)) return null;
  const item = (label: string, detail: string, open: string, close: string): Completion => ({
    label,
    detail,
    apply: (view, _c, from, to) => {
      view.dispatch({
        changes: { from, to, insert: `${open}  ${close}` },
        selection: { anchor: from + open.length + 1 },
      });
      startCompletion(view);
    },
  });
  return {
    from: brace.from,
    options: [item("{{ }}", "output a value", "{{", "}}"), item("{% %}", "tag", "{%", "%}")],
    filter: false,
  };
}

// -------------------------------------------------------------- completions

function describe(v: unknown): string {
  if (Array.isArray(v)) return `array · ${v.length}`;
  if (v === null) return "null";
  if (typeof v === "object") return "object";
  if (typeof v === "string") return v.length > 32 ? `"${v.slice(0, 32)}…"` : `"${v}"`;
  return String(v);
}

function variableCompletions(scope: Record<string, unknown>): Completion[] {
  return Object.entries(scope).map(([label, v]) => ({
    label,
    type: Array.isArray(v) || (v && typeof v === "object") ? "variable" : "constant",
    detail: describe(v),
    boost: label === "output" ? 2 : label === "input" ? 1 : 0,
  }));
}

/** Resolve `a.b.c` in the sample scope; arrays complete as their first item. */
function propertyCompletions(scope: Record<string, unknown>, path: readonly string[]): Completion[] {
  let node: unknown = scope;
  for (const key of path) {
    if (Array.isArray(node)) node = node[0];
    if (!node || typeof node !== "object") return [];
    node = (node as Record<string, unknown>)[key];
  }
  if (Array.isArray(node)) {
    const first = node[0];
    const size: Completion[] = [{ label: "size", type: "property", detail: String(node.length) }];
    if (first && typeof first === "object") {
      return [...size, { label: "first", type: "property", detail: "object" }, { label: "last", type: "property", detail: "object" }];
    }
    return size;
  }
  if (!node || typeof node !== "object") return [];
  return Object.entries(node as Record<string, unknown>).map(([label, v]) => ({
    label,
    type: "property",
    detail: describe(v),
  }));
}
