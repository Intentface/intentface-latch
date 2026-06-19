import { createFileRoute, Link } from "@tanstack/react-router";
import { useSession } from "@/lib/auth-client";
import { Chat } from "@/components/chat";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return <div className="text-muted-foreground p-8 text-sm">Loading…</div>;
  }

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-2xl font-semibold">🔒 Latch Platform</h1>
        <p className="text-muted-foreground max-w-md">
          Run durable, multi-tenant agents and try every Latch feature. Sign in to start.
        </p>
        <Button render={<Link to="/login" />}>Sign in</Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <Chat />
    </div>
  );
}
