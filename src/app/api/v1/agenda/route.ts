import { DateTime } from "luxon";
import { and, eq } from "drizzle-orm";
import { db, tasks } from "@/db";
import { json, withDevice } from "@/lib/api-v1";
import { eventsForAccounts, listAccounts } from "@/lib/calendar";
import { eventKey, labelEvents } from "@/lib/labels";
import { GRAPHITE, toPalette } from "@/lib/palette";
import { blockState, planBlocks } from "@/lib/plan-view";
import { buildBrief, nextBriefTime } from "@/lib/dori/brief";
import { upcomingAlerts } from "@/lib/tasks";

export const maxDuration = 30;

/**
 * Today (or the next few days, or another day with `date`) for the tray, the menu bar and the widgets: events and planned work in one list,
 * coloured with the Midore palette by category, plus what is happening now and what comes next, and the alerts set on
 * tasks and reminders.
 */
export async function GET(req: Request) {
  return withDevice(req, "agenda", async (user) => {
    const url = new URL(req.url);
    const days = Math.min(7, Math.max(1, Number(url.searchParams.get("days")) || 1));
    // `date` (YYYY-MM-DD, the person's own timezone) picks another day for the menu bar calendar; default today.
    const date = url.searchParams.get("date");
    const picked = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? DateTime.fromISO(date, { zone: user.timezone }) : null;
    const start = (picked?.isValid ? picked : DateTime.now().setZone(user.timezone)).startOf("day");
    const end = start.plus({ days });
    const [{ events, problems }, blocks, alerts] = await Promise.all([
      listAccounts(user.id).then((accounts) => eventsForAccounts(user, accounts, start.toJSDate(), end.toJSDate())),
      planBlocks(user, start.toMillis(), end.toMillis()),
      // Alerts the user asked for ("remind me at 6"), from now on: the apps schedule them as notifications.
      upcomingAlerts(user, new Date(Math.max(Date.now() - 10 * 60_000, start.toMillis())), end.toJSDate()),
    ]);
    const { labels, categories } = await labelEvents(user.id, events);
    const catColor = (id: number | null | undefined) => {
      const c = categories.find((x) => x.id === id);
      return c ? toPalette(c.color) : null;
    };
    const items = [
      ...events.map((e) => {
        const label = labels[`${e.accountId}:${eventKey(e)}`];
        return {
          kind: "event" as const,
          id: `${e.accountId}:${e.id}`,
          title: e.title,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          color: catColor(label?.categoryId) ?? GRAPHITE,
          location: e.location ?? null,
          meetLink: e.meetLink ?? null,
        };
      }),
      ...blocks.map((b) => ({
        kind: "task" as const,
        id: `${b.taskId}:${b.start}`,
        taskId: b.taskId,
        title: b.title,
        start: b.start,
        end: b.end,
        allDay: false,
        color: catColor(b.categoryId) ?? "#e11d48",
        state: blockState(b),
        progress: b.progress,
        pinned: b.pinned,
      })),
    ].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const now = Date.now();
    const timed = items.filter((i) => !i.allDay);
    // The morning brief, when the user asked for one and its time falls in this window.
    const briefAt = nextBriefTime(user.doriPrefs?.briefAt, user.timezone, Math.max(start.toMillis(), now - 10 * 60_000), end.toMillis());
    let brief = null;
    if (briefAt) {
      const day = briefAt.toISODate()!;
      const due = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.userId, user.id), eq(tasks.status, "open"), eq(tasks.kind, "reminder"), eq(tasks.dueDate, day)));
      const risky = [...new Set(blocks.filter((b) => b.risk && DateTime.fromISO(b.start, { zone: user.timezone }).toISODate() === day).map((b) => b.title))];
      brief = buildBrief(briefAt, items, due.length, risky);
    }
    const current = timed.find((i) => Date.parse(i.start) <= now && Date.parse(i.end) > now) ?? null;
    const next = timed.find((i) => Date.parse(i.start) > now) ?? null;
    return json({
      timezone: user.timezone,
      generatedAt: new Date().toISOString(),
      start: start.toISO(),
      end: end.toISO(),
      items,
      alerts: alerts.map((a) => ({ id: `alert:${a.taskId}:${a.at}`, taskId: a.taskId, title: a.title, at: a.at })),
      brief,
      now: current,
      next,
      problems: problems.map((p) => ({ email: p.email, message: p.message })),
    });
  });
}
