import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { PanelLeft } from "lucide-react";
import {
  type ComponentProps,
  type CSSProperties,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { cn } from "../lib/utils.js";
import { useIsMobile } from "./use-mobile.js";
import { IconButton } from "./icon-button.js";
import Tooltip from "./tooltip.js";

/**
 * Collapsible app sidebar (ported from intentface-chat's shadcn-style Sidebar,
 * desktop offcanvas only — no mobile drawer). The floating-canvas layout is part
 * of the system: `Sidebar.Inset` pads when expanded and `Sidebar.Viewport`
 * rounds + borders the main content. Toggle via `Sidebar.Trigger`/`Rail` or ⌘/Ctrl-B.
 */
const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

type SidebarContextType = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = createContext<SidebarContextType | null>(null);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a Sidebar.Provider.");
  return context;
};

const SidebarProvider = ({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) => {
  const isMobile = useIsMobile();
  const [_open, _setOpen] = useState(defaultOpen);
  const open = openProp ?? _open;

  const setOpen = useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const next = typeof value === "function" ? value(open) : value;
      if (setOpenProp) setOpenProp(next);
      else _setOpen(next);
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${next}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open],
  );

  const toggleSidebar = useCallback(() => setOpen((o) => !o), [setOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === SIDEBAR_KEYBOARD_SHORTCUT && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const state = open ? "expanded" : "collapsed";
  const contextValue = useMemo<SidebarContextType>(
    () => ({ state, open, setOpen, isMobile, toggleSidebar }),
    [state, open, setOpen, isMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        data-state={state}
        className={cn("group/sidebar-wrapper bg-base flex min-h-svh w-full", className)}
        style={{ "--sidebar-width": "16rem", ...style } as CSSProperties}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
};

const SidebarRoot = ({ className, children, ...props }: ComponentProps<"div">) => {
  const { state } = useSidebar();
  return (
    <div
      className="group peer text-sidebar-foreground hidden md:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? "offcanvas" : ""}
      data-side="left"
    >
      <div
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
          "group-data-[state=collapsed]:w-0",
        )}
      />
      <div
        data-slot="sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,width] duration-200 ease-linear md:flex",
          "group-data-[state=collapsed]:left-[calc(var(--sidebar-width)*-1)]",
          className,
        )}
        {...props}
      >
        {/* Transparent: the sidebar blends with the app canvas (bg-base); only
            the main content Viewport is a distinct (white) surface. */}
        <div className="flex h-full w-full flex-col gap-2 py-2 pl-2">{children}</div>
      </div>
    </div>
  );
};

