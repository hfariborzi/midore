/**
 * The morning brief: at a time the user picks, a notification with the shape of their day (meetings, planned
 * work, reminders, anything at risk). The phone and desktop apps show it from the agenda; the web page opens
 * Dori's day plan the first time it is opened after that time. Pure, so the agenda route can build it from
 * what it already loaded. No AI is involved.
 */
import { DateTime } from "luxon";

export type Brief = { id: string; at: string; title: string; body: string };

type Item = { kind: "event" | "task"; title: string; start: string; end: string; allDay: boolean };

const hours = (min: number) => (min < 60 ? `${min} min` : `${Math.round(min / 30) / 2} h`);
const clock = (d: DateTime) => d.toFormat(d.minute ? "h:mm a" : "h a").toLowerCase();

/** The next brief time within [from, to), as a DateTime in the user's zone, or null. */
export function nextBriefTime(briefAt: string | null | undefined, tz: string, from: number, to: number): DateTime | null {
  if (!briefAt || !/^\d{2}:\d{2}$/.test(briefAt)) return null;
  const [h, m] = briefAt.split(":").map(Number);
  let d = DateTime.fromMillis(from, { zone: tz }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (d.toMillis() < from) d = d.plus({ days: 1 });
  return d.toMillis() < to ? d : null;
}

/** What the day at `at` holds, in one short line. `items` may cover more than that day. */
export function buildBrief(at: DateTime, items: Item[], reminders: number, atRisk: string[]): Brief {
  const day = at.toISODate()!;
  const tz = at.zoneName ?? "UTC";
  const onDay = items.filter((i) => (i.allDay ? i.start.slice(0, 10) === day : DateTime.fromISO(i.start, { zone: tz }).toISODate() === day));
  const meetings = onDay.filter((i) => i.kind === "event" && !i.allDay).sort((a, b) => a.start.localeCompare(b.start));
  const work = onDay.filter((i) => i.kind === "task").reduce((m, i) => m + (Date.parse(i.end) - Date.parse(i.start)) / 60_000, 0);
  const parts: string[] = [];
  if (meetings.length) parts.push(`${meetings.length} meeting${meetings.length > 1 ? "s" : ""}, first at ${clock(DateTime.fromISO(meetings[0].start, { zone: tz }))}`);
  else parts.push("No meetings");
  if (work > 0) parts.push(`${hours(Math.round(work))} of planned work`);
  if (reminders) parts.push(`${reminders} reminder${reminders > 1 ? "s" : ""}`);
  let body = parts.join(" · ") + ".";
  if (atRisk.length) body += ` At risk: ${atRisk.slice(0, 2).join(", ")}${atRisk.length > 2 ? ` and ${atRisk.length - 2} more` : ""}.`;
  return { id: `brief:${day}`, at: at.toUTC().toISO()!, title: at.weekday === 1 ? "Your week starts" : "Your day", body };
}
