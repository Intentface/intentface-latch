import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { currentPrincipalFn, listSchedulesFn, listAgentsFn } from "@/lib/server";
import { createSchedule, deleteSchedule } from "@/lib/latch-client";
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

export const Route = createFileRoute("/schedules")({
  beforeLoad: async () => {
    if (!(await currentPrincipalFn())) throw redirect({ to: "/login" });
  },
  loader: async () => {
    const [schedules, agents] = await Promise.all([listSchedulesFn(), listAgentsFn()]);
    return { schedules, agents };
  },
  component: SchedulesPage,
});

function when(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function SchedulesPage() {
  const { schedules, agents } = Route.useLoaderData();
  const router = useRouter();
  const [cron, setCron] = useState("*/2 * * * *");
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState(agents[0]?.name ?? "assistant");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createSchedule({ agent, cron: cron.trim() || null, prompt });
      setPrompt("");
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    await deleteSchedule(id);
    await router.invalidate();
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Schedules</h1>

      <Card>
        <CardHeader>
          <CardTitle>New schedule</CardTitle>
          <CardDescription>
            Run the assistant on a cron schedule. Each fire starts a new chat
            (you'll find it in the chat list). Leave the cron blank for a one-off
            that runs on the next tick. Schedules fire every ~30s in dev.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-2" onSubmit={add}>
            <div className="flex gap-2">
              <select
                className="border-input bg-background text-foreground h-8 rounded-md border px-2 text-sm"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                aria-label="Agent"
              >
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.title ?? a.name}
                  </option>
                ))}
              </select>
              <Input
                className="max-w-[10rem] font-mono"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="*/2 * * * *"
              />
              <Input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should the agent do? e.g. summarize today's Loredex updates"
              />
              <Button type="submit" disabled={busy || !prompt.trim()}>
                Add
              </Button>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
          </form>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {schedules.length === 0 && (
          <p className="text-muted-foreground text-sm">No schedules yet.</p>
        )}
        {schedules.map((s) => (
          <Card key={s.id}>
            <CardContent className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{s.agent}</Badge>
                  <code className="text-xs">{s.cron ?? "one-shot"}</code>
                  <Badge variant={s.enabled ? "secondary" : "outline"}>
                    {s.enabled ? "active" : "done"}
                  </Badge>
                </div>
                <p className="truncate text-sm">{s.prompt}</p>
                <p className="text-muted-foreground text-xs">
                  next {when(s.nextRunAt)} · last {when(s.lastRunAt)}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                onClick={() => remove(s.id)}
                aria-label="Delete schedule"
              >
                <Trash2 className="size-4" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
