import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
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
}: {
  value: string;
  onChange: (v: string) => void;
  height?: string;
  className?: string;
  placeholder?: string;
  /** Extra identifier completions (e.g. the tool names a script may call). */
  completions?: Completion[];
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const extensions = useMemo(() => {
    const exts: Extension[] = [javascript({ typescript: true })];
    if (completions?.length) {
      const source = (ctx: CompletionContext) => {
        const word = ctx.matchBefore(/[A-Za-z_][\w]*/);
        if (!word || (word.from === word.to && !ctx.explicit)) return null;
        return { from: word.from, options: completions, validFor: /^[\w]*$/ };
      };
      exts.push(autocompletion({ override: [source], activateOnTyping: true, icons: false }));
    }
    return exts;
  }, [completions]);

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
    <div className={cn("border-input overflow-hidden rounded-lg border", className)}>
      <CodeMirror
        value={value}
        height={height}
        placeholder={placeholder}
        extensions={extensions}
        onChange={onChange}
        basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: false }}
      />
    </div>
  );
}
