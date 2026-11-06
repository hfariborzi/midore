/**
 * The morning brief: at a time the user picks, a notification with the shape of their day (meetings, planned
 * work, reminders, anything at risk). The phone and desktop apps show it from the agenda; the web page opens
 * Dori's day plan the first time it is opened after that time. Pure, so the agenda route can build it from
 * what it already loaded. No AI is involved.
 */
import { DateTime } from "luxon";
import type { CheckIn } from "../../db/schema.ts";

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

// --- Check-ins: Dori speaking first at other set times (a Sunday review, an end-of-day wrap-up) -------------

const TOPIC_TEXT: Record<CheckIn["topic"], string> = { week_review: "Week review", day_wrap: "End-of-day wrap-up", habits: "Habit report", custom: "Check-in" };
const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Week review, Sun at 18:00", for Dori's data and Settings. */
export function checkInLabel(c: CheckIn): string {
  const w = c.weekdays;
  const days = !w.length || w.length === 7 ? "every day" : w.length === 5 && !w.includes(6) && !w.includes(7) ? "weekdays" : w.map((d) => DAY_NAMES[d]).join(", ");
  return `${c.topic === "custom" && c.text ? c.text : TOPIC_TEXT[c.topic]}, ${days} at ${c.at}`;
}

/** What Dori is asked when a check-in opens her (stored as the user's message). */
export function checkInPrompt(c: CheckIn): string {
  if (c.topic === "week_review") return "Week review, please: what I finished this week, how much planned work got done (plan_history, 1 week), what slipped and why, and what next week should focus on. Then ask me how the week felt.";
  if (c.topic === "day_wrap") return "Wrap up my day, please: what got done, what's left, and what should move to tomorrow.";
  if (c.topic === "habits") return "Habit report, please: how are my habits and repeating tasks going?";
  return `Check-in: ${c.text ?? "how are things going?"}`;
}

/** Every check-in time within [from, to), soonest first. */
export function checkInTimes(list: CheckIn[] | undefined, tz: string, from: number, to: number): { c: CheckIn; at: DateTime }[] {
  const out: { c: CheckIn; at: DateTime }[] = [];
  const first = DateTime.fromMillis(from, { zone: tz }).startOf("day");
  for (const c of list ?? []) {
    if (!/^\d{2}:\d{2}$/.test(c.at)) continue;
    const [h, m] = c.at.split(":").map(Number);
    for (let d = first; d.toMillis() < to; d = d.plus({ days: 1 })) {
      if (c.weekdays.length && !c.weekdays.includes(d.weekday)) continue;
      const at = d.set({ hour: h, minute: m });
      if (at.toMillis() >= from && at.toMillis() < to) out.push({ c, at });
    }
  }
  return out.sort((a, b) => a.at.toMillis() - b.at.toMillis());
}

/** The notification for one check-in. `done` counts tasks finished that day (or week, for a week review). */
export function buildCheckIn(c: CheckIn, at: DateTime, done: { today: number; week: number; openToday: number }): Brief & { checkIn: string } {
  const id = `checkin:${c.id}:${at.toISODate()}`;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const base = { id, at: at.toUTC().toISO()!, checkIn: c.id };
  if (c.topic === "week_review") return { ...base, title: "How did the week go?", body: `${done.week ? `You finished ${plural(done.week, "task")} this week.` : "A look back at the week."} Open Midore to go over it with Dori.` };
  if (c.topic === "day_wrap") return { ...base, title: "Wrapping up the day", body: `${plural(done.today, "thing")} done today${done.openToday ? `, ${done.openToday} still planned` : ""}. Dori can move what's left.` };
  if (c.topic === "habits") return { ...base, title: "Your habits", body: "Open Midore for this week's habit report." };
  return { ...base, title: "Dori", body: (c.text ?? "Time for a check-in.").slice(0, 160) };
}
