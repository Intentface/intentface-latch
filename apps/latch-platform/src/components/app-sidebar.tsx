import type { ComponentType } from "react";
import { Link, useRouter } from "@tanstack/react-router";
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

export function AppSidebar() {
  const { data: session, isPending } = useSession();

  return (
    <aside className="bg-secondary border-primary-border flex h-screen w-56 shrink-0 flex-col border-r">
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
