const WEEKDAYS_UTC = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * The "what day is it" line appended to every agent's instructions.
 *
 * Day granularity ONLY — the string may change at most once per calendar day.
 * Anthropic prompt caches live minutes, not days, so a day-stable line never
 * invalidates a live cache; anything finer (clock time) would change the
 * system prompt every turn and bust the cache each time. The weekday is
 * spelled out because models are unreliable at deriving it from a date, and
 * the timezone is stated so the model never guesses whose midnight applies.
 */
export function currentDateLine(now: Date = new Date()): string {
  const weekday = WEEKDAYS_UTC[now.getUTCDay()];
  const iso = now.toISOString().slice(0, 10);
  return `Today's date is ${weekday}, ${iso} (UTC).`;
}
