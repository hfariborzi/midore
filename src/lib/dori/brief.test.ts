import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { buildBrief, buildCheckIn, checkInLabel, checkInPrompt, checkInTimes, nextBriefTime } from "./brief.ts";

const TZ = "America/Edmonton";
const ms = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis();

test("the next brief time falls inside the window or not at all", () => {
  assert.equal(nextBriefTime("08:00", TZ, ms("2026-11-06T07:00"), ms("2026-11-08T00:00"))?.toISO(), "2026-11-06T08:00:00.000-07:00");
  assert.equal(nextBriefTime("08:00", TZ, ms("2026-11-06T09:00"), ms("2026-11-08T00:00"))?.toISODate(), "2026-11-07");
  assert.equal(nextBriefTime("08:00", TZ, ms("2026-11-06T09:00"), ms("2026-11-07T00:00")), null);
  assert.equal(nextBriefTime(null, TZ, 0, Infinity), null);
});

test("the brief sums up one day", () => {
  const at = DateTime.fromISO("2026-11-06T08:00", { zone: TZ });
  const items = [
    { kind: "event" as const, title: "Standup", start: "2026-11-06T09:30:00-07:00", end: "2026-11-06T10:00:00-07:00", allDay: false },
    { kind: "event" as const, title: "1:1", start: "2026-11-06T14:00:00-07:00", end: "2026-11-06T15:00:00-07:00", allDay: false },
    { kind: "task" as const, title: "Write", start: "2026-11-06T10:00:00-07:00", end: "2026-11-06T12:30:00-07:00", allDay: false },
    { kind: "event" as const, title: "Tomorrow", start: "2026-11-07T09:00:00-07:00", end: "2026-11-07T10:00:00-07:00", allDay: false },
  ];
  const b = buildBrief(at, items, 2, ["Lit review"]);
  assert.equal(b.body, "2 meetings, first at 9:30 am · 2.5 h of planned work · 2 reminders. At risk: Lit review.");
  assert.equal(b.id, "brief:2026-11-06");
  assert.equal(buildBrief(at, [], 0, []).body, "No meetings.");
});

test("check-in times on their weekdays, inside the window", () => {
  const sunday = { id: "a1", weekdays: [7], at: "18:00", topic: "week_review" as const };
  const daily = { id: "b2", weekdays: [], at: "17:00", topic: "day_wrap" as const };
  // Fri 2026-11-06 09:00 to Mon 2026-11-09 00:00
  const times = checkInTimes([sunday, daily], TZ, ms("2026-11-06T09:00"), ms("2026-11-09T00:00"));
  assert.deepEqual(times.map((t) => `${t.c.id} ${t.at.toFormat("ccc HH:mm")}`), ["b2 Fri 17:00", "b2 Sat 17:00", "b2 Sun 17:00", "a1 Sun 18:00"]);
  assert.deepEqual(checkInTimes(undefined, TZ, 0, 1), []);
});

test("check-in notifications, prompts and labels", () => {
  const at = DateTime.fromISO("2026-11-08T18:00", { zone: TZ });
  const review = buildCheckIn({ id: "a1", weekdays: [7], at: "18:00", topic: "week_review" }, at, { today: 1, week: 9, openToday: 0 });
  assert.equal(review.id, "checkin:a1:2026-11-08");
  assert.equal(review.body, "You finished 9 tasks this week. Open Midore to go over it with Dori.");
  const wrap = buildCheckIn({ id: "b2", weekdays: [], at: "17:00", topic: "day_wrap" }, at, { today: 1, week: 9, openToday: 2 });
  assert.equal(wrap.body, "1 thing done today, 2 still planned. Dori can move what's left.");
  assert.equal(checkInLabel({ id: "x", weekdays: [1, 2, 3, 4, 5], at: "17:00", topic: "day_wrap" }), "End-of-day wrap-up, weekdays at 17:00");
  assert.equal(checkInLabel({ id: "x", weekdays: [7], at: "18:00", topic: "custom", text: "Ask how the thesis is going" }), "Ask how the thesis is going, Sun at 18:00");
  assert.match(checkInPrompt({ id: "x", weekdays: [], at: "18:00", topic: "week_review" }), /^Week review/);
});
