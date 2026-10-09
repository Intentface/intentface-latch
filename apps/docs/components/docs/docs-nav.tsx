"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
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
  const entries: NavEntry[] = folder.index ? [folder.index] : [];
  for (const child of folder.children) {
    if (child.type === "page") entries.push(child);
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

/** The sidebar's page tree. */
export const DocsNav = ({ groups }: { groups: NavGroup[] }) => (
  <Sidebar.Content className="gap-[18px]">
    {groups.map((group, index) => (
      <Sidebar.Group key={typeof group.label === "string" ? group.label : index}>
        {group.label && <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>}
        <Sidebar.Menu>
          {group.items.map((item, i) =>
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
      </Sidebar.Group>
    ))}
  </Sidebar.Content>
);
