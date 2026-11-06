import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, matchesDone, nextStepsMessage, renderTitle, ruleMark } from "./automations-core.ts";

const task = (title: string, projectId: number | null = 3, categoryId: number | null = 1, notes = "") => ({ id: 9, title, projectId, categoryId, notes });

test("a finished task sets off rules that fit it", () => {
  assert.equal(matchesDone({ on: "task_done", titleHas: "chapter" }, task("Write Chapter 3"), 1), true);
  assert.equal(matchesDone({ on: "task_done", titleHas: "chapter|draft" }, task("First draft of intro"), 1), true);
  assert.equal(matchesDone({ on: "task_done", titleHas: "chapter" }, task("Write intro"), 1), false);
  assert.equal(matchesDone({ on: "task_done", projectId: 3 }, task("Anything"), 1), true);
  assert.equal(matchesDone({ on: "task_done", projectId: 4 }, task("Anything"), 1), false);
  assert.equal(matchesDone({ on: "task_done", areaId: 1, titleHas: "grade" }, task("Grade quiz"), 1), true);
  assert.equal(matchesDone({ on: "task_done", areaId: 2, titleHas: "grade" }, task("Grade quiz"), 1), false);
});

test("a rule never sets itself off, and needs a condition", () => {
  assert.equal(matchesDone({ on: "task_done", titleHas: "chapter" }, task("Review Chapter 3", 3, 1, `Added by your rule ${ruleMark(1)}`), 1), false);
  assert.equal(matchesDone({ on: "task_done", titleHas: "chapter" }, task("Review Chapter 3", 3, 1, `Added by your rule ${ruleMark(2)}`), 1), true);
  assert.equal(matchesDone({ on: "task_done" }, task("Anything"), 1), false);
  assert.equal(matchesDone({ on: "not_done_by", taskId: 9, day: "2026-11-11" }, task("Anything"), 1), false);
});

test("titles and descriptions", () => {
  assert.equal(renderTitle("Review {task} with supervisor", "Chapter 3"), "Review Chapter 3 with supervisor");
  assert.equal(renderTitle("  ", "Chapter 3"), "Chapter 3");
  assert.equal(describe({ on: "task_done", titleHas: "chapter" }, { do: "create_task", title: "Review {task}", dueInDays: 7 }, { project: "Thesis" }), 'When a task with "chapter" in Thesis is finished, add "Review {task}", due 7 days later.');
  assert.equal(describe({ on: "not_done_by", taskId: 9, day: "2026-11-11" }, { do: "drop" }, { task: "Review" }), 'If "Review" isn\'t done by 2026-11-11, drop it.');
});

test("tell me what's next: the next open tasks, or that it was the last one", () => {
  assert.equal(
    nextStepsMessage("Budget draft", "Grant", [
      { title: "Letters of support", at: "Tue 10 Nov at 9:00" },
      { title: "Final read", at: null },
      { title: "Sign-off", at: null, waitingOn: "Dean" },
    ]),
    "“Budget draft” is done. Next in Grant:\n- Letters of support (planned Tue 10 Nov at 9:00)\n- Final read (not planned yet)\n- Sign-off (waiting on Dean)",
  );
  assert.equal(nextStepsMessage("Submit", "Grant", []), "“Submit” is done. That was the last open task in Grant.");
  assert.equal(describe({ on: "task_done", projectId: 3 }, { do: "tell_next" }, { project: "Grant" }), "When a task in Grant is finished, tell me what's next.");
});
