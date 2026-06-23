import { type ComponentType, useEffect, useState } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { Popover } from "@base-ui/react/popover";
import {
  Activity,
  Bot,
  Building2,
  CalendarClock,
  ChevronsUpDown,
  LogOut,
  MessageSquare,
  Palette,
  Plug,
  Plus,
} from "lucide-react";
import { ThemeCustomizer } from "@intentface/latch-ui";
import { cn } from "@/lib/utils";
import { listChatsFn } from "@/lib/server";
import { authClient, signOut, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type NavItem = { to: string; label: string; icon: ComponentType<{ className?: string }> };

const NAV: NavItem[] = [
  { to: "/chat", label: "Chats", icon: MessageSquare },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/runs", label: "Runs", icon: Activity },
  { to: "/schedules", label: "Schedules", icon: CalendarClock },
  { to: "/connections", label: "Connections", icon: Plug },
];

export function AppSidebar({ open = true }: { open?: boolean }) {
  const { data: session, isPending } = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [chats, setChats] = useState<{ id: string; title: string | null; agent: string }[]>([]);

  // Recent threads for the sidebar; refetch on navigation so new chats appear.
  useEffect(() => {
    if (!session) {
      setChats([]);
      return;
    }
    let cancelled = false;
    void listChatsFn()
      .then((c) => !cancelled && setChats(c as typeof chats))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, pathname]);

  return (
    <aside
      className={cn(
        "h-screen shrink-0 overflow-hidden transition-[width] duration-200 ease-out",
        open ? "w-60" : "w-0",
      )}
    >
      <div className="flex h-full w-60 flex-col">
      <div className="flex items-center gap-2 px-4 py-3">
        <Link to="/" className="text-sm font-semibold tracking-tight">
          🔒 Latch
        </Link>
      </div>

      {session && (
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="text-ink-secondary hover:bg-primary-hover hover:text-ink-primary flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors"
              activeProps={{ className: "bg-tertiary text-ink-primary" }}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
      )}

      {session && chats.length > 0 && (
        <div className="mt-3 flex min-h-0 flex-1 flex-col px-2">
          <p className="text-ink-tertiary px-2.5 pb-1 text-xs font-medium tracking-wide uppercase">
            Recent
          </p>
          <div className="flex flex-col gap-0.5 overflow-y-auto">
            {chats.slice(0, 20).map((c) => (
              <Link
                key={c.id}
                to="/chat/$chatId"
                params={{ chatId: c.id }}
                search={{ agent: undefined }}
                className="text-ink-secondary hover:bg-primary-hover hover:text-ink-primary truncate rounded-md px-2.5 py-1 text-sm transition-colors"
                activeProps={{ className: "bg-tertiary text-ink-primary" }}
              >
                {c.title?.trim() || c.agent}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-1 p-2">
        {isPending ? null : session ? (
          <>
            <OrgSwitcher />
            <div className="flex items-center gap-1">
              <ThemePopover />
              <UserMenu email={session.user.email} />
            </div>
          </>
        ) : (
          <>
            <ThemePopover />
            <Button render={<Link to="/login" />} size="sm" className="w-full">
              Sign in
            </Button>
          </>
        )}
      </div>
      </div>
    </aside>
  );
}

function OrgSwitcher() {
  const router = useRouter();
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();

  async function createOrg() {
    const name = window.prompt("Organization name?");
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const res = await authClient.organization.create({ name, slug });
    if (res.data) await authClient.organization.setActive({ organizationId: res.data.id });
    router.invalidate();
  }
  async function switchOrg(organizationId: string) {
    await authClient.organization.setActive({ organizationId });
    router.invalidate();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="w-full justify-start gap-2" />}
      >
        <Building2 className="size-4" />
        <span className="truncate">{activeOrg?.name ?? "Personal"}</span>
        <ChevronsUpDown className="ml-auto size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {(orgs ?? []).map((o) => (
            <DropdownMenuItem key={o.id} onClick={() => switchOrg(o.id)}>
              {o.name}
              {activeOrg?.id === o.id && <span className="ml-auto text-xs opacity-60">active</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={createOrg}>
          <Plus className="size-4" /> New organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ email }: { email: string }) {
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" />}>
        <span className="truncate">{email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => signOut().then(() => router.invalidate())}>
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Theme/customizer popover (mode, presets, seed colors, contrast). */
function ThemePopover() {
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button variant="ghost" size="icon" aria-label="Theme" />}>
        <Palette className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6}>
          <Popover.Popup className="border-primary-border bg-primary z-50 rounded-xl border p-4 shadow-lg outline-none">
            <ThemeCustomizer />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
