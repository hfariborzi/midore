import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { blockResult, planHistory, type HistBlock, type HistTask } from "./history.ts";

const TZ = "America/Regina"; // no daylight saving
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis();
const block = (taskId: number, s: string, e: string, extra: Partial<HistBlock> = {}): HistBlock => ({ taskId, start: at(s), end: at(e), outcome: null, progress: null, ...extra });
const task = (id: number, extra: Partial<HistTask> = {}): HistTask => ({ id, title: `Task ${id}`, status: "open", completedAt: null, projectId: 1, categoryId: 1, ...extra });

test("how a passed block went", () => {
  const b = block(1, "2026-11-04T09:00", "2026-11-04T11:00");
  assert.equal(blockResult({ ...b, outcome: "partly" }, task(1), null, TZ), "partly");
  assert.equal(blockResult({ ...b, outcome: "not_done" }, task(1, { status: "done", completedAt: at("2026-11-04T10:00") }), null, TZ), "missed");
  assert.equal(blockResult(b, task(1, { status: "done", completedAt: at("2026-11-04T16:00") }), null, TZ), "done");
  assert.equal(blockResult(b, task(1, { status: "done", completedAt: at("2026-11-06T10:00") }), null, TZ), "done_later");
  assert.equal(blockResult({ ...b, progress: 40 }, task(1), 20, TZ), "partly");
  assert.equal(blockResult({ ...b, progress: 20 }, task(1), 20, TZ), "missed");
  assert.equal(blockResult(b, task(1, { status: "dropped" }), null, TZ), "dropped");
});

test("Wednesday mornings: planned against done, with empty Wednesdays counted", () => {
  const now = at("2026-11-12T12:00"); // a Thursday
  const blocks = [
    block(1, "2026-10-28T09:00", "2026-10-28T11:00", { progress: 10 }), // Wed: worked (progress rose from nothing)
    block(1, "2026-11-04T08:00", "2026-11-04T10:00", { progress: 10 }), // Wed: no change; only 9–10 is in the window
    block(2, "2026-11-04T14:00", "2026-11-04T15:00"), // Wed afternoon: outside the window
    block(3, "2026-11-05T09:00", "2026-11-05T10:00"), // Thursday
  ];
  const h = planHistory(blocks, [task(1), task(2), task(3)], { tz: TZ, now, weeks: 3, weekday: 3, from: "09:00", to: "12:00" });
  assert.equal(h.since, "2026-10-28");
  assert.deepEqual(h.days.map((d) => [d.day, d.planned, d.partly, d.missed]), [["2026-11-11", 0, 0, 0], ["2026-11-04", 60, 0, 60], ["2026-10-28", 120, 120, 0]]);
  assert.equal(h.days[1].blocks[0].time, "09:00–10:00");
  assert.deepEqual(h.total, { planned: 180, done: 0, partly: 120, doneLater: 0, missed: 60, dropped: 0 });
});

test("only the project asked about counts", () => {
  const now = at("2026-11-12T12:00");
  const blocks = [block(1, "2026-11-10T09:00", "2026-11-10T10:00"), block(2, "2026-11-10T10:00", "2026-11-10T11:00")];
  const h = planHistory(blocks, [task(1, { status: "done", completedAt: at("2026-11-10T10:00") }), task(2, { projectId: 2 })], { tz: TZ, now, weeks: 1, projectIds: [1] });
  assert.deepEqual(h.total, { planned: 60, done: 60, partly: 0, doneLater: 0, missed: 0, dropped: 0 });
});
