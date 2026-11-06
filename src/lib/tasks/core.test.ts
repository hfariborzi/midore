import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedTaskIds, compareTasks, daysUntil, dueLabel, formatEstimate, progress, transition, wouldCycle } from "./core.ts";
import type { Task } from "../../db/schema.ts";

const base: Task = {
  id: 0, userId: 1, projectId: null, categoryId: null, title: "", notes: "", kind: "task", status: "open", residue: "",
  estimateMinutes: null, progress: 0, dueDate: null, hardDeadline: false, priority: "normal", energy: null, people: [], repeat: null, seriesId: null, remindAt: null, deferCount: 0, position: 0,
  createdAt: new Date(0), updatedAt: new Date(0), completedAt: null,
};
const t = (over: Partial<Task>): Task => ({ ...base, ...over });

test("good enough needs a residue and counts as complete; done clears it; reopen keeps it", () => {
  assert.deepEqual(transition(t({}), "good_enough", "  "), { error: "Say what is left to do, in a few words" });
  assert.deepEqual(transition(t({}), "good_enough", "send the receipt"), { status: "good_enough", residue: "send the receipt", completed: true });
  assert.deepEqual(transition(t({ status: "good_enough", residue: "send the receipt" }), "done"), { status: "done", residue: "", completed: true });
  assert.deepEqual(transition(t({ status: "good_enough", residue: "send the receipt" }), "open"), { status: "open", residue: "send the receipt", completed: false });
});

test("a before-link that would loop is refused", () => {
  const links = [{ fromTaskId: 1, toTaskId: 2, kind: "before" as const }, { fromTaskId: 2, toTaskId: 3, kind: "before" as const }];
  assert.equal(wouldCycle(links, 3, 1), true);
  assert.equal(wouldCycle(links, 1, 3), false);
  assert.equal(wouldCycle(links, 4, 4), true);
  // "together" links do not order anything
  assert.equal(wouldCycle([{ fromTaskId: 1, toTaskId: 2, kind: "together" }], 2, 1), false);
});

test("a task is blocked only while what it comes after is still open", () => {
  const tasks = [t({ id: 1 }), t({ id: 2 }), t({ id: 3, status: "good_enough" }), t({ id: 4 })];
  const links = [{ fromTaskId: 1, toTaskId: 2, kind: "before" as const }, { fromTaskId: 3, toTaskId: 4, kind: "before" as const }];
  assert.deepEqual([...blockedTaskIds(tasks, links)], [2]);
});

test("list order: open first, then due date, hard deadlines, priority, position", () => {
  const list = [
    t({ id: 1, status: "done" }),
    t({ id: 2, dueDate: "2026-10-20" }),
    t({ id: 3, dueDate: "2026-10-12", priority: "low" }),
    t({ id: 4, dueDate: "2026-10-12", priority: "high" }),
    t({ id: 5 }),
    t({ id: 6, position: -1 }),
  ].sort(compareTasks);
  assert.deepEqual(list.map((x) => x.id), [4, 3, 2, 6, 5, 1]);
});

test("progress counts good enough as done and ignores dropped", () => {
  assert.deepEqual(progress([t({ status: "done" }), t({ status: "good_enough" }), t({}), t({ status: "dropped" })]), { done: 2, total: 3 });
});

test("due labels", () => {
  assert.equal(daysUntil("2026-10-12", "2026-10-10"), 2);
  assert.deepEqual(dueLabel("2026-10-09", "2026-10-10"), { text: "yesterday", tone: "overdue" });
  assert.deepEqual(dueLabel("2026-10-10", "2026-10-10"), { text: "today", tone: "soon" });
  assert.deepEqual(dueLabel("2026-10-14", "2026-10-10"), { text: "in 4 days", tone: "soon" });
  assert.deepEqual(dueLabel("2026-11-01", "2026-10-10"), { text: "Nov 1", tone: "later" });
  assert.equal(dueLabel(null, "2026-10-10"), null);
});

test("estimates read naturally", () => {
  assert.equal(formatEstimate(null), "");
  assert.equal(formatEstimate(45), "45 min");
  assert.equal(formatEstimate(90), "1.5 h");
  assert.equal(formatEstimate(120), "2 h");
});
