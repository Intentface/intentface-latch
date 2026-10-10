"use client";

import { Moon, Sun } from "@keyline-icons/react";
import { useTheme } from "next-themes";
import { IconButton } from "@/components/ui/icon-button";

/**
 * A single button rather than a three-way control: "system" is the starting
 * mode, not a destination anyone picks from here. It flips whichever mode is
 * resolved, so the first press always changes what you see. The icon follows
 * the `.dark` class, so the server render needs no theme.
 */
export const DocsThemeToggle = () => {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <IconButton
      variant="ghost"
      size="sm"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="rounded-md"
    >
      <Moon className="hidden dark:block" />
      <Sun className="dark:hidden" />
    </IconButton>
  );
};
