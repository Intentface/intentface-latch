import cronstrue from "cronstrue";

/**
 * The repeat picker's vocabulary, and its mapping to cron.
 *
 * Nobody should have to know crontab syntax to get a Monday-morning digest:
 * the dialog offers shapes people actually mean — once, hourly, daily, weekly,
 * monthly — and derives the expression. Cron remains the STORED form (it's
 * what Latch evaluates, via croner), so `custom` stays as the escape hatch for
 * anything the shapes can't say, and everything shown back to a person goes
 * through `describeCron` rather than the raw expression.
 */

export type Repeat =
  | { kind: "once" }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | {
      kind: "weekly";
      /** Cron day-of-week numbers: 0 = Sunday … 6 = Saturday. */
      days: number[];
      time: string;
    }
  | { kind: "monthly"; day: number; time: string }
  | { kind: "custom"; expression: string };

/** "09:30" → { hour: 9, minute: 30 }; anything else → a safe 09:00. */
const parseTime = (time: string): { hour: number; minute: number } => {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 9, minute: 0 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { hour: 9, minute: 0 };
  return { hour, minute };
};

/**
 * The cron expression a repeat means, or null for "once" — which is also what
 * the schedule API takes for a one-shot.
 *
 * Throws with a person-readable message when the choice is incomplete (no
 * weekday picked, empty custom expression), so the dialog surfaces the problem
 * at save instead of storing a schedule that never fires.
 */
export const toCron = (repeat: Repeat): string | null => {
  switch (repeat.kind) {
    case "once":
      return null;
    case "hourly": {
      const minute = Math.min(Math.max(Math.trunc(repeat.minute), 0), 59);
      return `${minute} * * * *`;
    }
    case "daily": {
      const { hour, minute } = parseTime(repeat.time);
      return `${minute} ${hour} * * *`;
    }
    case "weekly": {
      if (repeat.days.length === 0) throw new Error("Pick at least one weekday.");
      const { hour, minute } = parseTime(repeat.time);
      const days = [...new Set(repeat.days)].sort((a, b) => a - b).join(",");
      return `${minute} ${hour} * * ${days}`;
    }
    case "monthly": {
      const day = Math.min(Math.max(Math.trunc(repeat.day), 1), 31);
      const { hour, minute } = parseTime(repeat.time);
      return `${minute} ${hour} ${day} * *`;
    }
    case "custom": {
      const expression = repeat.expression.trim();
      if (!expression) throw new Error("Write a cron expression, or choose a repeat above.");
      return expression;
    }
  }
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A stored expression back into the picker's shapes — the editing direction.
 *
 * Only the exact patterns `toCron` writes come back structured; anything else
 * (ranges, steps, month fields, an expression someone typed by hand) opens as
 * Custom, which shows it verbatim rather than flattening it into the nearest
 * shape and silently changing what runs.
 */
export const fromCron = (expression: string | null): Repeat => {
  if (expression === null) return { kind: "once" };

  const fields = expression.trim().split(/\s+/);
  if (fields.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    const num = (field: string, max: number): number | null =>
      /^\d{1,2}$/.test(field) && Number(field) <= max ? Number(field) : null;

    const m = num(minute, 59);
    const h = num(hour, 23);

    if (m !== null && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return { kind: "hourly", minute: m };
    }
    if (m !== null && h !== null && month === "*") {
      const time = `${pad(h)}:${pad(m)}`;
      if (dayOfMonth === "*" && dayOfWeek === "*") return { kind: "daily", time };
      if (dayOfMonth === "*" && /^[0-6](,[0-6])*$/.test(dayOfWeek)) {
        return { kind: "weekly", days: dayOfWeek.split(",").map(Number), time };
      }
      const day = num(dayOfMonth, 31);
      if (day !== null && day >= 1 && dayOfWeek === "*") return { kind: "monthly", day, time };
    }
  }

  return { kind: "custom", expression };
};

/**
 * A cron expression in words — "At 09:00, only on Monday". Falls back to the
 * raw expression rather than throwing: an expression croner accepts but
 * cronstrue can't phrase should still show SOMETHING true.
 */
export const describeCron = (expression: string): string => {
  try {
    return cronstrue.toString(expression, { use24HourTimeFormat: true });
  } catch {
    return expression;
  }
};
