import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allDayDate,
  busyFromEvents,
  calendarColor,
  calendarPath,
  hasMicrosoftCalendarScopes,
  isDeadGrant,
  parseGraphUtc,
  toGraphDateTime,
} from "./microsoft-graph.ts";

const TZ = "America/Edmonton";

test("Graph UTC date-times parse with their 7-digit fractions", () => {
  assert.equal(parseGraphUtc({ dateTime: "2026-10-06T15:00:00.0000000", timeZone: "UTC" }), Date.parse("2026-10-06T15:00:00.000Z"));
  assert.ok(Number.isNaN(parseGraphUtc(undefined)));
});

test("all-day dates survive the UTC conversion in any zone", () => {
  // Midnight in Tokyo is 15:00Z the previous day; midnight in Honolulu is 10:00Z the same day.
  assert.equal(allDayDate({ dateTime: "2026-10-05T15:00:00.0000000", timeZone: "UTC" }), "2026-10-06");
  assert.equal(allDayDate({ dateTime: "2026-10-06T10:00:00.0000000", timeZone: "UTC" }), "2026-10-06");
  assert.equal(allDayDate({ dateTime: "2026-10-06T00:00:00.0000000", timeZone: "UTC" }), "2026-10-06");
});

test("busy intervals skip free and cancelled events and expand all-day busy events to the local day", () => {
  const busy = busyFromEvents(
    [
      { start: { dateTime: "2026-10-06T15:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-06T16:00:00.0000000", timeZone: "UTC" }, showAs: "busy" },
      { start: { dateTime: "2026-10-06T17:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-06T18:00:00.0000000", timeZone: "UTC" }, showAs: "free" },
      { start: { dateTime: "2026-10-06T19:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-06T20:00:00.0000000", timeZone: "UTC" }, showAs: "tentative", isCancelled: true },
      { start: { dateTime: "2026-10-07T06:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-08T06:00:00.0000000", timeZone: "UTC" }, showAs: "oof", isAllDay: true },
    ],
    TZ,
  );
  assert.deepEqual(busy, [
    { start: Date.parse("2026-10-06T15:00:00Z"), end: Date.parse("2026-10-06T16:00:00Z") },
    { start: Date.parse("2026-10-07T06:00:00Z"), end: Date.parse("2026-10-08T06:00:00Z") }, // Oct 7 00:00–24:00 MDT
  ]);
});

test("Graph date-times are sent as wall-clock time in the schedule's zone", () => {
  assert.deepEqual(toGraphDateTime(new Date("2026-10-06T15:00:00Z"), TZ), { dateTime: "2026-10-06T09:00:00", timeZone: TZ });
});

test("scope check accepts both short and fully qualified scope names", () => {
  assert.ok(hasMicrosoftCalendarScopes("openid Calendars.ReadWrite User.Read"));
  assert.ok(hasMicrosoftCalendarScopes("https://graph.microsoft.com/Calendars.ReadWrite"));
  assert.ok(!hasMicrosoftCalendarScopes("openid Calendars.Read"));
});

test("calendar colours fall back to the named palette", () => {
  assert.equal(calendarColor({ hexColor: "#112233" }), "#112233");
  assert.equal(calendarColor({ hexColor: "", color: "lightGreen" }), "#5dbf5d");
  assert.equal(calendarColor({}), "#7c3aed");
});

test("the default calendar maps to /me/calendar and others are URL-encoded", () => {
  assert.equal(calendarPath("primary"), "/me/calendar");
  assert.equal(calendarPath("AAMk=/x"), "/me/calendars/AAMk%3D%2Fx");
});

test("dead grants are recognised by error type or AADSTS code", () => {
  assert.ok(isDeadGrant({ error: "invalid_grant" }));
  assert.ok(isDeadGrant({ error: "server_error", error_codes: [700082] }));
  assert.ok(!isDeadGrant({ error: "temporarily_unavailable" }));
  assert.ok(!isDeadGrant(undefined));
});

test("recurrences become Graph patterns and RRULEs", async () => {
  const { toGraphRecurrence } = await import("./microsoft-graph.ts");
  const { toRRule } = await import("./recurrence.ts");
  const start = new Date("2026-11-09T15:00:00Z"); // Monday 10 am in Toronto
  assert.deepEqual(toGraphRecurrence({ freq: "weekly" }, start, "America/Toronto"), {
    pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"], firstDayOfWeek: "monday" },
    range: { type: "noEnd", startDate: "2026-11-09" },
  });
  assert.deepEqual(toGraphRecurrence({ freq: "monthly", count: 6 }, start, "America/Toronto").range, { type: "numbered", startDate: "2026-11-09", numberOfOccurrences: 6 });
  assert.equal(toRRule({ freq: "weekly", interval: 2, byWeekday: [2, 4] }), "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH");
  assert.equal(toRRule({ freq: "daily", until: "2026-12-01" }), "RRULE:FREQ=DAILY;UNTIL=20261201T235959Z");
});
