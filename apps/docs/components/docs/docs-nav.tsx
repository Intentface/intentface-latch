"use client";

import { Nav } from "@intentface/chat/nav";
import {
  Blocks,
  BookOpen,
  ChevronDown,
  Code,
  FlaskConical,
  Home,
  Lightbulb,
  Rocket,
} from "@keyline-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Sidebar } from "@/components/ui/sidebar";
import type { SearchSuggestion } from "./docs-search";

// Structural mirror of fumadocs' page-tree nodes. Folders may carry an index
// page and separators of their own (a sub-heading inside the section).
type TreeItem = { type: "page"; name: ReactNode; url: string };
type TreeFolder = { type: "folder"; name: ReactNode; index?: TreeItem; children: TreeNode[] };
type TreeSeparator = { type: "separator"; name?: ReactNode };
type TreeNode = TreeItem | TreeFolder | TreeSeparator;

export type DocsTree = { children: TreeNode[] };

/** A sub-heading inside a section ("In depth", "Build"), holding its pages. */
type NavSubgroup = { type: "subgroup"; key: string; label: ReactNode; items: TreeItem[] };
type SectionEntry = TreeItem | NavSubgroup;
/** A top-level section: a folder, or a separator with the folder after it. */
export type NavSection = { key: string; label: ReactNode; entries: SectionEntry[] };
export type NavModel = { top: TreeItem[]; sections: NavSection[] };

