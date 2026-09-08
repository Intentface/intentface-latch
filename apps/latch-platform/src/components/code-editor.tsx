import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cn } from "@/lib/utils";

/**
 * A small CodeMirror editor for authoring tool programs (JS/TS). Client-only —
 * CodeMirror touches the DOM, so before mount we render a plain textarea
 * fallback (also keeps SSR happy). TS highlighting via lang-javascript.
 */
export function CodeEditor({
  value,
  onChange,
  height = "320px",
  className,
  placeholder,
  completions,
  ariaLabel = "Code",
  minHeight,
  maxHeight,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Fixed height, or "auto" to grow with content between `minHeight` and `maxHeight`. */
  height?: string;
  minHeight?: string;
  maxHeight?: string;
  className?: string;
  placeholder?: string;
  /** Extra identifier completions (e.g. the tool names a script may call). */
  completions?: Completion[];
  /** The editor's accessible name (it is a textbox to assistive technology). */
  ariaLabel?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const extensions = useMemo(() => {
    const exts: Extension[] = [
      javascript({ typescript: true }),
      EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
    ];
    if (completions?.length) {
      const source = (ctx: CompletionContext) => {
        const word = ctx.matchBefore(/[A-Za-z_][\w]*/);
        if (!word || (word.from === word.to && !ctx.explicit)) return null;
        return { from: word.from, options: completions, validFor: /^[\w]*$/ };
      };
      exts.push(autocompletion({ override: [source], activateOnTyping: true, icons: false }));
    }
    return exts;
  }, [completions, ariaLabel]);

  if (!mounted) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        style={{ height: height === "auto" ? minHeight : height }}
        className={cn(
          "border-input w-full rounded-lg border bg-transparent px-2.5 py-2 font-mono text-xs",
          className,
        )}
      />
    );
  }

  return (
    <div className={cn("border-input focus-within:ring-ring/50 overflow-hidden rounded-lg border focus-within:ring-3", className)}>
      <CodeMirror
        value={value}
        height={height}
        minHeight={minHeight}
        maxHeight={maxHeight}
        placeholder={placeholder}
        extensions={extensions}
        onChange={onChange}
        basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: false }}
      />
    </div>
  );
}
