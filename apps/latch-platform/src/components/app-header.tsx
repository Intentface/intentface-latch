import { Link, useRouter } from "@tanstack/react-router";
import { Building2, ChevronDown, LogOut, Plus } from "lucide-react";
import { authClient, signOut, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AppHeader() {
  const { data: session, isPending } = useSession();
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const router = useRouter();

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
    <header className="flex items-center justify-between border-b px-4 py-2">
      <div className="flex items-center gap-4">
        <Link to="/" className="font-semibold tracking-tight">
          🔒 Latch
        </Link>
        {session && (
          <nav className="text-muted-foreground flex gap-3 text-sm">
            <Link to="/chat" activeProps={{ className: "text-foreground font-medium" }}>
              Chats
            </Link>
            <Link to="/runs" activeProps={{ className: "text-foreground font-medium" }}>
              Runs
            </Link>
            <Link to="/connections" activeProps={{ className: "text-foreground font-medium" }}>
              Connections
            </Link>
          </nav>
        )}
      </div>

      {isPending ? null : session ? (
        <div className="flex items-center gap-2">
          {/* Org switcher = the tenant boundary */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" className="gap-1" />}
            >
              <Building2 className="size-4" />
              {activeOrg?.name ?? "Personal"}
              <ChevronDown className="size-3 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {(orgs ?? []).map((o) => (
                <DropdownMenuItem key={o.id} onClick={() => switchOrg(o.id)}>
                  {o.name}
                  {activeOrg?.id === o.id && <span className="ml-auto text-xs opacity-60">active</span>}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={createOrg}>
                <Plus className="size-4" /> New organization
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* User */}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
              {session.user.email}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => signOut().then(() => router.invalidate())}>
                <LogOut className="size-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <Button render={<Link to="/login" />} size="sm">
          Sign in
        </Button>
      )}
    </header>
  );
}
