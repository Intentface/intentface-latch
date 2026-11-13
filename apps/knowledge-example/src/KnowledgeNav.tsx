import { Nav } from "@intentface/chat/nav";
import { BookOpen, Building, ChevronDown, FileText, Folder, Notebook, User } from "@keyline-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { api, type Entry, type Person } from "./api";
import { TrustMark } from "./TrustMark";
import { NAV_LIST, NAV_ROW } from "./ui";

type Node = { name: string; path: string; children: Map<string, Node>; file?: Entry };

/** The files of one mount as a tree; folders are implied by the paths under them. */
function treeOf(mount: string, entries: Entry[]): Node {
  const root: Node = { name: mount, path: mount, children: new Map() };
  for (const e of entries) {
    if (e.type !== "file") continue;
    let node = root;
    for (const part of e.path.slice(mount.length + 1).split("/")) {
      let next = node.children.get(part);
      if (!next) node.children.set(part, (next = { name: part, path: `${node.path}/${part}`, children: new Map() }));
      node = next;
    }
    node.file = e;
  }
  return root;
}

const folders = (node: Node): string[] =>
  node.children.size ? [node.path, ...[...node.children.values()].flatMap(folders)] : [];

/** A folder holding only its SKILL.md is shown as the skill itself. */
const skillFile = (node: Node) => (node.children.size === 1 ? node.children.get("SKILL.md")?.file : undefined);

const MOUNT_ICON: Record<string, ReactNode> = { "/practices": <BookOpen />, "/org": <Building />, "/me": <User /> };

/** The knowledge as the selected person sees it: switch people and other orgs' files simply aren't there. */
export function KnowledgeNav({ person, revision, openPath, onOpen }: { person: Person; revision: number; openPath: string | null; onOpen: (path: string) => void }) {
  // Keyed by person, so a tree is never shown (or its folders opened) for someone else.
  const [loaded, setLoaded] = useState<{ person: string; mounts: Node[] } | null>(null);

  useEffect(() => {
    let live = true;
    api.tree(person.id).then(
      (t) => live && setLoaded({ person: person.id, mounts: t.map((m) => treeOf(m.mount, m.entries)) }),
      () => live && setLoaded({ person: person.id, mounts: [] }),
    );
    return () => {
      live = false;
    };
  }, [person.id, revision]);

  if (loaded?.person !== person.id) return null;
  const { mounts } = loaded;

  const hint = (mount: string) => (mount === "/practices" ? "every customer" : mount === "/org" ? person.org.name : person.name.split(" ")[0]);

  const leaf = (node: Node, file: Entry, icon: ReactNode, label: string) => (
    <Nav.Item key={node.path} value={file.path} active={openPath === file.path} onClick={() => onOpen(file.path)} className={NAV_ROW} title={file.path}>
      <Nav.Icon>{icon}</Nav.Icon>
      <Nav.Label className="min-w-0 truncate">{label}</Nav.Label>
      <TrustMark trusted={file.trusted} className="ml-auto" />
    </Nav.Item>
  );

  const render = (node: Node): ReactNode => {
    const skill = skillFile(node);
    if (skill) return leaf(node, skill, <Notebook />, node.name);
    if (node.file) return leaf(node, node.file, <FileText />, node.name);
    return (
      <Nav.Group key={node.path} value={node.path}>
        <Nav.Trigger className={NAV_ROW}>
          <Nav.Icon>
            <Folder />
          </Nav.Icon>
          <Nav.Label className="min-w-0 truncate">{node.name}</Nav.Label>
          <Chevron />
        </Nav.Trigger>
        <Nav.List guide="branches" className={NAV_LIST}>
          {[...node.children.values()].map(render)}
        </Nav.List>
      </Nav.Group>
    );
  };

  return (
    <Nav.Root
      key={person.id}
      aria-label="Knowledge"
      guide="rail"
      defaultExpanded={mounts.flatMap((m) => [m.path, ...folders(m)])}
      render={<nav />}
      className="kb-nav flex flex-col gap-0.5 px-2 [--rail:#e4e4e7] dark:[--rail:#2b2b2e]"
    >
      <Nav.List guide="none" className={NAV_LIST}>
        {mounts.map((m) => (
          <Nav.Group key={m.path} value={m.path}>
            <Nav.Trigger className={NAV_ROW}>
              <Nav.Icon>{MOUNT_ICON[m.path]}</Nav.Icon>
              <Nav.Label className="min-w-0 truncate font-mono text-[12.5px]">{m.path}</Nav.Label>
              <span className="ml-auto truncate text-[11px] font-normal text-zinc-400 dark:text-zinc-500">{hint(m.path)}</span>
              <Chevron className="ml-0" />
            </Nav.Trigger>
            <Nav.List className={NAV_LIST}>
              {m.children.size ? (
                [...m.children.values()].map(render)
              ) : (
                <div className="flex h-[30px] items-center px-2 text-[12px] text-zinc-400 dark:text-zinc-500">Nothing here yet</div>
              )}
            </Nav.List>
          </Nav.Group>
        ))}
      </Nav.List>
    </Nav.Root>
  );
}

/** The disclosure arrow: rotates with its group by reading data-closed off the trigger. */
const Chevron = ({ className = "ml-auto" }: { className?: string }) => (
  <ChevronDown className={`${className} !size-3 shrink-0 text-zinc-400 transition-transform group-data-[closed]/row:-rotate-90 dark:text-zinc-500`} />
);
