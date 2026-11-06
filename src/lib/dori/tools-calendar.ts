/**
 * Dori's calendar and booking-page tools. Booking pages and their hours are the user's own settings, so Dori
 * changes them directly (with undo). Anything another person would notice (a new event with guests, moving or
 * deleting an event, cancelling someone's booking) becomes a card the user confirms.
 */
import { and, eq, gte, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db, bookings, eventTypes, schedules, type DateOverride, type TimeRange } from "@/db";
import type { ToolDef } from "../ai/client";
import { calendarsForAccounts, eventsForAccounts, listAccounts, writeTargets } from "../calendar";
import type { Recurrence } from "../calendar/recurrence";
import { appUrl } from "../config";
import { ensureDefaults, listEventTypes, listSchedules } from "../data";
import { fetchFeed, parseIcs } from "../feeds";
import { eventKey, labelEvents, listCategories } from "../labels";
import { planBlocks } from "../plan-view";
import { todayIn } from "../planner";
import { listTasks } from "../tasks";
import type { ToolContext } from "./tools";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const time = z.string().regex(/^\d{2}:\d{2}$/, "use HH:mm");
const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToUndefined, s.optional());

const S = {
  str: (description?: string) => ({ type: "string", ...(description ? { description } : {}) }),
  int: (description?: string) => ({ type: "integer", ...(description ? { description } : {}) }),
  bool: (description?: string) => ({ type: "boolean", ...(description ? { description } : {}) }),
  enum: (values: string[], description?: string) => ({ type: "string", enum: values, ...(description ? { description } : {}) }),
  arr: (items: object, description?: string) => ({ type: "array", items, ...(description ? { description } : {}) }),
  obj: (properties: Record<string, object>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false }),
};
const hoursItem = S.obj({ weekday: S.int("1 = Monday … 7 = Sunday"), start: S.str("HH:mm"), end: S.str("HH:mm") }, ["weekday", "start", "end"]);

