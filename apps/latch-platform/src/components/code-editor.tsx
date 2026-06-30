import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
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
}: {
  value: string;
  onChange: (v: string) => void;
  height?: string;
  className?: string;
  placeholder?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
        extensions={[javascript({ typescript: true })]}
        onChange={onChange}
        basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: false }}
      />
    </div>
  );
}
