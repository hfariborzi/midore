import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { describeMoves, freeMinutesUntil, meetingSlots, nextDue, pauseFromRules, plan, type PlanInput, type PlanTask } from "./core.ts";

const TZ = "America/Edmonton";
const weekdays9to5 = { "1": [{ start: "09:00", end: "17:00" }], "2": [{ start: "09:00", end: "17:00" }], "3": [{ start: "09:00", end: "17:00" }], "4": [{ start: "09:00", end: "17:00" }], "5": [{ start: "09:00", end: "17:00" }], "6": [], "7": [] };
// Monday 2026-10-12, 08:00 local.
const MON = DateTime.fromISO("2026-10-12T08:00", { zone: TZ });
const t = (id: number, over: Partial<PlanTask> = {}): PlanTask => ({ id, title: `T${id}`, estimateMinutes: 60, dueDate: null, hardDeadline: false, priority: "normal", energy: null, status: "open", kind: "task", position: id, ...over });
const base = (over: Partial<PlanInput> = {}): PlanInput => ({ tz: TZ, now: MON.toMillis(), weekly: weekdays9to5, busy: [], tasks: [], links: [], pinned: [], rules: [], ...over });
const local = (ms: number) => DateTime.fromMillis(ms, { zone: TZ }).toFormat("ccc HH:mm");
// iv("2026-10-12T09:00", "10:30"): the end is a time on the same day.
const iv = (from: string, to: string) => {
  const s = DateTime.fromISO(from, { zone: TZ });
  const [h, m] = to.split(":").map(Number);
  return { start: s.toMillis(), end: s.set({ hour: h, minute: m }).toMillis() };
};

test("tasks go into working hours around meetings, earliest deadline first", () => {
  const out = plan(base({
    busy: [iv("2026-10-12T09:00", "10:30")],
    tasks: [t(1, { dueDate: "2026-10-20" }), t(2, { dueDate: "2026-10-13" })],
  }));
  assert.deepEqual(out.blocks.map((b) => [b.taskId, local(b.start), local(b.end)]), [
    [2, "Mon 10:30", "Mon 11:30"],
    [1, "Mon 11:30", "Mon 12:30"],
  ]);
  assert.deepEqual(out.atRisk, []);
});

test("long work is split into sittings of at most two hours", () => {
  const out = plan(base({ tasks: [t(1, { estimateMinutes: 300 })] }));
  assert.deepEqual(out.blocks.map((b) => [local(b.start), local(b.end)]), [["Mon 09:00", "Mon 11:00"], ["Mon 11:00", "Mon 13:00"], ["Mon 13:00", "Mon 14:00"]]);
});

test("a task that comes after another starts only when that one is planned to finish", () => {
  const out = plan(base({ tasks: [t(1, { estimateMinutes: 90 }), t(2, { estimateMinutes: 30, dueDate: "2026-10-12" })], links: [{ fromTaskId: 1, toTaskId: 2, kind: "before" }] }));
  const second = out.blocks.find((b) => b.taskId === 2)!;
  assert.equal(local(second.start), "Mon 10:30");
});

test("a deadline that can't be met is flagged late; reminders and finished tasks are ignored", () => {
  const out = plan(base({
    busy: [iv("2026-10-12T09:00", "17:00")],
    tasks: [t(1, { dueDate: "2026-10-12", hardDeadline: true }), t(2, { kind: "reminder" }), t(3, { status: "good_enough" })],
  }));
  assert.deepEqual(out.blocks.map((b) => b.taskId), [1]);
  assert.equal(local(out.blocks[0].start), "Tue 09:00");
  assert.equal(out.atRisk[0].taskId, 1);
  assert.equal(out.atRisk[0].reason, "late");
});

