import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  createScheduleFn,
  listAgentChannelsFn,
  updateScheduleFn,
  type ScheduleSummary,
} from "@/lib/server";
import { describeCron, fromCron, toCron, type Repeat } from "@/lib/repeat";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

/**
 * Create/edit dialog for scheduled agents (ported from intentface-agents).
 *
 * Nobody should have to know crontab syntax for a Monday-morning digest: the
 * Repeats picker speaks in shapes (once, hourly, daily, weekly, monthly) and
 * derives the cron, `custom` stays as the escape hatch, and everything is read
 * back in words via `describeCron` before saving.
 *
 * Latch has no in-place schedule update — Save on an existing schedule
 * creates the new one and unschedules the old (the id changes, and the
 * "latest run" pointer resets).
 */

export interface SchedulableAgent {
  name: string;
  title?: string;
}

interface DeliveryOption {
  value: string;
  label: string;
  delivery: unknown;
}

const REPEAT_KINDS: { value: Repeat["kind"]; label: string }[] = [
  { value: "once", label: "Doesn't repeat" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom (cron)" },
];

const DEFAULT_REPEAT: Record<Repeat["kind"], Repeat> = {
  once: { kind: "once" },
  hourly: { kind: "hourly", minute: 0 },
  daily: { kind: "daily", time: "09:00" },
  weekly: { kind: "weekly", days: [1], time: "09:00" },
  monthly: { kind: "monthly", day: 1, time: "09:00" },
  custom: { kind: "custom", expression: "" },
};

/** Monday-first display, cron numbering (0 = Sunday). */
const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

const labelClass = "text-ink-secondary text-xs";

export function ScheduleDialog({
  agents,
  schedule,
  onClose,
}: {
  agents: readonly SchedulableAgent[];
  schedule?: ScheduleSummary;
  onClose: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [agent, setAgent] = useState(schedule?.agent ?? agents[0]?.name ?? "assistant");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [timezone, setTimezone] = useState(
    () => schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [repeat, setRepeat] = useState<Repeat>(() =>
    schedule ? fromCron(schedule.cron) : { kind: "once" },
  );
  const [fireWhenParked, setFireWhenParked] = useState(schedule?.onParked === "fire");
  const [repeatError, setRepeatError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Delivery is a Latch-platform concept the upstream dialog doesn't have:
  // where the fired turn's answer lands (a linked Telegram bot, a Slack
  // channel) instead of only the web chat list.
  const [deliveries, setDeliveries] = useState<DeliveryOption[]>([]);
  const [deliverTo, setDeliverTo] = useState("");
  useEffect(() => {
    let alive = true;
    setDeliveries([]);
    setDeliverTo("");
    listAgentChannelsFn({ data: { agent } })
      .then((channels) => {
        if (!alive) return;
        const options: DeliveryOption[] = [];
        for (const c of channels) {
          if (c.kind === "telegram") {
            options.push({
              value: `telegram:${c.ref}`,
              label: `Telegram · ${c.label}`,
              delivery: { kind: "telegram", botId: c.ref },
            });
          } else if (c.kind === "slack") {
            for (const ch of c.channels ?? []) {
              options.push({
                value: `slack:${c.ref}:${ch.id}`,
                label: `Slack · #${ch.name}`,
                delivery: { kind: "slack", appId: c.ref, channel: ch.id },
              });
            }
          }
        }
        setDeliveries(options);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agent]);

  const agentFieldId = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRepeatError(null);
    let cron: string | null;
    try {
      cron = toCron(repeat);
    } catch (err) {
      setRepeatError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!prompt.trim()) {
      setError("What should the agent be asked each time it runs?");
      return;
    }
    setBusy(true);
    try {
      const data = {
        agent,
        cron,
        timezone: timezone.trim() || undefined,
        prompt: prompt.trim(),
        delivery: deliveries.find((d) => d.value === deliverTo)?.delivery,
        onParked: cron && fireWhenParked ? ("fire" as const) : undefined,
      };
      const res = schedule
        ? await updateScheduleFn({ data: { ...data, id: schedule.id } })
        : await createScheduleFn({ data });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await router.invalidate();
      setOpen(false);
    } catch {
      toast.error(schedule ? "Couldn't save the schedule" : "Couldn't create the schedule");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) onClose();
      }}
    >
      <Dialog.Content className="max-w-lg">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Dialog.Title>{schedule ? "Edit schedule" : "New schedule"}</Dialog.Title>
            <Dialog.Description>
              One turn per fire — the prompt below is the message each run starts from.
            </Dialog.Description>
          </div>

          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-1.5">
              <label className={labelClass} htmlFor={agentFieldId}>
                Agent
              </label>
              <Select
                id={agentFieldId}
                className="w-full"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.title ?? a.name}
                  </option>
                ))}
              </Select>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className={labelClass}>Prompt</span>
              <Textarea
                className="min-h-20"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Summarise last week's signups."
              />
              <span className="text-ink-tertiary text-xs">
                A run has nobody watching: a tool that needs approval pauses the conversation
                until you open it.
              </span>
            </label>

            <RepeatPicker error={repeatError} onChange={setRepeat} repeat={repeat} />

            {repeat.kind === "once" ? null : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className={labelClass}>Timezone</span>
                    <Input
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      placeholder="Europe/Helsinki"
                    />
                    <span className="text-ink-tertiary text-xs">
                      Whose clock the times above are read on.
                    </span>
                  </label>
                  <RepeatSummary repeat={repeat} timezone={timezone} />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className={labelClass}>Run even while a previous run waits on you</span>
                    <span className="text-ink-tertiary text-xs leading-relaxed">
                      {fireWhenParked
                        ? "Every occurrence runs — right for a digest, but stuck runs can pile up."
                        : "Off: while a run is paused on an approval, occurrences are skipped until you answer it."}
                    </span>
                  </span>
                  <Switch
                    aria-label="Run even while a previous run waits on you"
                    checked={fireWhenParked}
                    onCheckedChange={setFireWhenParked}
                  />
                </div>
              </>
            )}

            {deliveries.length > 0 && (
              <label className="flex flex-col gap-1.5">
                <span className={labelClass}>Deliver the answer to</span>
                <Select
                  className="w-full"
                  value={deliverTo}
                  onChange={(e) => setDeliverTo(e.target.value)}
                >
                  <option value="">Nowhere — web chat only</option>
                  {deliveries.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </label>
            )}

            {error ? (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                className="rounded-full"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" className="rounded-full" disabled={busy}>
                {busy ? "Saving…" : schedule ? "Save changes" : "Create schedule"}
              </Button>
            </div>
          </form>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}

// ── Repeat picker ────────────────────────────────────────────────────────────

function RepeatPicker({
  repeat,
  onChange,
  error,
}: {
  repeat: Repeat;
  onChange: (r: Repeat) => void;
  error: string | null;
}) {
  const kindFieldId = useId();
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor={kindFieldId}>
            Repeats
          </label>
          <Select
            id={kindFieldId}
            className="w-full"
            value={repeat.kind}
            onChange={(e) => onChange(DEFAULT_REPEAT[e.target.value as Repeat["kind"]])}
          >
            {REPEAT_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </div>

        {repeat.kind === "hourly" && (
          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>At minute</span>
            <Input
              type="number"
              min={0}
              max={59}
              value={repeat.minute}
              onChange={(e) => onChange({ ...repeat, minute: Number(e.target.value) })}
            />
          </label>
        )}
        {(repeat.kind === "daily" || repeat.kind === "weekly") && (
          <TimeField
            value={repeat.time}
            onChange={(time) => onChange({ ...repeat, time } as Repeat)}
          />
        )}
        {repeat.kind === "monthly" && (
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className={labelClass}>On day</span>
              <Input
                type="number"
                min={1}
                max={31}
                value={repeat.day}
                onChange={(e) => onChange({ ...repeat, day: Number(e.target.value) })}
              />
            </label>
            <TimeField value={repeat.time} onChange={(time) => onChange({ ...repeat, time })} />
          </div>
        )}
        {repeat.kind === "custom" && (
          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>Cron expression</span>
            <Input
              className="font-mono"
              value={repeat.expression}
              onChange={(e) => onChange({ ...repeat, expression: e.target.value })}
              placeholder="0 9 * * 1"
              spellCheck={false}
            />
          </label>
        )}
      </div>

      {repeat.kind === "weekly" && (
        <div className="flex items-center gap-1.5">
          {WEEKDAYS.map((day) => {
            const on = repeat.days.includes(day.value);
            return (
              <button
                key={day.value}
                type="button"
                aria-pressed={on}
                className={cn(
                  "h-7 flex-1 cursor-pointer rounded-full text-xs outline-none transition-colors focus-visible:ring-2",
                  on
                    ? "bg-accent-bg text-accent-foreground"
                    : "smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg text-ink-secondary hover:bg-primary-bg-hover",
                )}
                onClick={() =>
                  onChange({
                    ...repeat,
                    days: on
                      ? repeat.days.filter((d) => d !== day.value)
                      : [...repeat.days, day.value],
                  })
                }
              >
                {day.label}
              </button>
            );
          })}
        </div>
      )}

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function TimeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={labelClass}>At</span>
      <Input type="time" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The "read it back in words" check beside the timezone field. */
function RepeatSummary({ repeat, timezone }: { repeat: Repeat; timezone: string }) {
  const text = useMemo(() => {
    let cron: string | null;
    try {
      cron = toCron(repeat);
    } catch {
      return "—";
    }
    return cron === null ? "Runs once, on the next tick." : describeCron(cron);
  }, [repeat]);
  return (
    <div className="flex flex-col gap-1.5">
      <span className={labelClass}>Runs</span>
      <p className="text-ink-tertiary flex min-h-8 items-center text-xs leading-snug">
        {text}
        {timezone.trim() ? ` · ${timezone.trim()}` : ""}
      </p>
    </div>
  );
}
