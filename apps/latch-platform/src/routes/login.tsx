import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { authClient, signIn, signUp } from "@/lib/auth-client";
import { LatchLogo } from "@/components/latch-logo";
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

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in · Latch" }] }),
  // Carry a pending invitation id (and any post-login redirect) across sign-in,
  // so a new invitee who lands on /login goes straight back to accept the invite.
  validateSearch: (s: Record<string, unknown>): { invite?: string } =>
    typeof s.invite === "string" ? { invite: s.invite } : {},
  component: LoginPage,
});

function LoginPage() {
  const { invite } = Route.useSearch();
  // Where to land after auth: back to the invite-accept page if we arrived with
  // a pending invitation, otherwise the app root.
  const afterAuth = invite
    ? `/accept-invitation?id=${encodeURIComponent(invite)}`
    : "/";
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const res =
      mode === "signin"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Something went wrong");
    // Full navigation (not router push) so the invite-accept page mounts fresh
    // with the new session resolved.
    else window.location.href = afterAuth;
  }

  async function google() {
    setError(null);
    await signIn.social({ provider: "google", callbackURL: afterAuth });
  }

  async function forgotPassword() {
    setError(null);
    setNotice(null);
    if (!email) {
      setError("Enter your email above first, then click Forgot password.");
      return;
    }
    setBusy(true);
    const res = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Couldn't send the reset email.");
    else setNotice("If that account exists, a reset link is on its way.");
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 p-4">
      <LatchLogo className="h-6 w-auto" />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{mode === "signin" ? "Sign in" : "Create account"}</CardTitle>
          <CardDescription>
            {mode === "signin" ? "Welcome back to Latch." : "Get started with Latch."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" onClick={google} disabled={busy}>
            Continue with Google
          </Button>

          <div className="my-4 flex items-center gap-3">
            <span className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-xs">or</span>
            <span className="bg-border h-px flex-1" />
          </div>

          <form className="space-y-3" onSubmit={submit}>
            {mode === "signup" && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                {mode === "signin" && (
                  <button
                    type="button"
                    onClick={forgotPassword}
                    className="text-muted-foreground text-xs underline-offset-4 hover:underline"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            {notice && <p className="text-ink-secondary text-sm">{notice}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>
          <button
            className="text-muted-foreground mt-4 w-full text-center text-sm underline-offset-4 hover:underline"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setNotice(null);
            }}
          >
            {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </button>
          <p className="text-ink-tertiary mt-3 text-center text-xs">Sign-in is limited to @intentface.com.</p>
        </CardContent>
      </Card>
    </div>
  );
}
