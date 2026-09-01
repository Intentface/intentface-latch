
/**
 * "in 2 h" / "in 5 min" / "due" — enough to see a schedule is alive without a
 * clock. Shared by the schedules page and the sidebar's Scheduled group.
 */
export const nextRunLabel = (schedule: {
  enabled: boolean;
  nextRunAt: number;
  cron: string | null;
}): string => {
  // A disabled schedule is either one somebody switched off, or a one-shot
  // that simply ran — "paused" implies a resume that a spent one-shot has no
  // way to offer, so the two say different things.
  if (!schedule.enabled) return schedule.cron ? "paused" : "ran";
  const deltaMs = schedule.nextRunAt - Date.now();
  if (deltaMs <= 0) return "due";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `in ${Math.max(minutes, 1)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
};
