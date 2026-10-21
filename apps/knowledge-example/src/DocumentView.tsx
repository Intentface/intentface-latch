import { useEffect, useState } from "react";
import { api, type FileView, type Person } from "./api";
import { Markdown } from "./Markdown";
import { TrustMark } from "./TrustMark";

/** One document, read as the selected person: the same call the agent's read_file makes. */
export function DocumentView({ person, path, revision }: { person: Person; path: string; revision: number }) {
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api.file(person.id, path).then(
      (f) => live && setFile(f),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [person.id, path, revision]);

  const text = file?.lines.join("\n") ?? "";
  const description = /^---\r?\n[\s\S]*?^description:\s?(.+)$[\s\S]*?^---/m.exec(text)?.[1];

  return (
    <div className="h-full overflow-y-auto">
      {/* Left-aligned with a deep left pad, as the docs' document tabs are. */}
      <article className="max-w-2xl px-6 py-7 sm:px-10">
        <p className="mb-3 font-mono text-[12px] text-zinc-500 dark:text-zinc-400">{path}</p>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {file && (
          <>
            <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-zinc-500 dark:text-zinc-400">
              <TrustMark trusted={file.trusted} label />
              <span>version {file.version}</span>
              <span>written by {file.updatedBy}</span>
            </div>
            {description && (
              <p className="mb-6 rounded-lg bg-zinc-950/4 px-3.5 py-2.5 text-[13px] leading-5 text-zinc-600 dark:bg-white/5 dark:text-zinc-300">
                {description}
              </p>
            )}
            <Markdown>{text}</Markdown>
          </>
        )}
      </article>
    </div>
  );
}
