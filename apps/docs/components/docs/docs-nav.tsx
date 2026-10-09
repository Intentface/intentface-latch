"use client";

import { ChevronRight } from "@keyline-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Collapsible } from "@/components/ui/collapsible";
import { Sidebar } from "@/components/ui/sidebar";
import type { SearchSuggestion } from "./docs-search";

// Structural mirror of fumadocs' page-tree nodes. Folders may carry an index
// page and separators of their own (a sub-heading inside the group).
type TreeItem = { type: "page"; name: ReactNode; url: string };
type TreeFolder = { type: "folder"; name: ReactNode; index?: TreeItem; children: TreeNode[] };
type TreeSeparator = { type: "separator"; name?: ReactNode };
type TreeNode = TreeItem | TreeFolder | TreeSeparator;

type NavEntry = TreeItem | { type: "label"; name: ReactNode };

export type NavGroup = { label?: ReactNode; items: NavEntry[] };

export type DocsTree = { children: TreeNode[] };

// The docs home is titled "Latch", which reads oddly under the Latch logo.
const displayName = (item: TreeItem) => (item.url === "/docs" ? "Introduction" : item.name);

// A folder's own entries: its index page, then its pages, with any separator
// inside it kept as a sub-heading.
const folderEntries = (folder: TreeFolder): NavEntry[] => {
  // A section's own index page reads "Overview" under the section's label.
  const named = (page: TreeItem): TreeItem =>
    page.name === folder.name ? { ...page, name: "Overview" } : page;
  const entries: NavEntry[] = folder.index ? [named(folder.index)] : [];
  for (const child of folder.children) {
    if (child.type === "page") entries.push(named(child));
    else if (child.type === "separator" && child.name) entries.push({ type: "label", name: child.name });
    else if (child.type === "folder") entries.push(...folderEntries(child));
  }
  return entries;
};

// A separator opens a labelled group for the root pages after it; a folder is
// a group of its own, or fills the group its separator just opened.
export const toGroups = (nodes: TreeNode[]): NavGroup[] => {
  const groups: NavGroup[] = [];
  let open: NavGroup | null = null;

  for (const node of nodes) {
    switch (node.type) {
      case "separator":
        open = { label: node.name, items: [] };
        groups.push(open);
        break;
      case "folder":
        if (open?.label && open.items.length === 0) open.items.push(...folderEntries(node));
        else groups.push({ label: node.name, items: folderEntries(node) });
        open = null;
        break;
      case "page":
        if (!open) {
          open = { items: [] };
          groups.push(open);
        }
        open.items.push(node);
        break;
    }
  }

  return groups;
};

// The search palette opens on these before anything is typed.
const SUGGESTED = [
  "/docs/getting-started/quickstart",
  "/docs/concepts",
  "/docs/hard-parts",
  "/docs/guides",
  "/docs/reference/create-runtime",
];

export const toSuggestions = (groups: NavGroup[]): SearchSuggestion[] =>
  groups
    .flatMap((group) => group.items)
    .filter((item): item is TreeItem => item.type === "page" && SUGGESTED.includes(item.url))
    .map((item) => ({
      url: item.url,
      title: typeof item.name === "string" ? item.name : item.url,
    }));

const NavLink = ({ item }: { item: TreeItem }) => {
  const pathname = usePathname();

  return (
    <Sidebar.MenuItem>
      <Sidebar.MenuButton
        isActive={pathname === item.url}
        render={
          <Link href={item.url}>
            <span className="min-w-0 flex-1 truncate">{displayName(item)}</span>
          </Link>
        }
      />
    </Sidebar.MenuItem>
  );
};

const groupKey = (group: NavGroup, index: number) =>
  typeof group.label === "string" ? group.label : String(index);

const hasPage = (group: NavGroup, url: string) =>
  group.items.some((item) => item.type === "page" && item.url === url);

const GroupItems = ({ items }: { items: NavEntry[] }) => (
  <Sidebar.Menu>
    {items.map((item, i) =>
      item.type === "page" ? (
        <NavLink key={item.url} item={item} />
      ) : (
        <li
          key={`label-${i}`}
          className="mt-2.5 flex h-6 items-center px-2 font-medium text-2xs text-ink-tertiary"
        >
          {item.name}
        </li>
      ),
    )}
  </Sidebar.Menu>
);

/**
 * The sidebar's page tree. Labelled sections fold: the one holding the current
 * page starts open and the rest closed, and arriving at a page in a closed
 * section (from search or a link) opens it. The shell lives in the root
 * layout, so what you opened stays open as you move between pages.
 */
export const DocsNav = ({ groups }: { groups: NavGroup[] }) => {
  const pathname = usePathname();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [lastPath, setLastPath] = useState(pathname);

  const current = groups.findIndex((group) => hasPage(group, pathname));
  const currentKey = current >= 0 ? groupKey(groups[current], current) : undefined;
  // Arriving at a page opens its section; closing it afterwards sticks.
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (currentKey && open[currentKey] === false) setOpen({ ...open, [currentKey]: true });
  }

  return (
    <Sidebar.Content className="gap-[18px]">
      {groups.map((group, index) => {
        const key = groupKey(group, index);
        if (!group.label) {
          return (
            <Sidebar.Group key={key}>
              <GroupItems items={group.items} />
            </Sidebar.Group>
          );
        }
        return (
          <Collapsible
            key={key}
            open={open[key] ?? key === currentKey}
            onOpenChange={(next) => setOpen({ ...open, [key]: next })}
            render={<Sidebar.Group />}
          >
            <Sidebar.GroupLabel
              render={<Collapsible.Trigger />}
              className="group/label w-full cursor-pointer justify-between transition-colors hover:text-ink-primary"
            >
              {group.label}
              <ChevronRight
                aria-hidden
                className="size-3! text-ink-tertiary transition-transform duration-200 group-hover/label:text-ink-secondary group-data-[panel-open]/label:rotate-90"
              />
            </Sidebar.GroupLabel>
            <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:h-0 data-[starting-style]:h-0">
              <GroupItems items={group.items} />
            </Collapsible.Panel>
          </Collapsible>
        );
      })}
    </Sidebar.Content>
  );
};
