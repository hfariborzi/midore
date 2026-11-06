import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { buildBrief, nextBriefTime } from "./brief.ts";

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
