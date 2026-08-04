import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { KeyRound, Trash2 } from "lucide-react";
import { saveSecretsFn, deleteSecretFn } from "@/lib/server";
import type { listSecretsFn } from "@/lib/server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

type SecretRef = Awaited<ReturnType<typeof listSecretsFn>>[number];

/**
 * The stored credentials the Agent Builder collected through the chat's secret
 * form, plus anything added here. Values are write-only by construction: the
 * server's list returns names and scopes only, so there is nothing to render or
 * leak — you can replace a secret or delete it, never read it back.
 *
 * Connections reference these by name and resolve them at call time, so Replace
 * and Delete are live: one rotates every dependent connection, the other
 * revokes them. Both say which connections that is before you commit.
 */
export function SecretsSection({ secrets }: { secrets: SecretRef[] }) {
  if (secrets.length === 0) return null;
  return (
    <div className="space-y-2">
      <h2 className="text-ink-tertiary text-xs font-medium tracking-wide uppercase">Secrets</h2>
      <p className="text-ink-tertiary text-xs">
        Credentials stored envelope-encrypted in the Vault. Agents reference them by name and
        never see a value.
      </p>
      {secrets.map((s) => (
        <SecretCard key={`${s.scope}:${s.name}`} secret={s} />
      ))}
    </div>
  );
}

function SecretCard({ secret }: { secret: SecretRef }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Deleting is the one action here that breaks something. Two steps, with the
  // damage named in between — there is no undo and no way to retype a value you
  // can't read back.
  const [confirming, setConfirming] = useState(false);
  const usedBy = secret.usedBy;

  async function replace() {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await saveSecretsFn({
        data: { scope: secret.scope, secrets: [{ name: secret.name, value: value.trim() }] },
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setValue("");
      await router.invalidate();
    } catch (e) {
      // A rejected server fn (offline, 500) would otherwise just clear `busy`
      // and look like a silent success.
      setError(e instanceof Error ? e.message : "Could not save the secret.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await deleteSecretFn({ data: { name: secret.name, scope: secret.scope } });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setConfirming(false);
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the secret.");
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
              <span className="truncate font-mono text-sm font-medium">{secret.name}</span>
              <Badge variant="outline" className="ml-auto">
                {secret.scope}-level
              </Badge>
            </div>
            <p className="text-ink-tertiary truncate text-xs">
              {usedBy.length > 0 ? `Used by ${usedBy.join(", ")}` : "Stored — no connection uses it yet"}
            </p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            aria-label={`Delete ${secret.name}`}
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        {confirming ? (
          <div className="border-primary-border space-y-2 rounded-lg border p-3">
            <p className="text-xs">
              {usedBy.length > 0 ? (
                <>
                  Deleting <span className="font-mono">{secret.name}</span> revokes{" "}
                  <span className="font-medium">{usedBy.join(", ")}</span> — those connections stop
                  working until you add the credential again.
                </>
              ) : (
                <>
                  Delete <span className="font-mono">{secret.name}</span>? The value can&rsquo;t be
                  read back, so this can&rsquo;t be undone.
                </>
              )}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" disabled={busy} onClick={remove}>
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                usedBy.length > 0 ? "Rotate value — applies immediately…" : "Replace value…"
              }
            />
            <Button size="sm" disabled={busy || !value.trim()} onClick={replace}>
              Save
            </Button>
          </div>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </CardContent>
    </Card>
  );
}
