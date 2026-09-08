import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { closePercentBrace, liquid } from "@codemirror/lang-liquid";
import { markdown } from "@codemirror/lang-markdown";
import { autocompletion, closeBrackets, type Completion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
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

  const extensions = useMemo(
    () => [
      liquid({
        base: markdown(),
        variables: variableCompletions(scope ?? {}),
        properties: (path) => propertyCompletions(scope ?? {}, path),
      }),
      closeBrackets(),
      closePercentBrace,
      autocompletion({ activateOnTyping: true, icons: false }),
      liquidChips,
      EditorView.lineWrapping,
    ],
    [scope],
  );

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

/** Every Liquid construct in the visible ranges becomes a chip. */
function buildChips(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        switch (node.name) {
          case "Interpolation":
            builder.add(node.from, node.to, chipOut);
            return false;
          case "Comment":
          case "RawDirective":
          case "InlineComment":
            builder.add(node.from, node.to, chipCmt);
            return false;
          case "Tag":
          case "EndTag":
            builder.add(node.from, node.to, chipTag);
            return false;
          default:
            return undefined;
        }
      },
    });
  }
  return builder.finish();
}

const liquidChips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildChips(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = buildChips(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

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