export const CALENDAR_TOOL_DEFS: ToolDef[] = [
  { type: "function", function: { name: "propose_calendar_event", description: "Offer to add an event to the user's calendar, optionally repeating, with a video link, on a chosen calendar. It's added only when they confirm.", parameters: S.obj({
    title: S.str(), day: S.str("YYYY-MM-DD (the first one, if it repeats)"), start: S.str("HH:mm"), end: S.str("HH:mm"),
    attendee_emails: S.arr(S.str(), "Only emails the user gave you"),
    online_meeting: S.bool("Add a Google Meet or Teams link"),
    calendar: S.str("Words from the calendar's name or account email (\"work\", \"personal\"); omit for the default"),
    location: S.str(), description: S.str(),
    repeat: S.obj({ freq: S.enum(["daily", "weekly", "monthly", "yearly"]), interval: S.int("Every n days/weeks/…"), weekdays: S.arr(S.int(), "Weekly only: 1 = Monday … 7 = Sunday"), count: S.int("Number of events"), until: S.str("YYYY-MM-DD") }, ["freq"]),
  }, ["title", "day", "start", "end"]) } },
  { type: "function", function: { name: "propose_event_change", description: "Offer to move or delete one of the user's own calendar events (one with no other guests). It changes only when they confirm. For events with other people, use draft_emails instead.", parameters: S.obj({
    event_ref: S.str("e.g. e3"), action: S.enum(["move", "delete"]), day: S.str("Move: YYYY-MM-DD"), start: S.str("Move: HH:mm"), end: S.str("Move: HH:mm"),
  }, ["event_ref", "action"]) } },
  { type: "function", function: { name: "respond_to_invite", description: "Offer to accept, decline or say maybe to an invitation the user got; the organizer is told when the user confirms.", parameters: S.obj({
    event_ref: S.str("e.g. e3"), response: S.enum(["accepted", "declined", "tentative"]), comment: S.str("Optional short note to the organizer"),
  }, ["event_ref", "response"]) } },
  { type: "function", function: { name: "event_details", description: "Who is invited to one meeting (names and their answers), who organized it, where it is and its video link. Only when the user asks about that meeting.", parameters: S.obj({ event_ref: S.str("e.g. e3") }, ["event_ref"]) } },
  { type: "function", function: { name: "read_calendar_feed", description: "Read a calendar link the user pasted (Canvas, D2L, Moodle, Outlook or any .ics / webcal link) and return its upcoming items, so you can propose_plan them as tasks with due dates.", parameters: S.obj({ url: S.str() }, ["url"]) } },
  { type: "function", function: { name: "time_report", description: "Where time went (or is going) between two days: meeting hours by area and by calendar, planned work hours by area, and tasks finished per area.", parameters: S.obj({ from_day: S.str("YYYY-MM-DD"), to_day: S.str("YYYY-MM-DD") }, ["from_day", "to_day"]) } },
  { type: "function", function: { name: "list_booking_pages", description: "The user's booking pages (the links people use to book time with them): title, lengths, link, on or off.", parameters: S.obj({}) } },
  { type: "function", function: { name: "create_booking_page", description: "Make a new booking page (a link people use to book time with the user), with a video link by default. The user can fine-tune it under Booking pages.", parameters: S.obj({
    title: S.str("e.g. Office hours"), minutes: S.arr(S.int(), "Lengths people can pick"), description: S.str("One or two lines shown to people booking"),
    in_person_address: S.str("Instead of a video call"), secret: S.bool("Not listed on the profile page; only people with the link"),
    hours: S.arr(hoursItem, "When this page can be booked, if not the default booking hours"),
  }, ["title", "minutes"]) } },
  { type: "function", function: { name: "update_booking_page", description: "Turn booking pages on or off (pause them while away), or change a page's lengths, notice, how far ahead, or daily limit.", parameters: S.obj({
    ids: S.arr(S.int(), "Booking page ids"), active: S.bool("false pauses the page"), durations: S.arr(S.int(), "Minutes"),
    min_notice_hours: S.int(), max_days_ahead: S.int(), daily_limit: S.int("0 = no limit"),
  }, ["ids"]) } },
  { type: "function", function: { name: "block_booking_time", description: "Stop people booking on some days (\"no bookings Friday\"), or allow only some hours those days. unblock = back to normal hours. Applies to all booking pages.", parameters: S.obj({
    days: S.arr(S.str(), "YYYY-MM-DD, at most 60"), only_hours: S.arr(S.obj({ start: S.str("HH:mm"), end: S.str("HH:mm") }, ["start", "end"]), "Instead of blocking the day: allow only these hours"), unblock: S.bool(),
  }, ["days"]) } },
  { type: "function", function: { name: "set_booking_hours", description: "Change the weekly hours people can book (\"only after 10\", \"office hours Tuesdays only\"). Days not listed can't be booked. Applies to the default hours, or to one page's own hours.", parameters: S.obj({ page_id: S.int("Omit for the default hours"), days: S.arr(hoursItem) }, ["days"]) } },
  { type: "function", function: { name: "list_bookings", description: "Bookings people made through the booking pages between two days (page and time; names are kept private), with refs for cancel_booking.", parameters: S.obj({ from_day: S.str("YYYY-MM-DD"), to_day: S.str("YYYY-MM-DD") }, ["from_day", "to_day"]) } },
  { type: "function", function: { name: "cancel_booking", description: "Offer to cancel a booking; the person is told when the user confirms.", parameters: S.obj({ booking_ref: S.str("e.g. b2"), reason: S.str("Short, shown to the person") }, ["booking_ref"]) } },
];

export const CALENDAR_TOOL_STATUS: Record<string, string> = {
  propose_calendar_event: "Preparing an event",
  propose_event_change: "Preparing the change",
  respond_to_invite: "Preparing your reply",
  event_details: "Looking at that meeting",
  list_booking_pages: "Looking at your booking pages",
  read_calendar_feed: "Reading that calendar",
  time_report: "Adding up your time",
  create_booking_page: "Making a booking page",
  update_booking_page: "Updating your booking pages",
  block_booking_time: "Blocking booking time",
  set_booking_hours: "Changing your booking hours",
  list_bookings: "Looking at your bookings",
  cancel_booking: "Preparing the cancellation",
};

function localInstant(tz: string, d: string, hm: string) {
  return DateTime.fromISO(`${d}T${hm}`, { zone: tz });
}

const pageUrl = (username: string, slug: string) => `${appUrl()}/${username}/${slug}`;

