import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { currentPrincipalFn, connectionsStatusFn } from "@/lib/server";
import {
  authorizeUrl,
  disconnectConnection,
  testConnection,
} from "@/lib/latch-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const Route = createFileRoute("/connections")({
  beforeLoad: async () => {
    if (!(await currentPrincipalFn())) throw redirect({ to: "/login" });
  },
  loader: () => connectionsStatusFn(),
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const connections = Route.useLoaderData();

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Connections</h1>
      {connections.length === 0 && (
        <p className="text-muted-foreground text-sm">No connections configured.</p>
      )}
      {connections.map((c) => (
        <ConnectionCard key={c.name} connection={c} />
      ))}
    </div>
  );
}

function ConnectionCard({
  connection,
}: {
  connection: {
    name: string;
    description?: string;
    oauth: boolean;
    authorized: boolean;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setBusy(true);
    await disconnectConnection(connection.name);
    setTools(null);
    await router.invalidate();
    setBusy(false);
  }

  async function test() {
    setBusy(true);
    setError(null);
    try {
      const res = await testConnection(connection.name);
      setTools(res);
      if (res.length === 0) setError("Connected, but no tools were returned.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 capitalize">
          {connection.name}
          <Badge variant={connection.authorized ? "secondary" : "outline"}>
            {connection.authorized ? "connected" : "not connected"}
          </Badge>
        </CardTitle>
        <CardDescription>
          {connection.description ?? "MCP connection."}{" "}
          {connection.oauth &&
            "Tokens are stored envelope-encrypted in the Vault, scoped to this org, and brokered server-side — they never reach the model or the browser."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connection.authorized ? (
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={test}>
              Test &amp; list tools
            </Button>
            {connection.oauth && (
              <Button variant="destructive" disabled={busy} onClick={disconnect}>
                Disconnect
              </Button>
            )}
          </div>
        ) : (
          <Button
            disabled={busy}
            onClick={() => {
              window.location.href = authorizeUrl(connection.name, {
                returnTo: "/connections",
              });
            }}
          >
            Connect {connection.name}
          </Button>
        )}

        {error && <p className="text-destructive text-sm">{error}</p>}
        {tools && tools.length > 0 && (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">
              {tools.length} tools available to the agent:
            </p>
            <div className="flex flex-wrap gap-1">
              {tools.map((t) => (
                <Badge key={t} variant="secondary">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
