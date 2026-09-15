"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn, signUp } from "@/lib/auth-client";
import Button from "@/components/ui/button";
import Input from "@/components/ui/input";

export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === "in"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: name || email.split("@")[0]! });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? "That did not work.");
    router.push("/");
    router.refresh();
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-medium tracking-tight">Agent Lab</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          A workbench for the experimental agent runtime. Conversations, budgets and policy all
          belong to an organization.
        </p>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
          {mode === "up" && (
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder="Name"
              autoComplete="name"
            />
          )}
          <Input
            type="email"
            required
            value={email}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
          <Input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete={mode === "in" ? "current-password" : "new-password"}
          />

          {error && <p className="text-xs text-red-500">{error}</p>}

          <Button type="submit" disabled={busy} className="mt-1">
            {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <button
          onClick={() => {
            setMode(mode === "in" ? "up" : "in");
            setError(null);
          }}
          className="mt-4 text-xs text-ink-tertiary hover:text-ink-secondary"
        >
          {mode === "in" ? "No account? Create one" : "Already have an account? Sign in"}
        </button>
      </div>
    </main>
  );
}