function toWeekly(days: { weekday: number; start: string; end: string }[]): Record<string, TimeRange[]> {
  const weekly: Record<string, TimeRange[]> = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] };
  for (const d of days) if (d.end > d.start) weekly[String(d.weekday)].push({ start: d.start, end: d.end });
  return weekly;
}

/** Give one booking page hours of its own (a new schedule in the user's time zone), with undo. */
async function ownSchedule(ctx: ToolContext, et: { id: number; title: string; scheduleId: number | null }, weekly: Record<string, TimeRange[]>) {
  const [row] = await db.insert(schedules).values({ userId: ctx.user.id, name: `${et.title} hours`.slice(0, 80), timezone: ctx.user.timezone, weekly }).returning({ id: schedules.id });
  await db.update(eventTypes).set({ scheduleId: row.id }).where(and(eq(eventTypes.id, et.id), eq(eventTypes.userId, ctx.user.id)));
  ctx.undo.push({ op: "deleteSchedule", id: row.id }, { op: "patchEventType", id: et.id, fields: { scheduleId: et.scheduleId } });
  return row.id;
}

/** Every schedule a booking page can use: the user's schedules, the default created if missing. */
async function allSchedules(ctx: ToolContext) {
  await ensureDefaults(ctx.user);
  return listSchedules(ctx.user.id);
}

type Exec = (ctx: ToolContext, args: unknown) => Promise<string>;

