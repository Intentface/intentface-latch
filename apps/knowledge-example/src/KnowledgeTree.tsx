import { useEffect, useState } from "react";
import { api, type Entry, type Person } from "./api";
import { TrustMark } from "./TrustMark";

const MOUNT_HINT: Record<string, string> = {
  "/practices": "Shared with every customer",
  "/org": "Only this org",
  "/me": "Only this person",
};

/** The knowledge as the selected person sees it: switch people and other orgs' files are simply not there. */
export function KnowledgeTree({
  person,
  revision,
  openPath,
  onOpen,
}: {
  person: Person;
  revision: number;
  openPath: string | null;
  onOpen: (path: string) => void;
}) {
  const [tree, setTree] = useState<{ mount: string; entries: Entry[] }[] | null>(null);

  useEffect(() => {
    let live = true;
    api.tree(person.id).then(
      (t) => live && setTree(t),
      () => live && setTree([]),
    );
    return () => {
      live = false;
    };
  }, [person.id, revision]);

  return (
    <section className="tree" aria-label="Knowledge">
      <h2 className="section-title">What {person.name.split(" ")[0]} can see</h2>
      <p className="legend">
        <TrustMark trusted label /> our staff wrote it; the agent follows it
        <br />
        <TrustMark trusted={false} label /> users wrote it; information only
      </p>
      {tree?.map(({ mount, entries }) => (
        <div key={mount} className="mount">
          <div className="mount-head">
            <span className="mount-name">{mount}</span>
            <span className="mount-hint">{mount === "/org" ? person.org.name : MOUNT_HINT[mount]}</span>
          </div>
          {entries.length === 0 ? (
            <p className="empty">Nothing here yet</p>
          ) : (
            <ul>
              {entries
                .filter((e) => e.type === "file")
                .map((e) => {
                  const rel = e.path.slice(mount.length + 1);
                  const skill = rel.endsWith("/SKILL.md") ? rel.slice(0, -"/SKILL.md".length) : null;
                  return (
                    <li key={e.path}>
                      <button type="button" className="file" aria-current={openPath === e.path} onClick={() => onOpen(e.path)}>
                        <TrustMark trusted={e.trusted} />
                        <span className="file-path">{skill ? `${skill}/` : rel}</span>
                        {skill && <span className="skill-tag">skill</span>}
                      </button>
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
