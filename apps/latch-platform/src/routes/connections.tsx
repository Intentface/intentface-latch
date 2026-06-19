import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { currentPrincipalFn } from "@/lib/chats.server";
import {
  connectionStatusFn,
  disconnectLoredexFn,
  saveLoredexTokenFn,
  testLoredexFn,
} from "@/lib/connections.server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  loader: () => connectionStatusFn(),
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const status = Route.useLoaderData();
  const router = useRouter();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!token.trim()) return;
    setBusy(true);
    await saveLoredexTokenFn({ data: token });
    setToken("");
    await router.invalidate();
    setBusy(false);
  }

  async function disconnect() {
    setBusy(true);
    await disconnectLoredexFn();
    setTools(null);
    await router.invalidate();
    setBusy(false);
  }

  async function test() {
    setBusy(true);
    setError(null);
    try {
      const res = await testLoredexFn();
      setTools(res.tools);
      if (res.tools.length === 0) setError("Connected, but no tools were returned (check the token).");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Connections</h1>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Loredex
            <Badge variant={status.loredex ? "secondary" : "outline"}>
              {status.loredex ? "connected" : "not connected"}
            </Badge>
          </CardTitle>
          <CardDescription>
            The Loredex knowledge base over MCP. Your API token is stored
            envelope-encrypted in the Vault, scoped to this org, and brokered
            server-side — it never reaches the model or the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {status.loredex ? (
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy} onClick={test}>
                Test &amp; list tools
              </Button>
              <Button variant="destructive" disabled={busy} onClick={disconnect}>
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="Loredex API token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button disabled={busy || !token.trim()} onClick={save}>
                Connect
              </Button>
            </div>
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}
          {tools && tools.length > 0 && (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs">
                {tools.length} tools available to the agent:
              </p>
              <div className="flex flex-wrap gap-1">
                {tools.map((t) => (
                  <Badge key={t} variant="secondary">{t}</Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
