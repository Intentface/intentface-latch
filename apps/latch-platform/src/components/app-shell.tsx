import { useEffect, useRef, useState } from "react";
import { Menu, PanelLeft } from "lucide-react";
import { useRouterState } from "@tanstack/react-router";
import { Shell, useShell } from "@intentface/chat/shell";
import type { ShellStore } from "@intentface/chat/shell";
import { AppSidebarContent } from "@/components/app-sidebar";
import { ScrollPane } from "@/components/scroll-pane";
import Drawer from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

/**
 * The app frame: the Shell primitive from @intentface/chat — a sidebar that
 * collapses, floats back out as a card when the pointer rests on the left
 * edge, and drags wider — beside the content panel.
 *
 * The one arrangement everything depends on: the sidebar is taken out of flow
 * (fixed) and a plain spacer, the gutter, holds its place. Collapsing then
 * animates two cheap things on two elements — the panel's `left` and the
 * gutter's `width` — and the panel can float over the content while peeking.
 * The card geometry is baked into the whole collapsed state, so the peek only
 * slides `left`; only expand/collapse morphs card ↔ flat.
 *
 * Shell persists nothing; open and width go into a cookie here, so a later
 * request can render the right layout on the server. On a phone the same
 * content sits in a drawer behind a menu button instead.
 */

const COOKIE = "latch_shell";
const DEFAULT_WIDTH = 224;

type Stored = { open: boolean; width: number | null };