const keyOf = (name: ReactNode, fallback: string) =>
  (typeof name === "string" ? name : fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-");

// The docs home is titled "Latch", which reads oddly under the Latch logo.
const displayName = (item: TreeItem) => (item.url === "/docs" ? "Introduction" : item.name);

// Section icons, by the folder's title.
const ICONS: Record<string, ReactNode> = {
  "getting-started": <Rocket />,
  "how-it-fits-together": <Blocks />,
  "harder-than-it-looks": <Lightbulb />,
  guides: <BookOpen />,
  reference: <Code />,
  experimental: <FlaskConical />,
};

// A folder's own entries. Its index page reads "Overview" under the section's
// label; a separator inside it opens a sub-group for the pages after it.
const folderEntries = (folder: TreeFolder, sectionKey: string): SectionEntry[] => {
  const named = (page: TreeItem): TreeItem => (page.name === folder.name ? { ...page, name: "Overview" } : page);
  const entries: SectionEntry[] = folder.index ? [named(folder.index)] : [];
  let sub: NavSubgroup | null = null;
  for (const child of folder.children) {
    if (child.type === "separator" && child.name) {
      sub = { type: "subgroup", key: `${sectionKey}/${keyOf(child.name, String(entries.length))}`, label: child.name, items: [] };
      entries.push(sub);
    } else if (child.type === "page") {
      if (sub) sub.items.push(named(child));
      else entries.push(named(child));
    } else if (child.type === "folder") {
      for (const e of folderEntries(child, sectionKey)) {
        if (e.type === "page" && sub) sub.items.push(e);
        else entries.push(e);
      }
    }
  }
  return entries;
};

/**
 * The page tree as the sidebar shows it: root pages at the top, then one
 * section per folder. A root separator names the section of the folder after
 * it ("Experimental" over the memory folder).
 */
export const toNavModel = (nodes: TreeNode[]): NavModel => {
  const model: NavModel = { top: [], sections: [] };
  let pendingLabel: ReactNode | undefined;
  for (const node of nodes) {
    if (node.type === "page") model.top.push(node);
    else if (node.type === "separator") pendingLabel = node.name;
    else {
      const label = pendingLabel ?? node.name;
      const key = keyOf(label, String(model.sections.length));
      model.sections.push({ key, label, entries: folderEntries(node, key) });
      pendingLabel = undefined;
    }
  }
  return model;
};

// The search palette opens on these before anything is typed.
const SUGGESTED = [
  "/docs/getting-started/quickstart",
  "/docs/concepts",
  "/docs/hard-parts",
  "/docs/guides",
  "/docs/reference/create-runtime",
];

export const toSuggestions = (model: NavModel): SearchSuggestion[] =>
  [...model.top, ...model.sections.flatMap((s) => s.entries.flatMap((e) => (e.type === "page" ? [e] : e.items)))]
    .filter((item) => SUGGESTED.includes(item.url))
    .map((item) => ({ url: item.url, title: typeof item.name === "string" ? item.name : item.url }));

/** Every sub-group: they start open, so a section opens straight onto its pages. */
const subgroupKeys = (model: NavModel) =>
  model.sections.flatMap((s) => s.entries.flatMap((e) => (e.type === "subgroup" ? [e.key] : [])));

/** The section and sub-group keys that hold `url`: what to open to show it. */
const openFor = (model: NavModel, url: string): string[] => {
  for (const s of model.sections) {
    for (const e of s.entries) {
      if (e.type === "page" && e.url === url) return [s.key];
      if (e.type === "subgroup" && e.items.some((i) => i.url === url)) return [s.key, e.key];
    }
  }
  return [];
};

// One row style for pages and section headings alike. The explicit height is
// load-bearing: the rail's geometry (globals.css, `.docs-nav`) assumes 30px rows.
const rowClass = [
  "group/row flex h-[30px] shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-2 font-medium text-sm/none",
  "text-ink-body no-underline transition-colors",
  "hover:bg-ink-primary/5 hover:text-ink-primary",
  // Inset: the collapsing lists clip their overflow, so an outset ring would be cut.
  "focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent-bg/60",
  // The current page is raised off the sidebar.
  "data-[active]:bg-raised-selected data-[active]:text-ink-primary data-[active]:shadow-raised",
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-secondary hover:[&_svg]:text-ink-primary data-[active]:[&_svg]:text-ink-primary",
].join(" ");

const listClass = "flex flex-col gap-0.5";

const Chevron = () => (
  <ChevronDown className="ml-auto size-3! text-ink-tertiary transition-transform group-data-closed/row:-rotate-90" />
);

const PageRow = ({ item, icon }: { item: TreeItem; icon?: ReactNode }) => {
  const pathname = usePathname();
  return (
    // The primitive's rows are buttons; these are real links, and say so.
    <Nav.Item
      value={item.url}
      active={pathname === item.url}
      role="link"
      className={rowClass}
      render={<Link href={item.url} />}
    >
      {icon && <Nav.Icon>{icon}</Nav.Icon>}
      {/* Long titles truncate under the deeper indent; the tooltip has the rest. */}
      <Nav.Label className="min-w-0 truncate" title={typeof item.name === "string" ? item.name : undefined}>
        {displayName(item)}
      </Nav.Label>
    </Nav.Item>
  );
};

/**
 * The sidebar's page tree, on `@intentface/chat`'s Nav: one tab stop with
 * arrow keys and typeahead, sections that fold with a guide down their left
 * edge. The section holding the current page is open, and its sub-groups are;
 * opening a page in a closed section (from search or a link) opens it; what
 * you open or close stays that way while you move around.
 */
export const DocsNav = ({ model }: { model: NavModel }) => {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState<string[]>(() => [...subgroupKeys(model), ...openFor(model, pathname)]);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    const needed = openFor(model, pathname).filter((k) => !expanded.includes(k));
    if (needed.length) setExpanded([...expanded, ...needed]);
  }

  return (
    <Sidebar.Content className="docs-nav">
      <Nav.Root
        aria-label="Documentation"
        guide="indent"
        expanded={expanded}
        onExpandedChange={setExpanded}
        render={<nav />}
        className="flex flex-col gap-0.5"
      >
        <Nav.List guide="none" className={listClass}>
          {model.top.map((item) => (
            <PageRow key={item.url} item={item} icon={item.url === "/docs" ? <Home /> : undefined} />
          ))}

          {model.sections.map((section, i) => (
            <Nav.Group key={section.key} value={section.key} className={i === 0 ? "mt-2" : undefined}>
              <Nav.Trigger className={rowClass}>
                {ICONS[section.key] && <Nav.Icon>{ICONS[section.key]}</Nav.Icon>}
                <Nav.Label className="min-w-0 truncate">{section.label}</Nav.Label>
                <Chevron />
              </Nav.Trigger>

              {/* A rail down the section, with an elbow at each sub-group. */}
              <Nav.List guide="branches" className={listClass}>
                {section.entries.map((entry) =>
                  entry.type === "page" ? (
                    <PageRow key={entry.url} item={entry} />
                  ) : (
                    <Nav.Group key={entry.key} value={entry.key}>
                      <Nav.Trigger className={rowClass}>
                        <Nav.Label className="min-w-0 truncate">{entry.label}</Nav.Label>
                        <Chevron />
                      </Nav.Trigger>
                      <Nav.List className={listClass}>
                        {entry.items.map((item) => (
                          <PageRow key={item.url} item={item} />
                        ))}
                      </Nav.List>
                    </Nav.Group>
                  ),
                )}
              </Nav.List>
            </Nav.Group>
          ))}
        </Nav.List>
      </Nav.Root>
    </Sidebar.Content>
  );
};
