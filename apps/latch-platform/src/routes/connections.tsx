import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  currentPrincipalFn,
  connectionsStatusFn,
  connectionKeysFn,
  setConnectionKeyFn,
} from "@/lib/server";
import {
  authorizeUrl,
  disconnectConnection,
  testConnection,
} from "@/lib/latch-client";
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
  loader: async () => {
    const [oauth, keys] = await Promise.all([connectionsStatusFn(), connectionKeysFn()]);
    return { oauth, keys };
  },
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const { oauth, keys } = Route.useLoaderData();

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Connections</h1>
      {oauth.length === 0 && keys.length === 0 && (
        <p className="text-muted-foreground text-sm">No connections configured.</p>
      )}
      {oauth.map((c) => (
        <ConnectionCard key={c.name} connection={c} />
      ))}
      {keys.map((k) => (
        <ApiKeyCard key={k.name} conn={k} />
      ))}
    </div>
  );
}

function ApiKeyCard({
  conn,
}: {
  conn: { name: string; label: string; scope: string; set: boolean };
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await setConnectionKeyFn({ data: { name: conn.name, value: value.trim() } });
      setValue("");
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 capitalize">
          {conn.label}
          <Badge variant={conn.set ? "secondary" : "outline"}>
            {conn.set ? "key set" : "no key"}
          </Badge>
          <Badge variant="outline">{conn.scope}-level</Badge>
        </CardTitle>
        <CardDescription>
          REST API (OpenAPI). The API key is stored envelope-encrypted in the Vault
          at the <span className="font-medium">{conn.scope}</span> scope and brokered
          server-side — it never reaches the model or the browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={conn.set ? "Replace API key…" : "Paste API key…"}
        />
        <Button disabled={busy || !value.trim()} onClick={save}>
          Save
        </Button>
      </CardContent>
    </Card>
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