function readStored(): Stored | null {
  try {
    const raw = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
    if (!raw) return null;
    const v = JSON.parse(decodeURIComponent(raw.slice(COOKIE.length + 1))) as Partial<Stored>;
    // Stored state outlives the code that wrote it: validate on the way in.
    return {
      open: typeof v.open === "boolean" ? v.open : true,
      width: typeof v.width === "number" && v.width >= 180 && v.width <= 400 ? v.width : null,
    };
  } catch {
    return null;
  }
}
function writeStored(s: Stored) {
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(s))}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  const [store] = useState(() => Shell.createStore());
  const [width, setWidth] = useState<number | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Navigating from the drawer closes it, or it keeps covering the page.
  const href = useRouterState({ select: (r) => r.location.href });
  useEffect(() => setMobileOpen(false), [href]);
  // The sidebar reports its width as soon as it mounts — the default, before
  // the stored one is restored. Writing that would overwrite what was saved,
  // so nothing is written until the restore has run.
  const restored = useRef(false);

  // Restore where the person left it. Client-only for now, so a collapsed
  // sidebar shows for one frame before it hides — the same as before Shell.
  useEffect(() => {
    const s = readStored();
    if (s?.width) setWidth(s.width);
    if (s && !s.open) store.getSnapshot().setOpen(false);
    restored.current = true;
  }, [store]);

  useShortcut(store);

  if (isMobile) {
    return (
      <div className="bg-base-bg flex h-dvh w-full flex-col">
        <div className="flex h-11 shrink-0 items-center px-2">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="text-ink-secondary hover:text-ink-primary hover:bg-base-bg-hover grid size-8 place-items-center rounded-md"
          >
            <Menu className="size-4" />
          </button>
        </div>
        <Drawer side="left" open={mobileOpen} onOpenChange={setMobileOpen}>
          <Drawer.Content
            side="left"
            className="bg-base-bg w-[min(18rem,85vw)] gap-0 outline-none [&>button]:hidden"
            // A link to the page already open changes nothing to close on.
            onClickCapture={(e: React.MouseEvent) => (e.target as HTMLElement).closest("a[href]") && setMobileOpen(false)}
          >
            <AppSidebarContent />
          </Drawer.Content>
        </Drawer>
        <div data-slot="sidebar-inset" className="relative bg-secondary-bg border-secondary-border mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-xl border">
          <ScrollPane>{children}</ScrollPane>
        </div>
      </div>
    );
  }

  return (
    <Shell.Root
      store={store}
      defaultOpen
      onOpenChange={(open) => restored.current && writeStored({ open, width })}
      className="group/shell bg-base-bg relative flex h-dvh w-full overflow-hidden"
      style={{ ["--shell-sidebar-width" as string]: `${width ?? DEFAULT_WIDTH}px` }}
    >
      {/* Rest the pointer on the left edge to float a collapsed sidebar out. */}
      <Shell.Hotspot className="fixed inset-y-0 left-0 z-20 hidden w-5 data-[state=collapsed]:block" />

      {/* The gutter: holds the sidebar's place in flow, and animates to zero while the panel slides away. */}
      <div
        data-slot="shell-gutter"
        className="w-(--shell-sidebar-width) shrink-0 transition-[width] duration-150 ease-linear group-data-[resizing]/shell:transition-none group-data-[state=collapsed]/shell:w-0 motion-reduce:transition-none"
      />

      <Shell.Sidebar
        onResize={(w) => {
          if (!restored.current) return;
          setWidth(w);
          writeStored({ open: store.getSnapshot().open, width: w });
        }}
        className={cn(
          // min/max-width are the whole drag range; the grip reads them off computed style.
          "fixed inset-y-0 left-0 z-10 flex w-(--shell-sidebar-width) min-w-[180px] max-w-[400px] flex-col overflow-hidden pt-2 pl-2",
          // Always opaque: the content passes beneath the panel while the two animate.
          "bg-base-bg border border-transparent transition-[left,top,bottom,padding,background-color,border-color,border-radius,box-shadow] duration-150 ease-linear",
          "data-[resizing]:transition-none motion-reduce:transition-none",
          // Collapsed: a card, parked off-canvas; peeking slides it in.
          "data-[state=collapsed]:-left-(--shell-sidebar-width) data-[state=collapsed]:inset-y-2 data-[state=collapsed]:rounded-xl data-[state=collapsed]:pt-0 data-[state=collapsed]:pl-0",
          "data-[state=collapsed]:bg-primary-bg data-[state=collapsed]:border-secondary-border",
          "data-[state=collapsed]:data-[hotspot]:left-2 data-[hotspot]:shadow-lg",
        )}
      >
        <AppSidebarContent trigger={<CollapseButton />} />
      </Shell.Sidebar>

      {/* A sibling of the sidebar, not a child: the sidebar clips its overflow
          for the collapsed card, so a handle hung off its edge would be cut in
          half. Centred on the content panel's 1px left border, which starts
          where the gutter ends (the viewport has no left padding). */}
      <Shell.Grip
        aria-label="Resize sidebar"
        className={cn(
          "absolute inset-y-0 left-[calc(var(--shell-sidebar-width)+0.5px)] z-20 w-1.5 -translate-x-1/2 cursor-col-resize select-none",
          "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors before:duration-100",
          "before:[mask-image:linear-gradient(to_bottom,transparent_20px,black_76px,black_calc(100%-76px),transparent_calc(100%-20px))]",
          "hover:before:bg-ink-tertiary data-[resizing]:before:bg-ink-secondary",
          "focus-visible:outline-ink-primary focus-visible:-outline-offset-2 focus-visible:outline-2",
          "data-[state=collapsed]:hidden",
        )}
      />

      {/* data-slot kept from the old frame: the chat's drop-a-file-anywhere
          zone finds the content area by it (components/ai/attachments.tsx). */}
      <Shell.Viewport data-slot="sidebar-inset" className="relative flex min-w-0 flex-1 flex-col py-2 pr-2 transition-[padding] duration-150 ease-linear data-[state=collapsed]:p-0 motion-reduce:transition-none">
        <div
          className={cn(
            "bg-secondary-bg flex h-full min-h-0 flex-1 overflow-hidden border border-transparent",
            "group-data-[state=expanded]/shell:border-secondary-border group-data-[state=expanded]/shell:rounded-xl",
          )}
        >
          {/* A flex row: the pane claims the space explicitly, or it would
              shrink to the thread's min-width instead of filling. */}
          <ScrollPane>{children}</ScrollPane>
        </div>
      </Shell.Viewport>
    </Shell.Root>
  );
}

/** Its label names the action: while peeking, the trigger pins the sidebar open rather than hiding it. */
function CollapseButton() {
  const open = useShell((shell) => shell.open);
  return (
    <Shell.Trigger
      aria-label={open ? "Collapse sidebar (⌘B)" : "Pin sidebar open (⌘B)"}
      title={open ? "Collapse sidebar (⌘B)" : "Pin sidebar open (⌘B)"}
      className="text-ink-secondary hover:text-ink-primary hover:bg-base-bg-hover grid size-7 shrink-0 place-items-center rounded-md"
    >
      <PanelLeft className="size-4" />
    </Shell.Trigger>
  );
}

/** Cmd/Ctrl+B, as before. The package binds no keys; this app spends this one. */
function useShortcut(store: ShellStore) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "b" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      store.getSnapshot().toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);
}
