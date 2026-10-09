"use client";

// Keyline has no brand icons, so these stay on Tabler.
import { IconBrandGithub, IconBrandNpm } from "@tabler/icons-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { DocsNav, type DocsTree, toGroups, toSuggestions } from "@/components/docs/docs-nav";
import { DocsSearch } from "@/components/docs/docs-search";
import { DocsThemeToggle } from "@/components/docs/docs-theme-toggle";
import { LogoTile } from "@/components/icons/logo-tile";
import { IconButton } from "@/components/ui/icon-button";
import { Sidebar } from "@/components/ui/sidebar";



/**
 * One shell for the whole site, mounted in the root layout so moving between
 * pages keeps the sidebar (its open state and width). A client component
 * because `Sidebar` is an `Object.assign` compound, which a server component
 * would read as a proxy.
 */
export const SiteShell = ({
  tree,
  version,
  children,
}: {
  tree: DocsTree;
  /** The released core version, shown in the footer. */
  version: string;
  children: ReactNode;
}) => {
  const groups = toGroups(tree.children);

  return (
    <Sidebar.Provider>
      <Sidebar>
        {/* Centred on the viewport's top bar: both start 8px down, and the bar
            (52px) sits under the viewport's 1px border, hence 54px. */}
        <Sidebar.Header className="-mb-2 h-[54px] shrink-0 flex-row items-center justify-between pr-0.5 pl-1">
          <Link href="/docs" className="flex items-center gap-2.5 text-ink-primary" aria-label="Latch">
            <LogoTile />
            <span className="font-semibold text-md tracking-[-0.01em]">intentface/latch</span>
          </Link>
          <DocsSearch suggestions={toSuggestions(groups)} />
        </Sidebar.Header>
        <DocsNav groups={groups} />
        <Sidebar.Footer className="flex-row items-center justify-between border-ink-primary/8 border-t pt-2 pr-1 pl-0.5">
          <a
            href="https://www.npmjs.com/package/@intentface/latch-core?activeTab=versions"
            target="_blank"
            rel="noreferrer"
            aria-label={`Version ${version} on npm`}
            className="flex h-7 items-center rounded-md px-1.5 font-mono text-ink-secondary text-xs transition-colors hover:bg-ink-primary/5 hover:text-ink-primary focus-visible:outline-2 focus-visible:outline-accent-bg/60"
          >
            v{version}
          </a>
          <div className="flex items-center gap-0.5">
            <FooterLink href="https://github.com/Intentface/intentface-latch" label="GitHub" icon={<IconBrandGithub />} />
            <FooterLink
              href="https://www.npmjs.com/package/@intentface/latch-core"
              label="npm"
              icon={<IconBrandNpm />}
            />
            <DocsThemeToggle />
          </div>
        </Sidebar.Footer>
      </Sidebar>
      <Sidebar.Inset>
        <Sidebar.Viewport>{children}</Sidebar.Viewport>
      </Sidebar.Inset>
    </Sidebar.Provider>
  );
};

const FooterLink = ({ href, label, icon }: { href: string; label: string; icon: ReactNode }) => (
  <IconButton
    variant="ghost"
    size="sm"
    nativeButton={false}
    aria-label={label}
    className="rounded-md"
    render={
      <a href={href} target="_blank" rel="noreferrer">
        {icon}
      </a>
    }
  />
);
