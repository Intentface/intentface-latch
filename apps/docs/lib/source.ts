import type { StructuredData } from "fumadocs-core/mdx-plugins";
import { loader, type Page } from "fumadocs-core/source";
import type { TOCItemType } from "fumadocs-core/toc";
import type { MDXContent } from "mdx/types";
import { docs } from "@/.source/server";

/** Where the docs tree is mounted. Exported so URL→slug logic can't drift from it. */
export const DOCS_BASE_URL = "/docs";

/** The docs tree, rooted at {@link DOCS_BASE_URL}. */
export const source = loader({
  baseUrl: DOCS_BASE_URL,
  source: docs.toFumadocsSource(),
});

// The runtime doc-data shape: frontmatter + the compiled MDX outputs. Retyped
// here once because fumadocs-core v16's `loader` collapses the source's
// pageData generic to the base `PageData`.
export type DocPageData = {
  title: string;
  description?: string;
  full?: boolean;
  body: MDXContent;
  toc: TOCItemType[];
  structuredData: StructuredData;
};

export type DocPage = Page<undefined, DocPageData>;

export const getPage = (slug: string[] | undefined): DocPage | undefined =>
  source.getPage(slug) as DocPage | undefined;

type Node = ReturnType<typeof source.getPageTree>["children"][number];

/**
 * The sidebar section a page sits in, for the breadcrumb: its top-level folder,
 * or the separator above it for root pages.
 */
export const getSectionLabel = (url: string): string | undefined => {
  const contains = (node: Node): boolean => {
    if (node.type === "page") return node.url === url;
    if (node.type === "folder")
      return node.index?.url === url || node.children.some((child) => contains(child as Node));
    return false;
  };
  let separator: string | undefined;
  for (const node of source.getPageTree().children) {
    if (node.type === "separator") separator = typeof node.name === "string" ? node.name : undefined;
    else if (node.type === "folder" && contains(node)) return typeof node.name === "string" ? node.name : separator;
    else if (node.type === "page" && node.url === url) return separator;
  }
  return undefined;
};
