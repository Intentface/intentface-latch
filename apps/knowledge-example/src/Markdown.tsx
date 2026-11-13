import { Streamdown } from "streamdown";

/** Markdown without its frontmatter, rendered the way the docs' chat renders answers. */
export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <Streamdown
      controls={false}
      className={`text-sm leading-6 text-zinc-700 dark:text-zinc-300 [&_p]:whitespace-pre-wrap [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_strong]:text-zinc-900 dark:[&_strong]:text-zinc-100 [&_code]:font-mono [&_code]:text-[12.5px] [&_h1]:mt-0 [&_h1]:mb-4 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-6 [&_h2]:mb-1.5 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_h1,&_h2,&_h3]:text-zinc-900 dark:[&_h1,&_h2,&_h3]:text-zinc-100 [&_ul]:list-outside [&_ul]:pl-5 [&_ol]:list-outside [&_ol]:pl-5 [&_li]:py-0.5 ${className}`}
    >
      {children.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")}
    </Streamdown>
  );
}
