import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useSession } from "@/lib/auth-client";
import { LatchLogo } from "@/components/latch-logo";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return <div className="text-muted-foreground p-8 text-sm">Loading…</div>;
  }

  if (session) return <Navigate to="/chat" />;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <LatchLogo className="h-9 w-auto" />
      <p className="text-muted-foreground max-w-md">
        Run durable, multi-tenant agents and try every Latch feature. Sign in to start.
      </p>
      <Button render={<Link to="/login" />}>Sign in</Button>
    </div>
  );
}
