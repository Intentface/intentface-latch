import { type ComponentType, useEffect, useState } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Bot,
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronsUpDown,
  FlaskConical,
  LogOut,
  MessageSquare,
  Plug,
  Plus,
  Settings as SettingsIcon,
  Telescope,
  UserPlus,
  Users,
  Wrench,
} from "lucide-react";
import { DisplaySettingsPanel } from "@/components/display-settings";
import { Dialog } from "@/components/ui/dialog";
import { Nav } from "@intentface/chat/nav";
import { listAgentsFn, recentChatsFn } from "@/lib/server";
import { AgentPickerDialog, type PickableAgent } from "@/components/agent-picker-dialog";
import { authClient, signOut, useSession } from "@/lib/auth-client";
import { LatchLogo } from "@/components/latch-logo";
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

const NAV_BEFORE_EVALS: NavItem[] = [
  { to: "/chat", label: "Chats", icon: MessageSquare },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/runs", label: "Runs", icon: Activity },
  { to: "/observability", label: "Observability", icon: Telescope },
];
const EVALS_PAGES: { to: "/evals" | "/evals/failures"; label: string }[] = [
  { to: "/evals", label: "Results" },
  { to: "/evals/failures", label: "Failures" },
];
const NAV_AFTER_EVALS: NavItem[] = [
  { to: "/schedules", label: "Schedules", icon: CalendarClock },
  { to: "/connections", label: "Connections", icon: Plug },
  { to: "/tools", label: "Tools", icon: Wrench },
  { to: "/members", label: "Members", icon: Users },
];

/**
 * One row style for leaves and group headings alike — in a sidebar they are
 * the same thing you click; the only visible difference is the chevron. The
 * explicit height is load-bearing (14px text has a fractional line-height),
 * and no `truncate` on the row: overflow would clip the rail's pseudo-elements.
 */
const rowClass = [
  "group/row flex h-8 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-md/none no-underline",
  "text-ink-secondary transition-colors hover:bg-base-bg-hover hover:text-ink-primary",
  "focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink-primary",
  "data-[active]:bg-base-bg-hover data-[active]:text-ink-primary",
  "[&_svg]:size-4 [&_svg]:shrink-0",
].join(" ");

/** The disclosure arrow — this sidebar's convention, not the widget's. It turns with its group. */
const Chevron = () => <ChevronDown className="text-ink-tertiary ml-auto !size-3.5 transition-transform group-data-[closed]/row:-rotate-90" />;

/**
 * What the sidebar holds: the header with its collapse control, New chat, the
 * navigation tree and recent threads, and the account menu. The frame around
 * it — collapse, hover-peek, resizing — is the Shell's (see app-shell.tsx);
 * on a phone the same content sits in a drawer.
 */
