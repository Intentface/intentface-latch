"use client";

import { Check } from "@keyline-icons/react";
// Keyline has no brand or Markdown icons, so these stay on Tabler.
import { IconBrandGithub, IconMarkdown } from "@tabler/icons-react";
import Button from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useCopy } from "@/hooks/use-copy";

const REPO = "https://github.com/Intentface/intentface-latch";

type PageActionsProps = {
  /** The page's URL, e.g. `/docs/concepts/runtime`. */
  url: string;
  /** The page's file under content/docs, for the GitHub link. */
  path: string;
};

// "Copy page" puts the page's raw markdown on the clipboard (the same file the
// `.md` route serves); the GitHub link goes to the page's source.
export const PageActions = ({ url, path }: PageActionsProps) => {
  const { copy, isCopied } = useCopy();

  const copyPage = async () => {
    const response = await fetch(`${url}.md`);
    if (response.ok) await copy(await response.text());
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" className="gap-1.5 pr-2.5 pl-2 text-sm" onClick={copyPage}>
        {isCopied ? <Check /> : <IconMarkdown />}
        {isCopied ? "Copied" : "Copy page"}
      </Button>
      <IconButton
        variant="ghost"
        size="sm"
        nativeButton={false}
        aria-label="Page source on GitHub"
        render={
          <a href={`${REPO}/blob/main/apps/docs/content/docs/${path}`} target="_blank" rel="noreferrer">
            <IconBrandGithub />
          </a>
        }
      />
    </div>
  );
};
