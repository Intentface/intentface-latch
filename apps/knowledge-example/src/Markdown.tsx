import ReactMarkdown from "react-markdown";

/** Markdown without its frontmatter. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose">
      <ReactMarkdown>{children.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")}</ReactMarkdown>
    </div>
  );
}
