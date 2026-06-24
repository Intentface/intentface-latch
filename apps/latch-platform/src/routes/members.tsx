import { useCallback, useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient, useSession } from "@/lib/auth-client";
import { currentPrincipalFn } from "@/lib/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/members")({
  head: () => ({ meta: [{ title: "Members · Latch" }] }),
  beforeLoad: async () => {
    const principal = await currentPrincipalFn();
    if (!principal) throw redirect({ to: "/login" });
  },
  component: MembersPage,
});

type Role = "member" | "admin" | "owner";

type Member = {
  id: string;
  role: Role;
  createdAt?: string | Date;
  user?: { name?: string | null; email?: string | null };
};

type InviteStatus = "pending" | "accepted" | "rejected" | "canceled";

type Invitation = {
  id: string;
  email: string;
  role: Role;
  status: InviteStatus;
  expiresAt?: string | Date;
};

const inviteStatusVariant: Record<InviteStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  accepted: "secondary",
  rejected: "destructive",
  canceled: "destructive",
};

function fmtDate(d?: string | Date): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function MembersPage() {
  const { data: session } = useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const orgId = activeOrg?.id;

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    const res = await authClient.organization.getFullOrganization({ query: { organizationId: orgId } });
    setLoading(false);
    if (res.error) {
      setError(res.error.message ?? "Couldn't load members.");
      return;
    }
    const org = res.data as unknown as { members?: Member[]; invitations?: Invitation[] };
    setMembers(org?.members ?? []);
    setInvites(org?.invitations ?? []);
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Mutations ────────────────────────────────────────────────────────────
  async function run(key: string, fn: () => Promise<{ error?: { message?: string } | null }>) {
    setBusy(key);
    setError(null);
    const res = await fn();
    setBusy(null);
    if (res.error) {
      setError(res.error.message ?? "Action failed.");
      return;
    }
    await load();
  }

  const changeRole = (m: Member, role: Role) =>
    run(`role:${m.id}`, () =>
      authClient.organization.updateMemberRole({ memberId: m.id, role, organizationId: orgId }),
    );

  const remove = (m: Member) =>
    run(`remove:${m.id}`, () =>
      authClient.organization.removeMember({ memberIdOrEmail: m.id, organizationId: orgId }),
    );

  const cancel = (inv: Invitation) =>
    run(`cancel:${inv.id}`, () => authClient.organization.cancelInvitation({ invitationId: inv.id }));

  const pending = invites.filter((i) => i.status === "pending");
  const past = invites.filter((i) => i.status !== "pending");

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6 pt-14">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Members</h1>
          <p className="text-ink-secondary text-sm">
            {activeOrg ? activeOrg.name : "No active organization"}
            {members.length > 0 && ` · ${members.length} member${members.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>

      {!orgId ? (
        <p className="text-ink-secondary text-sm">
          Switch to an organization to manage its members.
        </p>
      ) : (
        <>
          {error && <p className="text-destructive text-sm">{error}</p>}

          <InviteForm orgId={orgId} onInvited={load} />

          {/* Members */}
          <section className="space-y-2">
            <h2 className="text-ink-secondary text-sm font-medium">Members</h2>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead className="w-px" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && members.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-ink-tertiary text-sm">
                        Loading…
                      </TableCell>
                    </TableRow>
                  ) : (
                    members.map((m) => {
                      const isSelf = m.user?.email === session?.user?.email;
                      return (
                        <TableRow key={m.id}>
                          <TableCell className="font-medium">
                            {m.user?.name ?? "—"}
                            {isSelf && <span className="text-ink-tertiary"> (you)</span>}
                          </TableCell>
                          <TableCell className="text-ink-secondary">{m.user?.email ?? "—"}</TableCell>
                          <TableCell>
                            <Select
                              value={m.role}
                              disabled={busy === `role:${m.id}` || m.role === "owner"}
                              onChange={(e) => changeRole(m, e.target.value as Role)}
                              className="h-8 w-28"
                            >
                              <option value="member">Member</option>
                              <option value="admin">Admin</option>
                              <option value="owner">Owner</option>
                            </Select>
                          </TableCell>
                          <TableCell className="text-ink-secondary">{fmtDate(m.createdAt)}</TableCell>
                          <TableCell>
                            {!isSelf && m.role !== "owner" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy === `remove:${m.id}`}
                                onClick={() => remove(m)}
                              >
                                Remove
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </section>

          {/* Invitations */}
          <section className="space-y-2">
            <h2 className="text-ink-secondary text-sm font-medium">
              Invitations{pending.length > 0 && ` · ${pending.length} pending`}
            </h2>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="w-px" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-ink-tertiary text-sm">
                        No invitations yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    [...pending, ...past].map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="font-medium">{inv.email}</TableCell>
                        <TableCell className="text-ink-secondary capitalize">{inv.role}</TableCell>
                        <TableCell>
                          <Badge variant={inviteStatusVariant[inv.status]} className="capitalize">
                            {inv.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-ink-secondary">{fmtDate(inv.expiresAt)}</TableCell>
                        <TableCell>
                          {inv.status === "pending" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy === `cancel:${inv.id}`}
                              onClick={() => cancel(inv)}
                            >
                              Cancel
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** Inline "invite by email" form, pinned to the active org. */
function InviteForm({ orgId, onInvited }: { orgId: string; onInvited: () => void | Promise<void> }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await authClient.organization.inviteMember({
      email: email.trim(),
      role,
      organizationId: orgId,
    });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Couldn't send the invite.");
      return;
    }
    setNotice(`Invite sent to ${email.trim()}.`);
    setEmail("");
    await onInvited();
  }

  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
      <Input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="name@intentface.com"
        className="max-w-xs flex-1"
        required
      />
      <Select value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-28">
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        <option value="owner">Owner</option>
      </Select>
      <Button type="submit" disabled={busy || !email.trim()}>
        {busy ? "…" : "Invite"}
      </Button>
      {error && <span className="text-destructive text-sm">{error}</span>}
      {notice && <span className="text-ink-secondary text-sm">{notice}</span>}
    </form>
  );
}
