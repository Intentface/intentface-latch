import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Braces, KeyRound, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { Dialog } from "@intentface/latch-ui";
import { cn } from "@/lib/utils";
import {
  currentPrincipalFn,
  connectionsStatusFn,
  connectionKeysFn,
  setConnectionKeyFn,
  listConnectionsFn,
  getConnectionFn,
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
import { Select } from "@/components/ui/select";
import { RichSelect } from "@/components/ui/rich-select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export const Route = createFileRoute("/connections")({
  head: () => ({ meta: [{ title: "Connections · Latch" }] }),
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
  const [addOpen, setAddOpen] = useState(false);
  const empty = dynamic.length === 0 && oauth.length === 0 && keys.length === 0;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-ink-primary text-lg font-semibold tracking-tight">Connections</h1>
          <p className="text-ink-secondary mt-0.5 text-sm">
            MCP servers and REST (OpenAPI) APIs your agents can use. Tokens are stored
            envelope-encrypted in the Vault and brokered server-side.
          </p>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <Dialog.Trigger render={<Button className="shrink-0 gap-1.5" />}>
            <Plus className="size-4" /> Add
          </Dialog.Trigger>
          <Dialog.Content className="max-w-md">
            <Dialog.Title>Add a connection</Dialog.Title>
            <Dialog.Description>
              Point an agent at any MCP server or OpenAPI (REST) API. The token is stored
              envelope-encrypted in the Vault and brokered server-side — it never reaches the
              model. Scope it to you or your whole org.
            </Dialog.Description>
            <div className="mt-4">
              <AddConnection onDone={() => setAddOpen(false)} />
            </div>
          </Dialog.Content>
        </Dialog>
      </div>

      {dynamic.length > 0 && (
        <Section label="Your connections">
          {dynamic.map((c) => (
            <DynamicCard key={`${c.scope}:${c.name}`} conn={c} />
          ))}
        </Section>
      )}

      {(oauth.length > 0 || keys.length > 0) && (
        <Section label="Built-in">
          {oauth.map((c) => (
            <ConnectionCard key={c.name} connection={c} />
          ))}
          {keys.map((k) => (
            <ApiKeyCard key={k.name} conn={k} />
          ))}
        </Section>
      )}

      {empty && (
        <div className="border-primary-border text-ink-tertiary flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <Plug className="size-6 opacity-60" />
          <p className="text-sm">No connections yet. Add one to give your agents tools.</p>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h2 className="text-ink-tertiary text-xs font-medium tracking-wide uppercase">{label}</h2>
      {children}
    </div>
  );
}

/** The prefill payload for edit mode — what `getConnectionFn` returns. */
type EditableConnection = NonNullable<Awaited<ReturnType<typeof getConnectionFn>>>;

function AddConnection({
  onDone,
  initial,
}: {
  onDone?: () => void;
  /** When set, the form edits this connection: name/kind/scope are fixed and blank secrets keep the stored ones. */
  initial?: EditableConnection;
}) {
  const router = useRouter();
  const editing = initial != null;
  const [kind, setKind] = useState<"mcp" | "openapi">(initial?.kind ?? "openapi");
  const [scope, setScope] = useState<"user" | "org">(initial?.scope ?? "user");
  const [name, setName] = useState(initial?.name ?? "");
  // url (mcp) or spec url (openapi)
  const [target, setTarget] = useState(initial?.url ?? initial?.spec ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [operations, setOperations] = useState(initial?.operations ?? "");
  const [mcpAuth, setMcpAuth] = useState<"none" | "token" | "oauth">(
    initial?.kind === "mcp" && initial.authMode !== "oauth2" ? initial.authMode : "token",
  );
  const [apiAuth, setApiAuth] = useState<"none" | "token" | "oauth2">(
    initial?.kind === "openapi" && initial.authMode !== "oauth" ? initial.authMode : "token",
  );
  const [authHeader, setAuthHeader] = useState(initial?.authHeader ?? "");
  const [token, setToken] = useState(""); // never prefilled — secrets stay server-side
  const [authorizeEndpoint, setAuthorizeUrl] = useState(initial?.authorizeUrl ?? "");
  const [tokenEndpoint, setTokenUrl] = useState(initial?.tokenUrl ?? "");
  const [clientId, setClientId] = useState(initial?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState(""); // never prefilled
  const [scopes, setScopes] = useState(initial?.scopes ?? "");
  // Interactive OAuth has no static secret; the token row is irrelevant then.
  const oauth2Mode = kind === "openapi" && apiAuth === "oauth2";
  const oauthMode = (kind === "mcp" && mcpAuth === "oauth") || oauth2Mode;
  // A blank secret is fine when editing a connection that already has one.
  const secretOk = clientSecret.trim() !== "" || (editing && initial.hasClientSecret);
  const oauth2Missing =
    oauth2Mode &&
    !(authorizeEndpoint.trim() && tokenEndpoint.trim() && clientId.trim() && secretOk);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Spell out exactly what the current scope + auth choice means — scope decides
  // WHO sees the connection; for org connections the auth type decides WHOSE
  // token is used (shared static key vs each member's own OAuth login).
  const scopeHelp =
    scope === "user"
      ? "Personal — only you can see and use this connection, with your own token."
      : oauthMode
        ? "Org — everyone in your org sees it, but each person authorizes with their own account (per-user tokens; no shared secret)."
        : "Org — shared with everyone in your org, all using the one token/key you enter here.";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !target.trim() || oauth2Missing || busy) return;
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
          authMode: kind === "mcp" ? mcpAuth : apiAuth,
          authHeader: oauthMode ? undefined : authHeader || undefined,
          token: oauthMode ? undefined : token || undefined,
          authorizeUrl: oauth2Mode ? authorizeEndpoint : undefined,
          tokenUrl: oauth2Mode ? tokenEndpoint : undefined,
          clientId: oauth2Mode ? clientId : undefined,
          clientSecret: oauth2Mode ? clientSecret : undefined,
          scopes: oauth2Mode ? scopes || undefined : undefined,
        },
      });
      if (!res.ok) {
        setError(res.error ?? "Failed to add");
        return;
      }
      setName(""); setTarget(""); setBaseUrl(""); setOperations(""); setAuthHeader(""); setToken("");
      setAuthorizeUrl(""); setTokenUrl(""); setClientId(""); setClientSecret(""); setScopes("");
      await router.invalidate();
      onDone?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-2" onSubmit={submit}>
      {editing ? (
            // Identity is fixed while editing — the store upserts by (name, scope),
            // so changing either would create a second connection instead.
            <p className="text-ink-secondary text-sm">
              <span className="font-medium">{name}</span>
              <span className="text-ink-tertiary">
                {" "}· {kind.toUpperCase()} · {scope === "org" ? "org" : "personal"}
              </span>
            </p>
          ) : (
            <>
              <div className="flex gap-2">
                <Select value={kind} onChange={(e) => setKind(e.target.value as never)}>
                  <option value="openapi">OpenAPI</option>
                  <option value="mcp">MCP</option>
                </Select>
                <RichSelect
                  value={scope}
                  onValueChange={(v) => setScope(v as "user" | "org")}
                  className="min-w-[8rem]"
                  options={[
                    {
                      value: "user",
                      label: "Personal",
                      description: "Only you can see and use this connection, with your own token.",
                    },
                    {
                      value: "org",
                      label: "Org",
                      description: "Everyone in your org can use it — one shared token, or per-user with OAuth.",
                    },
                  ]}
                />
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. github)" />
              </div>
              <p className="text-ink-tertiary text-xs">{scopeHelp}</p>
            </>
          )}
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
          {kind === "mcp" && (
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              Authentication
              <RichSelect
                value={mcpAuth}
                onValueChange={(v) => setMcpAuth(v as "none" | "token" | "oauth")}
                className="min-w-[11rem]"
                options={[
                  { value: "token", label: "Token / API key", description: "Static token (org = one shared key)" },
                  { value: "oauth", label: "OAuth", description: "Authorize in browser (per-user tokens)" },
                  { value: "none", label: "None", description: "No authentication" },
                ]}
              />
            </label>
          )}
          {kind === "openapi" && (
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              Authentication
              <RichSelect
                value={apiAuth}
                onValueChange={(v) => setApiAuth(v as "none" | "token" | "oauth2")}
                className="min-w-[11rem]"
                options={[
                  { value: "token", label: "Token / API key", description: "Static token (org = one shared key)" },
                  { value: "oauth2", label: "OAuth2 app", description: "Pre-registered client — authorize in browser (per-user tokens)" },
                  { value: "none", label: "None", description: "No authentication" },
                ]}
              />
            </label>
          )}
          {oauth2Mode && (
            <>
              <div className="flex gap-2">
                <Input
                  value={authorizeEndpoint}
                  onChange={(e) => setAuthorizeUrl(e.target.value)}
                  placeholder="authorize URL (e.g. https://www.strava.com/oauth/authorize)"
                />
                <Input
                  value={tokenEndpoint}
                  onChange={(e) => setTokenUrl(e.target.value)}
                  placeholder="token URL (e.g. https://www.strava.com/oauth/token)"
                />
              </div>
              <div className="flex gap-2">
                <Input
                  className="max-w-[12rem]"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="client ID"
                />
                <Input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    editing && initial.hasClientSecret
                      ? "client secret (blank = keep current)"
                      : "client secret"
                  }
                />
                <Input
                  value={scopes}
                  onChange={(e) => setScopes(e.target.value)}
                  placeholder="scopes (space-separated; Strava: read,activity:read_all)"
                />
              </div>
            </>
          )}
          {!oauthMode && (
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
                placeholder={
                  editing && initial.hasToken
                    ? "token / API key (blank = keep current)"
                    : "token / API key (optional)"
                }
              />
            </div>
          )}
          {oauthMode && (
            <p className="text-muted-foreground text-xs">
              No token needed — after adding, click <span className="font-medium">Connect</span> to
              authorize. Tokens are stored per-user, envelope-encrypted in the Vault.
            </p>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
      <Button
        type="submit"
        className="w-full"
        disabled={busy || !name.trim() || !target.trim() || oauth2Missing}
      >
        {editing ? "Save changes" : "Add connection"}
      </Button>
    </form>
  );
}

