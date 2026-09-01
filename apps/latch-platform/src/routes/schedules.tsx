import { useState } from "react";
import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { CalendarClock, ChevronDown, MessageCircle, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  currentPrincipalFn,
  listSchedulesFn,
  listAgentsFn,
  runScheduleNowFn,
  type ScheduleSummary,
} from "@/lib/server";
import { deleteSchedule } from "@/lib/latch-client";
import { describeCron } from "@/lib/repeat";
import { nextRunLabel } from "@/lib/schedule-time";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Settings } from "@/components/ui/settings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScheduleDialog } from "@/components/schedule-dialog";

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

const countLabel = (n: number) =>
  n === 0 ? "Nothing scheduled" : `${n} schedule${n === 1 ? "" : "s"}`;

function SchedulesPage() {
  const { schedules, agents } = Route.useLoaderData();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ScheduleSummary | null>(null);
  const titleOf = new Map(agents.map((a) => [a.name, a.title ?? a.name]));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <Settings>
        <Settings.Header>
          <Settings.Heading>
            <Settings.Title>Schedules</Settings.Title>
            <Settings.Subtitle>
              Agents that run on their own — each fire sends the saved prompt and the answer
              arrives as a new conversation in your chats.
            </Settings.Subtitle>
          </Settings.Heading>
        </Settings.Header>

        <Settings.Card>
          <Settings.Row>
            <Settings.LabelGroup>
              <Settings.Summary>{countLabel(schedules.length)}</Settings.Summary>
            </Settings.LabelGroup>
            {schedules.length === 0 ? (
              <Button variant="ghost" className="rounded-full" onClick={() => setAdding(true)}>
                <Plus className="size-4" />
                New schedule
              </Button>
            ) : (
              <IconButton
                aria-label="New schedule"
                variant="ghost"
                className="rounded-full"
                onClick={() => setAdding(true)}
              >
                <Plus className="size-4" />
              </IconButton>
            )}
          </Settings.Row>

          {schedules.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              agentTitle={titleOf.get(schedule.agent) ?? schedule.agent}
              onEdit={() => setEditing(schedule)}
            />
          ))}
        </Settings.Card>
      </Settings>

      {adding || editing ? (
        <ScheduleDialog
          key={editing?.id ?? "new"}
          agents={agents}
          schedule={editing ?? undefined}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ScheduleRow({
  schedule,
  agentTitle,
  onEdit,
}: {
  schedule: ScheduleSummary;
  agentTitle: string;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function runNow() {
    setBusy(true);
    try {
      const res = await runScheduleNowFn({ data: { id: schedule.id } });
      if (res.ok) toast.success("Armed — it fires within the minute");
      else toast.error(res.error);
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteSchedule(schedule.id);
      await router.invalidate();
    } catch {
      toast.error("Couldn't delete the schedule");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Settings.Row>
      <Settings.Icon>
        <CalendarClock />
      </Settings.Icon>

      <Settings.LabelGroup>
        <Settings.Label>
          {agentTitle}
          {schedule.delivery ? (
            <span className="text-ink-tertiary"> · → {schedule.delivery.kind}</span>
          ) : null}
        </Settings.Label>
        <Settings.Description className="block truncate">{schedule.prompt}</Settings.Description>
      </Settings.LabelGroup>

      {/* cadence — words, never raw cron */}
      <Settings.Value className="text-xs">
        {schedule.cron
          ? `${describeCron(schedule.cron)}${schedule.timezone ? ` · ${schedule.timezone}` : ""}`
          : "Once"}
      </Settings.Value>

      {/* status doubles as the actions trigger */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" className="rounded-full" disabled={busy} />}
        >
          {schedule.parked ? (
            <span className="text-amber-500">waiting on you</span>
          ) : (
            nextRunLabel(schedule)
          )}
          <ChevronDown className="text-ink-tertiary size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {schedule.lastChatId ? (
            <DropdownMenuItem
              render={
                <Link
                  to="/chat/$chatId"
                  params={{ chatId: schedule.lastChatId }}
                  search={{ agent: undefined }}
                />
              }
            >
              <MessageCircle className="size-3.5" />
              Open latest run
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={runNow}>
            <Play className="size-3.5" />
            Run now
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="size-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={remove}>
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Settings.Row>
  );
}
