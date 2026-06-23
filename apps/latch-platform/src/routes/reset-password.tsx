import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const Route = createFileRoute("/reset-password")({
  // better-auth appends `?token=…` (and `error=…` on an invalid/expired link).
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const { token, error: linkError } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    const res = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Couldn't reset your password.");
    else navigate({ to: "/login" });
  }

  const invalid = !token || !!linkError;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-4">
      <div className="text-ink-primary text-lg font-semibold tracking-tight">🔒 Latch</div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Reset password</CardTitle>
          <CardDescription>Choose a new password for your account.</CardDescription>
        </CardHeader>
        <CardContent>
          {invalid ? (
            <div className="space-y-3">
              <p className="text-destructive text-sm">
                This reset link is invalid or has expired.
              </p>
              <Button render={<Link to="/login" />} className="w-full">
                Back to sign in
              </Button>
            </div>
          ) : (
            <form className="space-y-3" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus
                />
              </div>
              {error && <p className="text-destructive text-sm">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "…" : "Reset password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
