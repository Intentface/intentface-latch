import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  currentPrincipalFn,
  connectionsStatusFn,
  connectionKeysFn,
  setConnectionKeyFn,
  listConnectionsFn,
  addConnectionFn,
  removeConnectionFn,
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
    const [oauth, keys, dynamic] = await Promise.all([
      connectionsStatusFn(),
      connectionKeysFn(),
      listConnectionsFn(),
    ]);
    return { oauth, keys, dynamic };
  },
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const { oauth, keys, dynamic } = Route.useLoaderData();

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Connections</h1>

      <AddConnection />

      {dynamic.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-muted-foreground text-xs font-medium uppercase">Your connections</h2>
          {dynamic.map((c) => (
            <DynamicCard key={`${c.scope}:${c.name}`} conn={c} />
          ))}
        </div>
      )}

      {(oauth.length > 0 || keys.length > 0) && (
        <h2 className="text-muted-foreground text-xs font-medium uppercase">Built-in</h2>
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

function AddConnection() {
  const router = useRouter();
  const [kind, setKind] = useState<"mcp" | "openapi">("openapi");
  const [scope, setScope] = useState<"user" | "org">("user");
  const [name, setName] = useState("");
  const [target, setTarget] = useState(""); // url (mcp) or spec url (openapi)
  const [baseUrl, setBaseUrl] = useState("");
  const [operations, setOperations] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !target.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await addConnectionFn({
        data: {
          name,
          kind,
          scope,
          url: kind === "mcp" ? target : undefined,
          spec: kind === "openapi" ? target : undefined,
          baseUrl: baseUrl || undefined,
          operations: operations || undefined,
          authHeader: authHeader || undefined,
          token: token || undefined,
        },
      });
      if (!res.ok) {
        setError(res.error ?? "Failed to add");
        return;
      }
      setName(""); setTarget(""); setBaseUrl(""); setOperations(""); setAuthHeader(""); setToken("");
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  const sel = "border-input bg-background h-9 rounded-md border px-2 text-sm";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a connection</CardTitle>
        <CardDescription>
          Point an agent at any MCP server or OpenAPI (REST) API. The token is
          stored envelope-encrypted in the Vault and brokered server-side — it
          never reaches the model. Scope it to <span className="font-medium">you</span> or
          your whole <span className="font-medium">org</span>. An agent uses it by listing the
          name in its connections.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-2" onSubmit={submit}>
          <div className="flex gap-2">
            <select className={sel} value={kind} onChange={(e) => setKind(e.target.value as never)}>
              <option value="openapi">OpenAPI</option>
              <option value="mcp">MCP</option>
            </select>
            <select className={sel} value={scope} onChange={(e) => setScope(e.target.value as never)}>
              <option value="user">Personal</option>
              <option value="org">Org</option>
            </select>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. github)" />
          </div>
          <Input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={kind === "mcp" ? "MCP server URL" : "OpenAPI spec URL"}
          />
          {kind === "openapi" && (
            <div className="flex gap-2">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="base URL (if spec has no servers)" />
              <Input value={operations} onChange={(e) => setOperations(e.target.value)} placeholder="operations allow-list (comma-sep, optional)" />
            </div>
          )}
          <div className="flex gap-2">
            <Input
              className="max-w-[12rem]"
              value={authHeader}
              onChange={(e) => setAuthHeader(e.target.value)}
              placeholder="auth header (blank = Bearer)"
            />
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="token / API key (optional)"
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button type="submit" disabled={busy || !name.trim() || !target.trim()}>
            Add connection
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function DynamicCard({
  conn,
}: {
  conn: { name: string; kind: string; scope: string; target: string; hasAuth: boolean };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    await removeConnectionFn({ data: { name: conn.name, scope: conn.scope as "user" | "org" } });
    await router.invalidate();
    setBusy(false);
  }
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{conn.name}</span>
            <Badge variant="secondary">{conn.kind}</Badge>
            <Badge variant="outline">{conn.scope === "org" ? "org" : "personal"}</Badge>
            {conn.hasAuth && <Badge variant="outline">key set</Badge>}
          </div>
          <p className="text-muted-foreground truncate text-xs">{conn.target}</p>
        </div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>
          Delete
        </Button>
      </CardContent>
    </Card>
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
