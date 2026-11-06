/** Repeating calendar events, in each provider's format (pure; unit tested). */
import { DateTime } from "luxon";

/** A repeating event, in the event's time zone. Ends after `count` events, on `until` (YYYY-MM-DD), or never. */
export type Recurrence = {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number; // every n days/weeks/…; default 1
  byWeekday?: number[]; // weekly only: ISO weekdays 1 = Monday … 7 = Sunday
  count?: number;
  until?: string;
};

const RRULE_DAYS = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** The RFC 5545 rule for a recurrence (Google's format). */
export function toRRule(r: Recurrence): string {
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval && r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === "weekly" && r.byWeekday?.length) parts.push(`BYDAY=${r.byWeekday.map((d) => RRULE_DAYS[d]).join(",")}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  else if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, "")}T235959Z`);
  return `RRULE:${parts.join(";")}`;
}

const GRAPH_DAYS = ["", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** Graph's patternedRecurrence for a recurrence starting at `start` (dates are in the event's zone). */
export function toGraphRecurrence(r: Recurrence, start: Date, timeZone: string) {
  const local = DateTime.fromJSDate(start, { zone: timeZone });
  const pattern =
    r.freq === "daily"
      ? { type: "daily", interval: r.interval ?? 1 }
      : r.freq === "weekly"
        ? { type: "weekly", interval: r.interval ?? 1, daysOfWeek: (r.byWeekday?.length ? r.byWeekday : [local.weekday]).map((d) => GRAPH_DAYS[d]), firstDayOfWeek: "monday" }
        : r.freq === "monthly"
          ? { type: "absoluteMonthly", interval: r.interval ?? 1, dayOfMonth: local.day }
          : { type: "absoluteYearly", interval: r.interval ?? 1, dayOfMonth: local.day, month: local.month };
  const startDate = local.toISODate()!;
  const range = r.count
    ? { type: "numbered", startDate, numberOfOccurrences: r.count }
    : r.until
      ? { type: "endDate", startDate, endDate: r.until }
      : { type: "noEnd", startDate };
  return { pattern, range };
}
