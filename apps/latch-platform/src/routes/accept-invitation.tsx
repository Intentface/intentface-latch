import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { authClient, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const Route = createFileRoute("/accept-invitation")({
  validateSearch: (s: Record<string, unknown>) => ({
    id: typeof s.id === "string" ? s.id : undefined,
  }),
  component: AcceptInvitation,
});

function AcceptInvitation() {
  const { id } = Route.useSearch();
  const { data: session, isPending } = useSession();
  const [status, setStatus] = useState<"idle" | "accepting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  // Once signed in with an invitation id, accept it and head into the app.
  useEffect(() => {
    if (ran.current || !id || !session) return;
    ran.current = true;
    setStatus("accepting");
    void authClient.organization
      .acceptInvitation({ invitationId: id })
      .then((res) => {
        if (res.error) {
          setError(res.error.message ?? "Couldn't accept the invitation.");
          setStatus("error");
        } else {
          // Full reload so the new org + its data resolve cleanly.
          window.location.href = "/chat";
        }
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Couldn't accept the invitation.");
        setStatus("error");
      });
  }, [id, session]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-4">
      <div className="text-ink-primary text-lg font-semibold tracking-tight">🔒 Latch</div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Organization invite</CardTitle>
          <CardDescription>
            {!id
              ? "This invitation link is invalid."
              : "Join the organization you were invited to."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!id ? (
            <Button render={<Link to="/login" />} className="w-full">
              Back to sign in
            </Button>
          ) : isPending ? (
            <p className="text-ink-secondary text-sm">Loading…</p>
          ) : !session ? (
            <div className="space-y-3">
              <p className="text-ink-secondary text-sm">
                Sign in or create your account to accept this invitation.
              </p>
              <Button render={<Link to="/login" search={{ invite: id }} />} className="w-full">
                Sign in
              </Button>
            </div>
          ) : status === "error" ? (
            <div className="space-y-3">
              <p className="text-destructive text-sm">{error}</p>
              <Button render={<Link to="/chat" />} variant="outline" className="w-full">
                Go to app
              </Button>
            </div>
          ) : (
            <p className="text-ink-secondary text-sm">Accepting invitation…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