test("notes for a day steer the planner: avoid deep work, skip a task, keep a day for one task, cap the hours", () => {
  const tasks = [t(1, { energy: "deep" }), t(2), t(3)];
  const avoid = plan(base({ tasks, rules: [{ day: "2026-10-12", avoidEnergy: "deep" }] }));
  assert.equal(local(avoid.blocks.find((b) => b.taskId === 1)!.start), "Tue 09:00");
  const skip = plan(base({ tasks, rules: [{ day: "2026-10-12", skipTaskIds: [2] }] }));
  assert.equal(local(skip.blocks.find((b) => b.taskId === 2)!.start), "Tue 09:00");
  const reserve = plan(base({ tasks, rules: [{ day: "2026-10-12", reserveForTaskIds: [3] }] }));
  assert.equal(local(reserve.blocks.find((b) => b.taskId === 3)!.start), "Mon 09:00");
  assert.equal(local(reserve.blocks.find((b) => b.taskId === 1)!.start), "Tue 09:00");
  const cap = plan(base({ tasks, rules: [{ day: "2026-10-12", maxWorkMinutes: 60 }] }));
  assert.deepEqual(cap.blocks.filter((b) => local(b.start).startsWith("Mon")).map((b) => b.taskId), [1]);
});

test("pinned work stays put and counts toward the estimate", () => {
  const out = plan(base({ tasks: [t(1, { estimateMinutes: 90 }), t(2)], pinned: [{ taskId: 1, ...iv("2026-10-12T09:00", "10:00") }] }));
  assert.deepEqual(out.blocks.map((b) => [b.taskId, local(b.start), b.pinned]), [[1, "Mon 09:00", true], [1, "Mon 10:00", false], [2, "Mon 10:30", false]]);
});

test("nothing is planned in the past", () => {
  const out = plan(base({ now: DateTime.fromISO("2026-10-12T16:20", { zone: TZ }).toMillis(), tasks: [t(1)] }));
  assert.deepEqual(out.blocks.map((b) => [local(b.start), local(b.end)]), [["Mon 16:20", "Mon 17:00"], ["Tue 09:00", "Tue 09:20"]]);
});

test("free minutes before a date account for meetings and planned work", () => {
  const input = base({ busy: [iv("2026-10-12T09:00", "12:00")], tasks: [t(1, { estimateMinutes: 120 })] });
  const out = plan(input);
  assert.equal(freeMinutesUntil(input, out, "2026-10-12"), 180); // 8 working hours - 3 h meeting - 2 h planned
});

test("meeting slots avoid events, and say which planned work would move", () => {
  const input = base({ busy: [iv("2026-10-12T09:00", "12:00")], tasks: [t(1, { estimateMinutes: 120 })] });
  const out = plan(input);
  const slots = meetingSlots(input, out, { minutes: 60, fromDay: "2026-10-12", toDay: "2026-10-12" });
  assert.ok(slots.every((s) => s.start >= iv("2026-10-12T12:00", "12:00").start));
  // Times that move nothing come first; times that would move the planned work fill the rest, and say so.
  assert.deepEqual(slots.filter((s) => s.shifts.length === 0).map((s) => local(s.start)), ["Mon 14:00", "Mon 15:00", "Mon 16:00"]);
  assert.deepEqual(slots.find((s) => local(s.start) === "Mon 12:00")?.shifts, [1]);
});

test("repeating tasks roll forward; weekdays skip the weekend", () => {
  assert.equal(nextDue("daily", "2026-10-16", TZ), "2026-10-17");
  assert.equal(nextDue("weekdays", "2026-10-16", TZ), "2026-10-19");
  assert.equal(nextDue("weekly", "2026-10-16", TZ), "2026-10-23");
  assert.equal(nextDue("monthly", "2026-01-31", TZ), "2026-02-28");
});

test("moves are described only when work shifts by more than half an hour", () => {
  const a = [{ taskId: 1, start: iv("2026-10-12T09:00", "10:00").start, end: 0, pinned: false }, { taskId: 2, start: iv("2026-10-12T10:00", "10:00").start, end: 0, pinned: false }];
  const b = [{ taskId: 1, start: iv("2026-10-12T09:15", "10:00").start, end: 0, pinned: false }, { taskId: 2, start: iv("2026-10-13T09:00", "10:00").start, end: 0, pinned: false }];
  assert.deepEqual(describeMoves(a, b, new Map([[1, "Draft"], [2, "Review"]]), TZ), ['Moved "Review" from Mon 10:00 AM to Tue 9:00 AM']);
});

test("start after and end by trim the day", () => {
  const out = plan(base({ tasks: [t(1, { estimateMinutes: 120 })], rules: [{ day: "2026-10-12", startAfter: "10:00", endBy: "11:00" }] }));
  assert.deepEqual(out.blocks.map((b) => [local(b.start), local(b.end)]), [["Mon 10:00", "Mon 11:00"], ["Tue 09:00", "Tue 10:00"]]);
});