function DynamicCard({
  conn,
}: {
  conn: {
    name: string;
    kind: string;
    scope: string;
    target: string;
    hasAuth: boolean;
    oauth: boolean;
    authorized: boolean;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editInitial, setEditInitial] = useState<EditableConnection | null>(null);
  async function openEdit() {
    setBusy(true);
    try {
      const c = await getConnectionFn({
        data: { name: conn.name, scope: conn.scope as "user" | "org" },
      });
      if (c) {
        setEditInitial(c);
        setEditOpen(true);
      }
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    await removeConnectionFn({ data: { name: conn.name, scope: conn.scope as "user" | "org" } });
    await router.invalidate();
    setBusy(false);
  }
  async function disconnect() {
    setBusy(true);
    await disconnectConnection(conn.name);
    await router.invalidate();
    setBusy(false);
  }
  const Icon = conn.kind === "mcp" ? Plug : Braces;
  return (
    <Card size="sm">
      <CardContent className="flex items-center gap-3 py-3">
        <div className="bg-tertiary border-primary-border text-ink-secondary grid size-9 shrink-0 place-items-center rounded-lg border">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{conn.name}</span>
            {conn.oauth ? (
              <span className="flex items-center gap-1 text-xs">
                <span className={cn("size-1.5 rounded-full", conn.authorized ? "bg-emerald-500" : "bg-amber-500")} />
                <span className="text-ink-tertiary">{conn.authorized ? "connected" : "not connected"}</span>
              </span>
            ) : (
              conn.hasAuth && <Badge variant="outline">key set</Badge>
            )}
            <Badge variant="outline" className="ml-auto">
              {conn.scope === "org" ? "org" : "personal"}
            </Badge>
          </div>
          <p className="text-ink-tertiary truncate text-xs">
            {conn.kind.toUpperCase()} · {conn.target}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {conn.oauth &&
            (conn.authorized ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={disconnect}>
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  window.location.href = authorizeUrl(conn.name, { returnTo: "/connections" });
                }}
              >
                Connect
              </Button>
            ))}
          <Button size="sm" variant="ghost" disabled={busy} onClick={openEdit} aria-label="Edit">
            <Pencil className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={remove} aria-label="Delete">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <Dialog.Content className="max-w-md">
          <Dialog.Title>Edit connection</Dialog.Title>
          <Dialog.Description>
            Name, kind and scope are fixed. Secret fields left blank keep the stored value.
          </Dialog.Description>
          <div className="mt-4">
            {editInitial && (
              // Remount per open so stale form state never leaks between edits.
              <AddConnection
                key={`${editInitial.scope}:${editInitial.name}:${editOpen}`}
                initial={editInitial}
                onDone={() => setEditOpen(false)}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog>
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
    <Card size="sm">
      <CardContent className="space-y-2 py-3">
        <div className="flex items-center gap-3">
          <div className="bg-tertiary border-primary-border text-ink-secondary grid size-9 shrink-0 place-items-center rounded-lg border">
            <KeyRound className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium capitalize">{conn.label}</span>
              <Badge variant={conn.set ? "secondary" : "outline"}>
                {conn.set ? "key set" : "no key"}
              </Badge>
              <Badge variant="outline" className="ml-auto">{conn.scope}-level</Badge>
            </div>
            <p className="text-ink-tertiary truncate text-xs">
              REST API — key stored envelope-encrypted in the Vault, brokered server-side.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={conn.set ? "Replace API key…" : "Paste API key…"}
          />
          <Button size="sm" disabled={busy || !value.trim()} onClick={save}>
            Save
          </Button>
        </div>
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
    <Card size="sm">
      <CardContent className="space-y-3 py-3">
        <div className="flex items-center gap-3">
          <div className="bg-tertiary border-primary-border text-ink-secondary grid size-9 shrink-0 place-items-center rounded-lg border">
            <Plug className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium capitalize">{connection.name}</span>
              <span className="flex items-center gap-1 text-xs">
                <span className={cn("size-1.5 rounded-full", connection.authorized ? "bg-emerald-500" : "bg-amber-500")} />
                <span className="text-ink-tertiary">{connection.authorized ? "connected" : "not connected"}</span>
              </span>
              <Badge variant="outline" className="ml-auto">built-in</Badge>
            </div>
            <p className="text-ink-tertiary truncate text-xs">
              {connection.description ?? "MCP connection."}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            {connection.authorized ? (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={test}>
                  Test
                </Button>
                {connection.oauth && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={disconnect}>
                    Disconnect
                  </Button>
                )}
              </>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  window.location.href = authorizeUrl(connection.name, { returnTo: "/connections" });
                }}
              >
                Connect
              </Button>
            )}
          </div>
        </div>

        {error && <p className="text-destructive text-xs">{error}</p>}
        {tools && tools.length > 0 && (
          <div className="space-y-1">
            <p className="text-ink-tertiary text-xs">{tools.length} tools available:</p>
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