export const calendarExecutors: Record<string, Exec> = {
  async propose_calendar_event(ctx, raw) {
    const a = z.object({
      title: z.string().trim().min(1).max(200), day, start: time, end: time, attendee_emails: opt(z.array(z.string().email()).max(20)),
      online_meeting: opt(z.boolean()), calendar: opt(z.string().trim().max(120)), location: opt(z.string().max(300)), description: opt(z.string().max(2000)),
      repeat: opt(z.object({ freq: z.enum(["daily", "weekly", "monthly", "yearly"]), interval: opt(z.number().int().min(1).max(52)), weekdays: opt(z.array(z.number().int().min(1).max(7)).max(7)), count: opt(z.number().int().min(1).max(365)), until: opt(day) })),
    }).parse(raw);
    const tz = ctx.user.timezone;
    const s = localInstant(tz, a.day, a.start);
    const e = localInstant(tz, a.day, a.end);
    if (!s.isValid || !e.isValid || e <= s) return "Error: invalid time.";
    let target: { accountId: number; calendarId: string; label: string; onlineMeetings: boolean } | undefined;
    if (a.calendar) {
      const options = writeTargets(await calendarsForAccounts(await listAccounts(ctx.user.id)));
      const words = a.calendar.toLowerCase().split(/\s+/);
      target = options.find((o) => words.every((w) => o.label.toLowerCase().includes(w)));
      if (!target) return `Error: no calendar matches "${a.calendar}". Calendars: ${options.map((o) => o.label).join("; ")}`;
    }
    const recurrence: Recurrence | undefined = a.repeat ? { freq: a.repeat.freq, interval: a.repeat.interval, byWeekday: a.repeat.weekdays, count: a.repeat.count, until: a.repeat.until } : undefined;
    ctx.cards.push({
      kind: "event", title: a.title, start: s.toISO()!, end: e.toISO()!, attendees: a.attendee_emails ?? [], status: "pending",
      ...(a.online_meeting ? { onlineMeeting: true } : {}),
      ...(target ? { accountId: target.accountId, calendarId: target.calendarId, calendarLabel: target.label } : {}),
      ...(a.location ? { location: a.location } : {}), ...(a.description ? { description: a.description } : {}),
      ...(recurrence ? { recurrence, repeatLabel: repeatText(recurrence) } : {}),
    });
    const note = a.online_meeting && target && !target.onlineMeetings ? " This calendar can't add a video link, so it will be added without one." : "";
    return `Shown to the user with an Add to calendar button; it is not on the calendar until they press it.${note}`;
  },

  async propose_event_change(ctx, raw) {
    const a = z.object({ event_ref: z.string().max(10), action: z.enum(["move", "delete"]), day: opt(day), start: opt(time), end: opt(time) }).parse(raw);
    const ev = ctx.refs.get(a.event_ref);
    if (!ev) return "Error: no such event; use a ref from the calendar data or list_meetings.";
    if (!ev.canEdit) return "Error: the user can't edit that calendar; offer draft_emails instead.";
    const mine = new Set((await listAccounts(ctx.user.id)).map((acc) => acc.email.toLowerCase()));
    const others = ev.attendees.filter((x) => !mine.has(x.email.toLowerCase()) && !x.email.endsWith("resource.calendar.google.com"));
    if (others.length) return `Error: ${others.length} other ${others.length === 1 ? "person is" : "people are"} invited; don't change it yourself. Offer draft_emails to ask them.`;
    if (ev.allDay) return "Error: all-day events can't be changed here.";
    let newStart: string | undefined;
    let newEnd: string | undefined;
    if (a.action === "move") {
      if (!a.day || !a.start) return "Error: give day and start for a move.";
      const s = localInstant(ctx.user.timezone, a.day, a.start);
      const length = Date.parse(ev.end) - Date.parse(ev.start);
      const e = a.end ? localInstant(ctx.user.timezone, a.day, a.end) : s.plus({ milliseconds: length });
      if (!s.isValid || !e.isValid || e <= s) return "Error: invalid time.";
      newStart = s.toISO()!;
      newEnd = e.toISO()!;
    }
    ctx.cards.push({ kind: "event_change", action: a.action, title: ev.title, accountId: ev.accountId, calendarId: ev.calendarId, eventId: ev.id, start: ev.start, end: ev.end, newStart, newEnd, status: "pending" });
    return `Shown to the user with a ${a.action === "move" ? "Move" : "Delete"} button; nothing changes until they press it.`;
  },

  async respond_to_invite(ctx, raw) {
    const a = z.object({ event_ref: z.string().max(10), response: z.enum(["accepted", "declined", "tentative"]), comment: opt(z.string().max(300)) }).parse(raw);
    const ev = ctx.refs.get(a.event_ref);
    if (!ev) return "Error: no such event; use a ref from the calendar data or list_meetings.";
    if (!ev.attendees.length) return "Error: that event has no guests; it's the user's own. Use propose_event_change to move or delete it.";
    ctx.cards.push({ kind: "rsvp", response: a.response, comment: a.comment ?? "", title: ev.title, accountId: ev.accountId, calendarId: ev.calendarId, eventId: ev.id, start: ev.start, end: ev.end, status: "pending" });
    return "Shown to the user with a button to send the reply; nothing is sent until they press it.";
  },

  async event_details(ctx, raw) {
    const a = z.object({ event_ref: z.string().max(10) }).parse(raw);
    const ev = ctx.refs.get(a.event_ref);
    if (!ev) return "Error: no such event; use a ref from the calendar data or list_meetings.";
    const ANSWER: Record<string, string> = { needsAction: "not answered", accepted: "yes", declined: "no", tentative: "maybe", tentativelyAccepted: "maybe", organizer: "organizer" };
    const mine = new Set((await listAccounts(ctx.user.id)).map((acc) => acc.email.toLowerCase()));
    const guests = ev.attendees
      .filter((x) => !x.email.endsWith("resource.calendar.google.com"))
      .slice(0, 40)
      .map((x) => ({ who: mine.has(x.email.toLowerCase()) ? "you" : x.name?.slice(0, 80) || x.email, ...(x.status && ANSWER[x.status] ? { answer: ANSWER[x.status] } : {}) }));
    const rooms = ev.attendees.filter((x) => x.email.endsWith("resource.calendar.google.com")).map((x) => x.name).filter(Boolean);
    return JSON.stringify({
      title: ev.title,
      ...(ev.organizer ? { organizer: ev.organizer.slice(0, 80) } : {}),
      guests: guests.length ? guests : "none (just the user)",
      ...(ev.attendees.length > 40 ? { more_guests: ev.attendees.length - 40 } : {}),
      ...(ev.location || rooms.length ? { where: [ev.location, ...rooms].filter(Boolean).join("; ").slice(0, 300) } : {}),
      ...(ev.meetLink ? { video_link: ev.meetLink } : {}),
      ...(ev.htmlLink ? { open_in_calendar: ev.htmlLink } : {}),
    });
  },

  async read_calendar_feed(ctx, raw) {
    const a = z.object({ url: z.string().trim().min(8).max(2000) }).parse(raw);
    const got = await fetchFeed(a.url);
    if ("error" in got) return `Error: ${got.error}`;
    const items = parseIcs(got.text, ctx.user.timezone, todayIn(ctx.user.timezone));
    if (!items.length) return "The calendar has nothing coming up in the next four months.";
    return JSON.stringify({ upcoming: items, note: "Offer these as tasks with due dates (propose_plan), in a project named after the course or source; skip lectures and other regular classes unless asked." });
  },

  async time_report(ctx, raw) {
    const a = z.object({ from_day: day, to_day: day }).parse(raw);
    const tz = ctx.user.timezone;
    const from = DateTime.fromISO(a.from_day, { zone: tz }).startOf("day");
    let to = DateTime.fromISO(a.to_day, { zone: tz }).endOf("day");
    if (to.diff(from, "days").days > 31) to = from.plus({ days: 31 }).endOf("day");
    const [{ events }, blocks, all, areas] = await Promise.all([
      listAccounts(ctx.user.id).then((accounts) => eventsForAccounts(ctx.user, accounts, from.toJSDate(), to.toJSDate())),
      planBlocks(ctx.user, from.toMillis(), to.toMillis()),
      listTasks(ctx.user.id),
      listCategories(ctx.user.id),
    ]);
    const { labels } = await labelEvents(ctx.user.id, events);
    const name = (id: number | null | undefined) => areas.find((c) => c.id === id)?.name ?? "No area";
    const add = (m: Record<string, number>, k: string, min: number) => (m[k] = (m[k] ?? 0) + min);
    const h = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, Math.round(v / 6) / 10]));
    const meetingsByArea: Record<string, number> = {};
    const meetingsByCalendar: Record<string, number> = {};
    for (const e of events.filter((x) => !x.allDay)) {
      const min = (Date.parse(e.end) - Date.parse(e.start)) / 60_000;
      add(meetingsByArea, name(labels[`${e.accountId}:${eventKey(e)}`]?.categoryId), min);
      add(meetingsByCalendar, e.calendarName ?? "Calendar", min);
    }
    const workByArea: Record<string, number> = {};
    const now = Date.now();
    let workDone = 0;
    for (const b of blocks) {
      const min = (Date.parse(b.end) - Date.parse(b.start)) / 60_000;
      add(workByArea, name(b.categoryId), min);
      if (Date.parse(b.end) <= now && b.status !== "open") workDone += min;
    }
    const finished: Record<string, number> = {};
    for (const t of all) if (t.completedAt && t.status !== "dropped" && t.completedAt >= from.toJSDate() && t.completedAt <= to.toJSDate()) finished[name(t.categoryId)] = (finished[name(t.categoryId)] ?? 0) + 1;
    return JSON.stringify({
      from: from.toISODate(), to: to.toISODate(),
      meeting_hours_by_area: h(meetingsByArea), meeting_hours_by_calendar: h(meetingsByCalendar),
      planned_work_hours_by_area: h(workByArea), planned_work_hours_already_finished: Math.round(workDone / 6) / 10,
      tasks_finished_by_area: finished,
    });
  },

  async list_booking_pages(ctx) {
    const list = await listEventTypes(ctx.user.id);
    if (!list.length) return "The user has no booking pages yet; they can make one under Booking pages.";
    return JSON.stringify(list.map((et) => ({ id: et.id, title: et.title, minutes: et.durations, link: pageUrl(ctx.user.username, et.slug), on: et.active, ...(et.hidden ? { secret: true } : {}), ...(et.dailyLimit ? { daily_limit: et.dailyLimit } : {}), min_notice_hours: Math.round(et.minNotice / 6) / 10, max_days_ahead: et.maxDaysAhead })));
  },

  async create_booking_page(ctx, raw) {
    const a = z.object({
      title: z.string().trim().min(1).max(120), minutes: z.array(z.number().int().min(5).max(720)).min(1).max(6),
      description: opt(z.string().max(1000)), in_person_address: opt(z.string().trim().max(300)), secret: opt(z.boolean()),
      hours: opt(z.array(z.object({ weekday: z.number().int().min(1).max(7), start: time, end: time })).max(21)),
    }).parse(raw);
    const list = await listEventTypes(ctx.user.id);
    if (list.length >= 50) return "Error: that's the most booking pages one account can have.";
    const base = a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "meeting";
    let slug = base;
    for (let n = 2; list.some((et) => et.slug === slug); n++) slug = `${base}-${n}`;
    const [row] = await db
      .insert(eventTypes)
      .values({
        userId: ctx.user.id, title: a.title, slug, description: a.description ?? "", durations: [...new Set(a.minutes)].sort((x, y) => x - y),
        locations: a.in_person_address ? [{ type: "in_person", address: a.in_person_address }] : [{ type: "online" }],
        hidden: a.secret ?? false, position: list.length,
      })
      .returning({ id: eventTypes.id });
    ctx.undo.push({ op: "deleteEventType", id: row.id });
    if (a.hours?.length) await ownSchedule(ctx, { id: row.id, title: a.title, scheduleId: null }, toWeekly(a.hours));
    ctx.actions.push(`Made booking page "${a.title}"`);
    return JSON.stringify({ id: row.id, link: pageUrl(ctx.user.username, slug), note: `${a.hours?.length ? "It has its own hours" : "It uses the default booking hours"}; give the link and say they can adjust it under Booking pages.` });
  },

  async update_booking_page(ctx, raw) {
    const a = z.object({
      ids: z.array(z.number().int()).min(1).max(50), active: opt(z.boolean()), durations: opt(z.array(z.number().int().min(5).max(720)).min(1).max(6)),
      min_notice_hours: opt(z.number().int().min(0).max(24 * 30)), max_days_ahead: opt(z.number().int().min(1).max(365)), daily_limit: opt(z.number().int().min(0).max(50)),
    }).parse(raw);
    const list = (await listEventTypes(ctx.user.id)).filter((et) => a.ids.includes(et.id));
    if (!list.length) return "Error: no such booking page.";
    const fields: Partial<typeof eventTypes.$inferInsert> = {};
    if (a.active !== undefined) fields.active = a.active;
    if (a.durations) fields.durations = [...new Set(a.durations)].sort((x, y) => x - y);
    if (a.min_notice_hours !== undefined) fields.minNotice = a.min_notice_hours * 60;
    if (a.max_days_ahead !== undefined) fields.maxDaysAhead = a.max_days_ahead;
    if (a.daily_limit !== undefined) fields.dailyLimit = a.daily_limit || null;
    if (!Object.keys(fields).length) return "Nothing to change.";
    for (const et of list) {
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(fields)) before[k] = et[k as keyof typeof et];
      await db.update(eventTypes).set(fields).where(and(eq(eventTypes.id, et.id), eq(eventTypes.userId, ctx.user.id)));
      ctx.undo.push({ op: "patchEventType", id: et.id, fields: before });
    }
    const names = list.map((et) => `"${et.title}"`).join(", ");
    ctx.actions.push(a.active === false ? `Paused ${names}` : a.active === true ? `Turned on ${names}` : `Updated ${names}`);
    return "updated";
  },

  async block_booking_time(ctx, raw) {
    const a = z.object({
      days: z.array(day).min(1).max(60), only_hours: opt(z.array(z.object({ start: time, end: time })).max(4)), unblock: opt(z.boolean()),
    }).parse(raw);
    if (a.only_hours?.some((r) => r.end <= r.start)) return "Error: each range must end after it starts.";
    const days = new Set(a.days);
    for (const sc of await allSchedules(ctx)) {
      const kept = sc.overrides.filter((o) => !days.has(o.date));
      const added: DateOverride[] = a.unblock ? [] : a.days.map((date) => ({ date, ranges: (a.only_hours ?? []) as TimeRange[] }));
      await db.update(schedules).set({ overrides: [...kept, ...added].sort((x, y) => x.date.localeCompare(y.date)) }).where(and(eq(schedules.id, sc.id), eq(schedules.userId, ctx.user.id)));
      ctx.undo.push({ op: "patchSchedule", id: sc.id, fields: { overrides: sc.overrides } });
    }
    const when = a.days.length === 1 ? DateTime.fromISO(a.days[0]).toFormat("ccc d LLL") : `${a.days.length} days`;
    ctx.actions.push(a.unblock ? `Booking hours back to normal on ${when}` : a.only_hours?.length ? `Bookings only ${a.only_hours.map((r) => `${r.start}-${r.end}`).join(", ")} on ${when}` : `No bookings on ${when}`);
    return "saved";
  },

  async set_booking_hours(ctx, raw) {
    const a = z.object({ page_id: opt(z.number().int()), days: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: time, end: time })).max(21) }).parse(raw);
    const all = await allSchedules(ctx);
    let sc = all.find((x) => x.isDefault) ?? all[0];
    const weekly = toWeekly(a.days);
    if (a.page_id !== undefined) {
      const et = (await listEventTypes(ctx.user.id)).find((x) => x.id === a.page_id);
      if (!et) return "Error: no such booking page.";
      const own = all.find((x) => x.id === et.scheduleId && !x.isDefault);
      if (!own) {
        // The page shares the default hours: give it hours of its own instead of changing every page.
        const id = await ownSchedule(ctx, et, weekly);
        ctx.actions.push(`"${et.title}" has its own booking hours now`);
        return `saved (new hours for this page only, schedule #${id})`;
      }
      sc = own;
    }
    if (!sc) return "Error: no booking hours to change.";
    await db.update(schedules).set({ weekly }).where(and(eq(schedules.id, sc.id), eq(schedules.userId, ctx.user.id)));
    ctx.undo.push({ op: "patchSchedule", id: sc.id, fields: { weekly: sc.weekly } });
    ctx.actions.push(`Changed booking hours (${sc.name})`);
    return "saved";
  },

  async list_bookings(ctx, raw) {
    const a = z.object({ from_day: day, to_day: day }).parse(raw);
    const tz = ctx.user.timezone;
    const from = DateTime.fromISO(a.from_day, { zone: tz }).startOf("day");
    let to = DateTime.fromISO(a.to_day, { zone: tz }).endOf("day");
    if (to.diff(from, "days").days > 62) to = from.plus({ days: 62 });
    const rows = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.userId, ctx.user.id), eq(bookings.status, "confirmed"), gte(bookings.start, from.toJSDate()), lte(bookings.start, to.toJSDate())))
      .orderBy(bookings.start)
      .limit(100);
    const refs = (ctx.bookingRefs ??= new Map());
    // No names, emails or answers go to the model (see the privacy policy); the user picks a booking by its time.
    return JSON.stringify(
      rows.map((b) => {
        const ref = `b${refs.size + 1}`;
        refs.set(ref, b.uid);
        return { ref, what: b.title, when: `${DateTime.fromJSDate(b.start, { zone: tz }).toFormat("ccc yyyy-MM-dd HH:mm")}-${DateTime.fromJSDate(b.end, { zone: tz }).toFormat("HH:mm")}`, ...(b.guests.length ? { guests: b.guests.length } : {}) };
      }),
    );
  },

  async cancel_booking(ctx, raw) {
    const a = z.object({ booking_ref: z.string().max(10), reason: opt(z.string().max(300)) }).parse(raw);
    const uid = ctx.bookingRefs?.get(a.booking_ref);
    if (!uid) return "Error: unknown ref; call list_bookings first in this turn.";
    const [b] = await db.select().from(bookings).where(and(eq(bookings.uid, uid), eq(bookings.userId, ctx.user.id))).limit(1);
    if (!b || b.status !== "confirmed") return "Error: that booking is already cancelled.";
    ctx.cards.push({ kind: "booking_cancel", uid, title: b.title, who: b.name.split(/\s+/)[0], start: b.start.toISOString(), end: b.end.toISOString(), reason: a.reason ?? "", status: "pending" });
    return "Shown to the user with a Cancel booking button; nothing is cancelled until they press it.";
  },
};

const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function repeatText(r: Recurrence): string {
  const every = r.interval && r.interval > 1 ? `Every ${r.interval} ${{ daily: "days", weekly: "weeks", monthly: "months", yearly: "years" }[r.freq]}` : { daily: "Every day", weekly: "Every week", monthly: "Every month", yearly: "Every year" }[r.freq];
  const on = r.freq === "weekly" && r.byWeekday?.length ? ` on ${r.byWeekday.map((d) => DAY_SHORT[d]).join(", ")}` : "";
  const end = r.count ? `, ${r.count} times` : r.until ? `, until ${DateTime.fromISO(r.until).toFormat("d LLL")}` : "";
  return every + on + end;
}