test("a windowed reservation keeps the morning for one project and lets other work have the afternoon", () => {
  const out = plan(base({
    tasks: [t(1, { estimateMinutes: 60, projectId: 7 }), t(2, { estimateMinutes: 60, dueDate: "2026-10-12" })],
    rules: [{ day: "2026-10-12", window: { start: "09:00", end: "12:00" }, reserveForProjectIds: [7] }],
  }));
  assert.deepEqual(out.blocks.map((b) => [b.taskId, local(b.start)]), [[1, "Mon 09:00"], [2, "Mon 12:00"]]);
});

test("deep work only in the morning: avoid deep work in an afternoon window", () => {
  const out = plan(base({
    now: MON.set({ hour: 13 }).toMillis(),
    tasks: [t(1, { energy: "deep" }), t(2, { energy: "light" })],
    rules: ["2026-10-12", "2026-10-13"].map((day) => ({ day, window: { start: "12:00", end: "24:00" }, avoidEnergy: "deep" as const })),
  }));
  assert.deepEqual(out.blocks.map((b) => [b.taskId, local(b.start)]), [[2, "Mon 13:00"], [1, "Tue 09:00"]]);
});

test("two reservations on one day add up rather than block each other", () => {
  const out = plan(base({ tasks: [t(1), t(2), t(3)], rules: [{ day: "2026-10-12", reserveForTaskIds: [1] }, { day: "2026-10-12", reserveForAreaIds: [4] }] }));
  const monday = out.blocks.filter((b) => local(b.start).startsWith("Mon")).map((b) => b.taskId);
  assert.deepEqual(monday, [1]);
  const out2 = plan(base({ tasks: [t(1), t(2, { categoryId: 4 })], rules: [{ day: "2026-10-12", reserveForTaskIds: [1] }, { day: "2026-10-12", reserveForAreaIds: [4] }] }));
  assert.deepEqual(out2.blocks.map((b) => [b.taskId, local(b.start)]), [[1, "Mon 09:00"], [2, "Mon 10:00"]]);
});

test("a buffer after meetings and a lunch window kept free", () => {
  const out = plan(base({
    busy: [iv("2026-10-12T09:00", "10:00")],
    tasks: [t(1, { estimateMinutes: 180 })],
    rules: [{ day: "2026-10-12", bufferMinutes: 15 }, { day: "2026-10-12", window: { start: "12:00", end: "13:00" }, maxWorkMinutes: 0 }],
  }));
  assert.deepEqual(out.blocks.map((b) => [local(b.start), local(b.end)]), [["Mon 10:15", "Mon 12:00"], ["Mon 13:00", "Mon 14:15"]]);
});

test("work from a project paused from a later day is planned only before that day", () => {
  const rules = pauseFromRules([{ id: 7, status: "active", pausedFrom: "2026-10-13", pausedUntil: "2026-10-15" }, { id: 8, status: "paused", pausedFrom: "2026-10-12", pausedUntil: null }], [{ id: 1, projectId: 7 }, { id: 2, projectId: 8 }, { id: 3, projectId: null }], TZ, MON.toMillis(), 5);
  assert.deepEqual(rules.map((r) => [r.day, r.skipTaskIds]), [["2026-10-13", [1]], ["2026-10-14", [1]]]);
  const out = plan(base({ busy: [iv("2026-10-12T09:00", "17:00")], tasks: [t(1, { projectId: 7 })], rules }));
  assert.equal(local(out.blocks[0].start), "Thu 09:00");
});

test("with equal deadlines and priority, work from higher-ranked projects goes first; unranked after", () => {
  const out = plan(base({ tasks: [t(1, { projectId: 5, rank: null }), t(2, { projectId: 6, rank: 2 }), t(3, { projectId: 7, rank: 1 })] }));
  assert.deepEqual(out.blocks.map((b) => b.taskId), [3, 2, 1]);
  const urgent = plan(base({ tasks: [t(1, { priority: "high" }), t(2, { rank: 1 })] }));
  assert.deepEqual(urgent.blocks.map((b) => b.taskId), [1, 2]);
});