const SidebarTrigger = ({ onClick, ...props }: ComponentProps<"button">) => {
  const { toggleSidebar } = useSidebar();
  return (
    <IconButton
      data-slot="sidebar-trigger"
      variant="ghost"
      onClick={(e) => {
        onClick?.(e);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeft className="size-4" />
      <span className="sr-only">Toggle Sidebar</span>
    </IconButton>
  );
};

const SidebarRail = ({ className, ...props }: ComponentProps<"button">) => {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      title="Toggle Sidebar"
      onClick={toggleSidebar}
      className={cn(
        "hover:after:bg-sidebar-border absolute inset-y-0 -right-4 z-20 hidden w-4 -translate-x-1/2 cursor-w-resize transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] sm:flex",
        className,
      )}
      {...props}
    />
  );
};

const SidebarInset = ({ className, children, ...props }: ComponentProps<"main">) => {
  const { state } = useSidebar();
  return (
    <main
      data-slot="sidebar-inset"
      data-expanded={state === "expanded" ? "" : undefined}
      className={cn(
        "group/sidebar-inset bg-base relative flex h-dvh w-full flex-1 flex-col overflow-hidden",
        "transition-[padding] duration-200 ease-out data-expanded:p-2",
        className,
      )}
      {...props}
    >
      {children}
    </main>
  );
};

const SidebarViewport = ({ className, children, ...props }: ComponentProps<"div">) => (
  <div
    data-slot="sidebar-viewport"
    className={cn(
      "bg-secondary flex h-full min-h-0 flex-1 flex-col overflow-hidden border border-transparent",
      "group-data-expanded/sidebar-inset:border-secondary-border group-data-expanded/sidebar-inset:rounded-xl",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

const SidebarHeader = ({ className, ...props }: ComponentProps<"div">) => (
  <div data-slot="sidebar-header" className={cn("flex flex-col gap-2 p-2", className)} {...props} />
);

const SidebarFooter = ({ className, ...props }: ComponentProps<"div">) => (
  <div data-slot="sidebar-footer" className={cn("flex flex-col gap-2 p-2", className)} {...props} />
);

const SidebarContent = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    data-slot="sidebar-content"
    className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-auto", className)}
    {...props}
  />
);

const SidebarGroup = ({ className, ...props }: ComponentProps<"div">) => (
  <div data-slot="sidebar-group" className={cn("relative flex w-full min-w-0 flex-col", className)} {...props} />
);

const SidebarGroupLabel = ({ className, render, ...props }: useRender.ComponentProps<"div">) =>
  useRender({
    render,
    defaultTagName: "div",
    props: {
      "data-slot": "sidebar-group-label",
      ...props,
      className: cn(
        "text-ink-secondary flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium tracking-wide uppercase outline-hidden",
        className,
      ),
    },
  });

const SidebarGroupContent = ({ className, ...props }: ComponentProps<"div">) => (
  <div data-slot="sidebar-group-content" className={cn("w-full text-sm", className)} {...props} />
);

const SidebarMenu = ({ className, ...props }: ComponentProps<"ul">) => (
  <ul data-slot="sidebar-menu" className={cn("flex w-full min-w-0 flex-col gap-1", className)} {...props} />
);

const SidebarMenuItem = ({ className, ...props }: ComponentProps<"li">) => (
  <li data-slot="sidebar-menu-item" className={cn("group/menu-item relative", className)} {...props} />
);

const sidebarMenuButtonVariants = cva(
  [
    "peer/menu-button cursor-pointer flex w-full items-center gap-2 overflow-hidden rounded-md px-2 font-medium text-left outline-hidden",
    "transition-[width,height,padding] focus-visible:ring-1 focus-visible:ring-accent/50",
    "hover:bg-base-hover data-active:bg-base-active",
    "disabled:pointer-events-none disabled:opacity-50",
    "group-has-data-[slot=sidebar-menu-action]/menu-item:pr-1",
    "[&>span:last-child]:truncate [&_svg]:text-ink-secondary [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:pointer-events-none hover:[&>svg]:text-ink-primary",
  ],
  {
    variants: { size: { sm: "h-7 text-xs", md: "h-8 text-sm", lg: "h-9 text-md" } },
    defaultVariants: { size: "md" },
  },
);

const SidebarMenuButton = ({
  isActive = false,
  size = "md",
  tooltip,
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & {
  isActive?: boolean;
  tooltip?: string;
} & VariantProps<typeof sidebarMenuButtonVariants>) => {
  const { isMobile, state } = useSidebar();
  const button = useRender({
    render,
    defaultTagName: "button",
    props: {
      "data-slot": "sidebar-menu-button",
      "data-active": isActive ? "" : undefined,
      ...props,
      className: cn(sidebarMenuButtonVariants({ size }), className),
    },
  });
  if (!tooltip) return button;
  return (
    <Tooltip>
      <Tooltip.Trigger render={button} />
      <Tooltip.Content side="right" align="center" hidden={state !== "collapsed" || isMobile}>
        {tooltip}
      </Tooltip.Content>
    </Tooltip>
  );
};

const SidebarMenuAction = ({
  className,
  showOnHover = false,
  render,
  onClick,
  ...props
}: useRender.ComponentProps<"button"> & { showOnHover?: boolean }) =>
  useRender({
    render,
    defaultTagName: "button",
    props: {
      "data-slot": "sidebar-menu-action",
      onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        onClick?.(e);
      },
      ...props,
      className: cn(
        "text-ink-secondary cursor-pointer hover:text-ink-primary absolute top-1 right-1 flex aspect-square size-6 items-center justify-center rounded-sm outline-hidden [&>svg]:size-4 [&>svg]:shrink-0",
        showOnHover &&
          "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 md:opacity-0",
        className,
      ),
    },
  });

export const Sidebar = Object.assign(SidebarRoot, {
  Provider: SidebarProvider,
  Trigger: SidebarTrigger,
  Rail: SidebarRail,
  Inset: SidebarInset,
  Viewport: SidebarViewport,
  Header: SidebarHeader,
  Footer: SidebarFooter,
  Content: SidebarContent,
  Group: SidebarGroup,
  GroupLabel: SidebarGroupLabel,
  GroupContent: SidebarGroupContent,
  Menu: SidebarMenu,
  MenuItem: SidebarMenuItem,
  MenuButton: SidebarMenuButton,
  MenuAction: SidebarMenuAction,
});
