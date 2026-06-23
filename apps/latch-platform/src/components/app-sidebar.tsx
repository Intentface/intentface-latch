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
import { Sidebar, ThemeCustomizer } from "@intentface/latch-ui";
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

const ACTIVE = { className: "bg-base-active text-ink-primary" };

export function AppSidebar() {
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
    <Sidebar>
      <Sidebar.Header>
        <Link to="/" className="px-1 text-sm font-semibold tracking-tight">
          🔒 Latch
        </Link>
      </Sidebar.Header>

      <Sidebar.Content className="px-2">
        {session && (
          <Sidebar.Group>
            <Sidebar.Menu>
              {NAV.map(({ to, label, icon: Icon }) => (
                <Sidebar.MenuItem key={to}>
                  <Sidebar.MenuButton
                    render={
                      <Link to={to} activeProps={ACTIVE}>
                        <Icon />
                        <span>{label}</span>
                      </Link>
                    }
                  />
                </Sidebar.MenuItem>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        )}

        {session && chats.length > 0 && (
          <Sidebar.Group>
            <Sidebar.GroupLabel>Recent</Sidebar.GroupLabel>
            <Sidebar.GroupContent>
              <Sidebar.Menu>
                {chats.slice(0, 20).map((c) => (
                  <Sidebar.MenuItem key={c.id}>
                    <Sidebar.MenuButton
                      size="sm"
                      render={
                        <Link
                          to="/chat/$chatId"
                          params={{ chatId: c.id }}
                          search={{ agent: undefined }}
                          activeProps={ACTIVE}
                        >
                          <span>{c.title?.trim() || c.agent}</span>
                        </Link>
                      }
                    />
                  </Sidebar.MenuItem>
                ))}
              </Sidebar.Menu>
            </Sidebar.GroupContent>
          </Sidebar.Group>
        )}
      </Sidebar.Content>

      <Sidebar.Footer>
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
      </Sidebar.Footer>
    </Sidebar>
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
