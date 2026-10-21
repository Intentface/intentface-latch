import { useEffect, useState } from "react";
import { api, type FileView, type Person } from "./api";
import { Markdown } from "./Markdown";
import { TrustMark } from "./TrustMark";

/** One document, read as the selected person: the same call the agent's read_file makes. */
export function FileViewer({ person, path, revision, onClose }: { person: Person; path: string; revision: number; onClose: () => void }) {
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFile(null);
    setError(null);
    api.file(person.id, path).then(
      (f) => live && setFile(f),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [person.id, path, revision]);

  const description = file?.lines.join("\n").match(/^---[\s\S]*?\ndescription:\s?(.+)\n[\s\S]*?---/)?.[1];

  return (
    <aside className="viewer" aria-label={path}>
      <header className="viewer-head">
        <div className="viewer-path">{path}</div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {error && <p className="viewer-error">{error}</p>}
      {file && (
        <>
          <div className="viewer-meta">
            <TrustMark trusted={file.trusted} label />
            <span>version {file.version}</span>
            <span>by {file.updatedBy}</span>
          </div>
          {description && <p className="viewer-description">{description}</p>}
          <div className="viewer-body">
            <Markdown>{file.lines.join("\n")}</Markdown>
          </div>
        </>
      )}
    </aside>
  );
}
