import { test } from "node:test";
import assert from "node:assert/strict";
import { firstDueFor, isRepeat, nextDueFor, nudgeTimes, parseRepeat, repeatLabel } from "./repeat.ts";

const TZ = "America/Edmonton";

test("parses the repeat grammar and rejects the rest", () => {
  for (const ok of ["daily", "weekdays", "weekly", "biweekly", "monthly", "yearly", "days:1,3,5", "nth:-1:5", "nth:2:2", "every:3", "times:3", "hours:2:09:00-21:00", "hours:1:08:30-17:00"]) assert.ok(isRepeat(ok), ok);
  for (const bad of ["", "hourly", "days:", "days:8", "nth:5:1", "nth:0:1", "every:1", "every:999", "times:0", "times:7", "weekly ", "hours:0:09:00-17:00", "hours:2:17:00-09:00", "hours:2:9:00-17:00"]) assert.ok(!isRepeat(bad), bad);
  assert.deepEqual(parseRepeat("days:5,1,3,1"), { kind: "days", days: [1, 3, 5] });
});

test("next due dates", () => {
  // 2026-11-06 is a Friday.
  assert.equal(nextDueFor("biweekly", "2026-11-06", TZ), "2026-11-20");
  assert.equal(nextDueFor("yearly", "2026-12-12", TZ), "2027-12-12");
  assert.equal(nextDueFor("every:3", "2026-11-06", TZ), "2026-11-09");
  assert.equal(nextDueFor("days:2,4", "2026-11-06", TZ), "2026-11-10"); // Fri → Tue
  assert.equal(nextDueFor("days:2,4", "2026-11-10", TZ), "2026-11-12"); // Tue → Thu
  assert.equal(nextDueFor("weekdays", "2026-11-06", TZ), "2026-11-09");
});

test("nth weekday of the month, including the last one", () => {
  assert.equal(nextDueFor("nth:-1:5", "2026-11-06", TZ), "2026-11-27"); // last Friday of November
  assert.equal(nextDueFor("nth:-1:5", "2026-11-27", TZ), "2026-12-25");
  assert.equal(nextDueFor("nth:2:2", "2026-11-06", TZ), "2026-11-10"); // 2nd Tuesday
  assert.equal(nextDueFor("nth:2:2", "2026-11-10", TZ), "2026-12-08");
});

test("times a week: tomorrow until the week has enough, then next Monday", () => {
  assert.equal(nextDueFor("times:3", "2026-11-03", TZ, 1), "2026-11-04");
  assert.equal(nextDueFor("times:3", "2026-11-04", TZ, 3), "2026-11-09");
  assert.equal(nextDueFor("times:3", "2026-11-08", TZ, 1), "2026-11-09"); // Sunday rolls to Monday
});

test("first due date lands on a matching day", () => {
  assert.equal(firstDueFor("days:2,4", "2026-11-06", TZ), "2026-11-10");
  assert.equal(firstDueFor("days:5", "2026-11-06", TZ), "2026-11-06");
  assert.equal(firstDueFor("weekdays", "2026-11-07", TZ), "2026-11-09");
  assert.equal(firstDueFor("weekly", "2026-11-07", TZ), "2026-11-07");
});

test("labels", () => {
  assert.equal(repeatLabel("days:1,3,5"), "Every Mon, Wed, Fri");
  assert.equal(repeatLabel("nth:-1:5"), "The last Fri of each month");
  assert.equal(repeatLabel("times:1"), "1 time a week");
  assert.equal(repeatLabel(null), "");
});

test("hourly nudges between two times", () => {
  const times = nudgeTimes("hours:2:09:00-15:00", "2026-11-06", TZ).map((ms) => new Date(ms).toLocaleTimeString("en-CA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }));
  assert.deepEqual(times, ["09:00", "11:00", "13:00", "15:00"]);
  assert.equal(nextDueFor("hours:2:09:00-15:00", "2026-11-06", TZ), "2026-11-07");
  assert.equal(repeatLabel("hours:1:09:00-17:00"), "Every hour, 09:00–17:00");
  assert.deepEqual(nudgeTimes("daily", "2026-11-06", TZ), []);
});
