/**
 * How a task repeats, stored as a short string in `tasks.repeat` (pure; unit tested):
 *   daily | weekdays | weekly | biweekly | monthly | yearly
 *   days:1,3,5   given ISO weekdays (1 = Monday … 7 = Sunday)
 *   nth:2:2      the 2nd Tuesday of each month; nth:-1:5 is the last Friday
 *   every:3      every 3 days
 *   times:3      3 times a week, any days (a habit): the next one is due tomorrow until the week has 3
 *   hours:2:09:00-21:00  a nudge every 2 hours between 9 am and 9 pm, every day (a reminder; finishing it ends today's)
 * Completing a repeating task creates the next occurrence (see applyStatus).
 */
import { DateTime } from "luxon";

const SIMPLE = new Set(["daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"]);
const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ORDINAL: Record<string, string> = { "1": "1st", "2": "2nd", "3": "3rd", "4": "4th", "-1": "last" };

export type Repeat =
  | { kind: "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | "yearly" }
  | { kind: "days"; days: number[] }
  | { kind: "nth"; n: number; weekday: number }
  | { kind: "every"; days: number }
  | { kind: "times"; perWeek: number }
  | { kind: "hours"; every: number; from: string; to: string };

export function parseRepeat(s: string | null | undefined): Repeat | null {
  if (!s) return null;
  if (SIMPLE.has(s)) return { kind: s as "daily" };
  let m = s.match(/^days:([1-7](?:,[1-7]){0,6})$/);
  if (m) {
    const days = [...new Set(m[1].split(",").map(Number))].sort();
    return { kind: "days", days };
  }
  m = s.match(/^nth:(-1|[1-4]):([1-7])$/);
  if (m) return { kind: "nth", n: Number(m[1]), weekday: Number(m[2]) };
  m = s.match(/^every:(\d{1,3})$/);
  if (m && Number(m[1]) >= 2 && Number(m[1]) <= 365) return { kind: "every", days: Number(m[1]) };
  m = s.match(/^times:([1-6])$/);
  if (m) return { kind: "times", perWeek: Number(m[1]) };
  m = s.match(/^hours:([1-9]|1[0-2]):([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/);
  if (m && `${m[4]}:${m[5]}` > `${m[2]}:${m[3]}`) return { kind: "hours", every: Number(m[1]), from: `${m[2]}:${m[3]}`, to: `${m[4]}:${m[5]}` };
  return null;
}

export const isRepeat = (s: string) => parseRepeat(s) !== null;

/** The canonical string for a rule (sorted weekdays, no duplicates). */
export function formatRepeat(r: Repeat): string {
  switch (r.kind) {
    case "days":
      return `days:${r.days.join(",")}`;
    case "nth":
      return `nth:${r.n}:${r.weekday}`;
    case "every":
      return `every:${r.days}`;
    case "times":
      return `times:${r.perWeek}`;
    case "hours":
      return `hours:${r.every}:${r.from}-${r.to}`;
    default:
      return r.kind;
  }
}

/** The day of the month that is the nth (or last, n = -1) given weekday, or null when the month has none. */
function nthWeekday(month: DateTime, n: number, weekday: number): DateTime | null {
  const first = month.startOf("month");
  if (n > 0) {
    const d = first.plus({ days: (weekday - first.weekday + 7) % 7 + (n - 1) * 7 });
    return d.month === first.month ? d : null;
  }
  const last = month.endOf("month").startOf("day");
  return last.minus({ days: (last.weekday - weekday + 7) % 7 });
}

/**
 * The next due date after `fromDay`. `doneThisWeek` is only used by "times": how many occurrences were finished
 * in fromDay's week, counting the one just finished.
 */
export function nextDueFor(rule: string, fromDay: string, tz: string, doneThisWeek = 0): string {
  const r = parseRepeat(rule);
  let d = DateTime.fromISO(fromDay, { zone: tz }).startOf("day");
  if (!r) return d.plus({ days: 1 }).toISODate()!;
  switch (r.kind) {
    case "daily":
    case "hours":
      return d.plus({ days: 1 }).toISODate()!;
    case "weekly":
      return d.plus({ weeks: 1 }).toISODate()!;
    case "biweekly":
      return d.plus({ weeks: 2 }).toISODate()!;
    case "monthly":
      return d.plus({ months: 1 }).toISODate()!;
    case "yearly":
      return d.plus({ years: 1 }).toISODate()!;
    case "every":
      return d.plus({ days: r.days }).toISODate()!;
    case "weekdays":
      d = d.plus({ days: 1 });
      while (d.weekday > 5) d = d.plus({ days: 1 });
      return d.toISODate()!;
    case "days":
      for (let i = 1; i <= 7; i++) {
        const c = d.plus({ days: i });
        if (r.days.includes(c.weekday)) return c.toISODate()!;
      }
      return d.plus({ weeks: 1 }).toISODate()!;
    case "nth": {
      for (let i = 0; i < 14; i++) {
        const c = nthWeekday(d.plus({ months: i }), r.n, r.weekday);
        if (c && c > d) return c.toISODate()!;
      }
      return d.plus({ months: 1 }).toISODate()!;
    }
    case "times": {
      const tomorrow = d.plus({ days: 1 });
      if (doneThisWeek < r.perWeek && tomorrow.weekNumber === d.weekNumber) return tomorrow.toISODate()!;
      return d.plus({ weeks: 1 }).startOf("week").toISODate()!;
    }
  }
}

/** The first due date on or after `fromDay` that fits the rule (for a new repeating task with no date). */
export function firstDueFor(rule: string, fromDay: string, tz: string): string {
  const r = parseRepeat(rule);
  const d = DateTime.fromISO(fromDay, { zone: tz }).startOf("day");
  if (r?.kind === "days" && r.days.includes(d.weekday)) return fromDay;
  if (r?.kind === "weekdays" && d.weekday <= 5) return fromDay;
  if (r?.kind === "nth" && nthWeekday(d, r.n, r.weekday)?.toISODate() === fromDay) return fromDay;
  if (r?.kind === "days" || r?.kind === "weekdays" || r?.kind === "nth") return nextDueFor(rule, fromDay, tz);
  return fromDay;
}

export function repeatLabel(rule: string | null | undefined): string {
  const r = parseRepeat(rule);
  if (!r) return "";
  switch (r.kind) {
    case "daily":
      return "Every day";
    case "weekdays":
      return "Every weekday";
    case "weekly":
      return "Every week";
    case "biweekly":
      return "Every 2 weeks";
    case "monthly":
      return "Every month";
    case "yearly":
      return "Every year";
    case "days":
      return `Every ${r.days.map((d) => DAY_NAMES[d]).join(", ")}`;
    case "nth":
      return `The ${ORDINAL[String(r.n)]} ${DAY_NAMES[r.weekday]} of each month`;
    case "every":
      return `Every ${r.days} days`;
    case "times":
      return `${r.perWeek} time${r.perWeek > 1 ? "s" : ""} a week`;
    case "hours":
      return `Every ${r.every === 1 ? "hour" : `${r.every} hours`}, ${r.from}–${r.to}`;
  }
}

/** The nudge times of an "hours" rule on one day, as epoch ms (empty for other rules). */
export function nudgeTimes(rule: string, day: string, tz: string): number[] {
  const r = parseRepeat(rule);
  if (r?.kind !== "hours") return [];
  const at = (hm: string) => DateTime.fromISO(`${day}T${hm === "24:00" ? "23:59" : hm}`, { zone: tz });
  const out: number[] = [];
  for (let t = at(r.from); t <= at(r.to); t = t.plus({ hours: r.every })) out.push(t.toMillis());
  return out;
}
