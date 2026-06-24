import { type ComponentType, useEffect, useState } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Bot,
  Building2,
  CalendarClock,
  Check,
  ChevronsUpDown,
  LogOut,
  MessageSquare,
  Plug,
  Plus,
  Settings as SettingsIcon,
  UserPlus,
  Users,
} from "lucide-react";
import {
  Dialog,
  Sidebar,
  ThemeCustomizer,
  useSettingsStore,
  type ThreadAutoScrollMode,
} from "@intentface/latch-ui";
import { listChatsFn } from "@/lib/server";
import { authClient, signOut, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
  { to: "/members", label: "Members", icon: Users },
];

const ACTIVE = { className: "bg-base-active text-ink-primary" };

export function AppSidebar() {
  const { data: session, isPending } = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [chats, setChats] = useState<{ id: string; title: string | null; agent: string }[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

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
          <AccountMenu
            email={session.user.email}
            onSettings={() => setSettingsOpen(true)}
            onInvite={() => setInviteOpen(true)}
          />
        ) : (
          <div className="flex items-center gap-1">
            <Button render={<Link to="/login" />} size="sm" className="min-w-0 flex-1">
              Sign in
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon className="size-4" />
            </Button>
          </div>
        )}
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        {session && <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />}
      </Sidebar.Footer>
    </Sidebar>
  );
}

/** One menu for the account: org switch, invite, settings, sign out. */
function AccountMenu({
  email,
  onSettings,
  onInvite,
}: {
  email: string;
  onSettings: () => void;
  onInvite: () => void;
}) {
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
    const res = await authClient.organization.setActive({ organizationId });
    if (res?.error) {
      console.error("[org] setActive failed", res.error);
      window.alert(`Couldn't switch org: ${res.error.message ?? "unknown error"}`);
      return;
    }
    // Full reload so every org-scoped loader + the session re-resolve cleanly.
    window.location.reload();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" className="h-auto w-full justify-start gap-2 py-1.5" />}
      >
        <div className="bg-tertiary text-ink-secondary grid size-7 shrink-0 place-items-center rounded-md">
          <Building2 className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="text-ink-primary truncate text-sm font-medium">
            {activeOrg?.name ?? "Personal"}
          </div>
          <div className="text-ink-tertiary truncate text-xs">{email}</div>
        </div>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {(orgs ?? []).map((o) => (
            <DropdownMenuItem key={o.id} onClick={() => switchOrg(o.id)}>
              <Building2 className="size-4" />
              <span className="truncate">{o.name}</span>
              {activeOrg?.id === o.id && <Check className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={createOrg}>
            <Plus className="size-4" /> New organization
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onInvite}>
            <UserPlus className="size-4" /> Invite member
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSettings}>
          <SettingsIcon className="size-4" /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => signOut().then(() => router.invalidate())}>
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SCROLL_MODES: { value: ThreadAutoScrollMode; label: string }[] = [
  { value: "follow", label: "Follow — land at top, stick while streaming" },
  { value: "bottom", label: "Bottom — always stick to the latest" },
  { value: "jump", label: "Jump — land at top, no auto-follow" },
  { value: "off", label: "Off — manual scrolling" },
];

/** Settings modal: theme customizer + chat scroll behavior. Controlled. */
function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const scrollMode = useSettingsStore((s) => s.scrollMode);
  const setScrollMode = useSettingsStore((s) => s.setScrollMode);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="max-w-md">
        <Dialog.Title>Settings</Dialog.Title>
        <Dialog.Description>Theme and chat preferences.</Dialog.Description>
        <div className="mt-5 space-y-6">
          <ThemeCustomizer className="w-full" />
          <div className="space-y-2">
            <label className="text-ink-secondary text-xs font-medium">Auto-scroll</label>
            <Select
              className="w-full"
              value={scrollMode}
              onChange={(e) => setScrollMode(e.target.value as ThreadAutoScrollMode)}
            >
              {SCROLL_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}

/** Invite someone to the active org by email (better-auth org invitation). */
function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin" | "owner">("member");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await authClient.organization.inviteMember({
      email: email.trim(),
      role,
      // Pin to the active org explicitly so the invite can never land on the
      // wrong tenant if the session's active org is mid-sync.
      organizationId: activeOrg?.id,
    });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Couldn't send the invite.");
    else {
      setNotice(`Invite sent to ${email.trim()}.`);
      setEmail("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="max-w-md">
        <Dialog.Title>Invite member</Dialog.Title>
        <Dialog.Description>
          {activeOrg
            ? `Invite someone to ${activeOrg.name} by email. They'll get a link to join.`
            : "Switch to an organization first, then invite members to it."}
        </Dialog.Description>
        {activeOrg && (
          <form className="mt-4 space-y-3" onSubmit={invite}>
            <div className="flex gap-2">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@intentface.com"
                required
              />
              <Select value={role} onChange={(e) => setRole(e.target.value as never)}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </Select>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            {notice && <p className="text-ink-secondary text-sm">{notice}</p>}
            <Button type="submit" className="w-full" disabled={busy || !email.trim()}>
              {busy ? "…" : "Send invite"}
            </Button>
          </form>
        )}
      </Dialog.Content>
    </Dialog>
  );
}
