import { useEffect, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Play, Trash2 } from "lucide-react";
import {
  currentPrincipalFn,
  listSchedulesFn,
  listAgentsFn,
  listAgentChannelsFn,
  createScheduleFn,
  runScheduleNowFn,
} from "@/lib/server";
import { deleteSchedule } from "@/lib/latch-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";

/** All IANA zones if the runtime supports it, else a small fallback. */
const TIMEZONES: string[] =
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : ["UTC", "Europe/Helsinki", "Europe/London", "America/New_York", "America/Los_Angeles"];
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const Route = createFileRoute("/schedules")({
  head: () => ({ meta: [{ title: "Schedules · Latch" }] }),
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

/** A delivery option in the picker; `value` is what we post back. */
interface DeliveryOption {
  value: string;
  label: string;
  delivery: unknown;
}

function SchedulesPage() {
  const { schedules, agents } = Route.useLoaderData();
  const router = useRouter();
  const [cron, setCron] = useState("*/2 * * * *");
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState(agents[0]?.name ?? "assistant");
  const [timezone, setTimezone] = useState("UTC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryOption[]>([]);
  const [deliverTo, setDeliverTo] = useState("");

  // Default to the viewer's timezone (set after mount to avoid SSR mismatch).
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) setTimezone(tz);
  }, []);

  // Delivery targets are per-agent (a bot serves exactly one agent), so reload
  // them whenever the picker changes and drop a selection that no longer fits.
  useEffect(() => {
    let live = true;
    setDeliverTo("");
    listAgentChannelsFn({ data: { agent } })
      .then((channels) => {
        if (!live) return;
        setDeliveries(
          channels.flatMap<DeliveryOption>((c) =>
            c.kind === "telegram"
              ? [
                  {
                    value: `telegram:${c.ref}`,
                    label: `Telegram · ${c.label}`,
                    delivery: { kind: "telegram", botId: c.ref },
                  },
                ]
              : (c.channels ?? []).map((ch) => ({
                  value: `slack:${c.ref}:${ch.id}`,
                  label: `Slack · #${ch.name}`,
                  delivery: { kind: "slack", appId: c.ref, channel: ch.id },
                })),
          ),
        );
      })
      .catch(() => live && setDeliveries([]));
    return () => {
      live = false;
    };
  }, [agent]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createScheduleFn({
        data: {
          agent,
          cron: cron.trim() || null,
          timezone,
          prompt,
          delivery: deliveries.find((d) => d.value === deliverTo)?.delivery,
        },
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
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

  /** Arm it for the next tick; the cron fires it for real from there. */
  async function runNow(id: string) {
    setBusy(true);
    await runScheduleNowFn({ data: { id } });
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
            <div className="flex flex-wrap gap-2">
              <Select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.title ?? a.name}
                  </option>
                ))}
              </Select>
              <Input
                className="max-w-[9rem] font-mono"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="*/2 * * * *"
                aria-label="Cron expression"
              />
              <Select
                className="max-w-[14rem]"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                aria-label="Timezone"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
              {deliveries.length > 0 && (
                <Select
                  className="max-w-[16rem]"
                  value={deliverTo}
                  onChange={(e) => setDeliverTo(e.target.value)}
                  aria-label="Deliver to"
                >
                  <option value="">Deliver to: nowhere (web only)</option>
                  {deliveries.map((d) => (
                    <option key={d.value} value={d.value}>
                      Deliver to: {d.label}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <Textarea
              className="min-h-24"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do? e.g. summarize today's updates and post the highlights"
            />
            <div className="flex items-center justify-between">
              {error ? (
                <p className="text-destructive text-sm">{error}</p>
              ) : (
                <span className="text-ink-tertiary text-xs">
                  Cron is interpreted in the selected timezone.
                </span>
              )}
              <Button type="submit" disabled={busy || !prompt.trim()}>
                Add schedule
              </Button>
            </div>
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
                  {s.delivery && <Badge variant="outline">→ {s.delivery.kind}</Badge>}
                </div>
                <p className="truncate text-sm">{s.prompt}</p>
                <p className="text-muted-foreground text-xs">
                  next {when(s.nextRunAt)} · last {when(s.lastRunAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy || !s.enabled}
                  onClick={() => runNow(s.id)}
                  aria-label="Run now"
                  title="Run on the next tick"
                >
                  <Play className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => remove(s.id)}
                  aria-label="Delete schedule"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