export function AppSidebarContent({ trigger }: { trigger?: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [chats, setChats] = useState<
    { id: string; title: string | null; agent: string; lastRunStatus?: string | null }[]
  >([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // New Chat opens the searchable agent palette; the list is fetched on first
  // open (the sidebar renders on every page — don't load 25 agents up front).
  const [pickerAgents, setPickerAgents] = useState<PickableAgent[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const openPicker = () => {
    setPickerOpen(true);
    if (pickerAgents === null) {
      listAgentsFn()
        .then((agents) => setPickerAgents(agents))
        .catch(() => setPickerAgents([]));
    }
  };
  const [inviteOpen, setInviteOpen] = useState(false);

  // Recent threads. The list only changes while in the chat area (new chats,
  // renamed titles), so key the refetch on the chat path — navigating among
  // other pages (/agents, /runs, …) collapses to one key and skips the fetch.
  const chatKey = pathname.startsWith("/chat") ? pathname : "other";
  useEffect(() => {
    if (!session) {
      setChats([]);
      return;
    }
    let cancelled = false;
    const load = () =>
      void recentChatsFn()
        .then((c) => !cancelled && setChats(c as typeof chats))
        .catch(() => {});
    load();
    // A run can park waiting on the user with no navigation at all (a cron
    // fire) — poll slowly so the waiting dot appears without moving around.
    const poll = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [session, chatKey]);

  // Groups: Threads open by default; Evals opens whenever you are on an Evals page.
  const onEvals = pathname === "/evals" || pathname.startsWith("/evals/");
  const [expanded, setExpanded] = useState<string[]>(() => ["threads", ...(onEvals ? ["evals"] : [])]);
  useEffect(() => {
    if (onEvals) setExpanded((e) => (e.includes("evals") ? e : [...e, "evals"]));
  }, [onEvals]);

  const active = (to: string) => pathname === to || pathname.startsWith(`${to}/`);
  const item = ({ to, label, icon: Icon }: NavItem) => (
    <Nav.Item key={to} value={to} active={active(to)} className={rowClass} render={<Link to={to} />}>
      <Nav.Icon>
        <Icon />
      </Nav.Icon>
      <Nav.Label className="min-w-0 truncate">{label}</Nav.Label>
    </Nav.Item>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 pr-2 pl-3">
        <Link to="/" className="inline-flex">
          <LatchLogo className="h-7 w-auto" />
        </Link>
        {trigger}
      </div>

      {session && (
        <Nav.Root
          aria-label="Main"
          guide="none"
          expanded={expanded}
          onExpandedChange={setExpanded}
          render={<nav />}
          className="app-nav flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-2 pb-2"
        >
          <Nav.List className="flex flex-col gap-0.5">
            <Nav.Item value="new-chat" active={pathname === "/chat"} className={rowClass} onClick={openPicker}>
              <Nav.Icon>
                <Plus />
              </Nav.Icon>
              <Nav.Label className="min-w-0 truncate">New Chat</Nav.Label>
            </Nav.Item>

            <div aria-hidden className="h-3" />

            {NAV_BEFORE_EVALS.map(item)}
            <Nav.Group value="evals">
              <Nav.Trigger active={onEvals && !expanded.includes("evals")} className={rowClass}>
                <Nav.Icon>
                  <FlaskConical />
                </Nav.Icon>
                <Nav.Label className="min-w-0 truncate">Evals</Nav.Label>
                <Chevron />
              </Nav.Trigger>
              <Nav.List guide="rail" className="flex flex-col gap-0.5">
                {EVALS_PAGES.map((p) => (
                  <Nav.Item key={p.to} value={p.to} active={pathname === p.to} className={rowClass} render={<Link to={p.to} />}>
                    <Nav.Label className="min-w-0 truncate">{p.label}</Nav.Label>
                  </Nav.Item>
                ))}
              </Nav.List>
            </Nav.Group>
            {NAV_AFTER_EVALS.map(item)}

            {chats.length > 0 && (
              <Nav.Group value="threads" className="mt-3">
                <Nav.Trigger className={rowClass}>
                  <Nav.Label className="text-ink-tertiary min-w-0 truncate text-xs font-medium">Threads</Nav.Label>
                  <Chevron />
                </Nav.Trigger>
                <Nav.List className="flex flex-col gap-0.5">
                  {chats.map((c) => (
                    <Nav.Item
                      key={c.id}
                      value={`chat:${c.id}`}
                      active={pathname === `/chat/${c.id}`}
                      className={rowClass}
                      render={<Link to="/chat/$chatId" params={{ chatId: c.id }} search={{ agent: undefined }} />}
                    >
                      <Nav.Label className="min-w-0 flex-1 truncate">{c.title?.trim() || c.agent}</Nav.Label>
                      {c.lastRunStatus === "awaiting_input" && (
                        <>
                          {/* Part of the LINK's accessible name — an
                              aria-label on a bare span never reaches it. */}
                          <span className="sr-only">— waiting for your input</span>
                          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500" title="Waiting for your input" />
                        </>
                      )}
                    </Nav.Item>
                  ))}
                </Nav.List>
              </Nav.Group>
            )}
          </Nav.List>
        </Nav.Root>
      )}
      {!session && <div className="flex-1" />}

      {pickerOpen && pickerAgents !== null && (
        <AgentPickerDialog agents={pickerAgents} onClose={() => setPickerOpen(false)} />
      )}

      <div className="flex shrink-0 flex-col gap-2 p-2">
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
            <Button variant="ghost" size="icon" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
              <SettingsIcon className="size-4" />
            </Button>
          </div>
        )}
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        {session && <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />}
      </div>
    </div>
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

/** Settings modal: the same display-options panel the chat's gear opens. */
function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="max-w-md p-0">
        <div className="p-4 pb-0">
          <Dialog.Title>Settings</Dialog.Title>
          <Dialog.Description>Theme and thread preferences.</Dialog.Description>
        </div>
        <div className="mt-4">
          <DisplaySettingsPanel />
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
