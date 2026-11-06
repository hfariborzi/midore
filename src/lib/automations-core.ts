/**
 * The pure part of automations (rules the user set up with Dori): which finished task a rule matches, what the
 * new task's title is, and how a rule reads in Settings. Unit tested; the database side is in automations.ts.
 */
import type { AutomationAction, AutomationTrigger } from "../db/schema.ts";

type DoneTask = { id: number; title: string; projectId: number | null; categoryId: number | null; notes: string };

/** Marks a task an automation made, so finishing it never sets the same rule off again. */
export const ruleMark = (id: number) => `[rule ${id}]`;

/** A finished task sets a task_done rule off when it fits every condition the rule has. */
export function matchesDone(trigger: AutomationTrigger, task: DoneTask, ruleId: number): boolean {
  if (trigger.on !== "task_done") return false;
  if (task.notes.includes(ruleMark(ruleId))) return false;
  if (trigger.projectId != null && task.projectId !== trigger.projectId) return false;
  if (trigger.areaId != null && task.categoryId !== trigger.areaId) return false;
  if (trigger.titleHas) {
    // "chapter|draft": any of the words, ignoring case.
    const title = task.title.toLowerCase();
    const words = trigger.titleHas.toLowerCase().split("|").map((w) => w.trim()).filter(Boolean);
    if (words.length && !words.some((w) => title.includes(w))) return false;
  }
  return trigger.projectId != null || trigger.areaId != null || !!trigger.titleHas;
}

/** "{task}" in a new task's title stands for the title of the task that was finished. */
export function renderTitle(template: string, doneTitle: string): string {
  return template.replace(/\{task\}/gi, doneTitle).replace(/\s+/g, " ").trim().slice(0, 200) || doneTitle.slice(0, 200);
}

/** The rule in short words, for Dori's data and for Settings when the user's own words are missing. */
export function describe(trigger: AutomationTrigger, action: AutomationAction, names: { project?: string; area?: string; task?: string } = {}): string {
  const when =
    trigger.on === "task_done"
      ? `When a task${trigger.titleHas ? ` with "${trigger.titleHas.replace(/\|/g, '" or "')}"` : ""}${names.project ? ` in ${names.project}` : names.area ? ` in ${names.area}` : ""} is finished`
      : `If ${names.task ? `"${names.task}"` : "the task"} isn't done by ${trigger.day}`;
  const then =
    action.do === "create_task"
      ? `add "${action.title}"${action.dueInDays != null ? `, due ${action.dueInDays === 0 ? "the same day" : `${action.dueInDays} day${action.dueInDays === 1 ? "" : "s"} later`}` : ""}`
      : action.do === "drop"
        ? "drop it"
        : action.do === "set_priority"
          ? `make it ${action.priority} priority`
          : action.do === "move_due"
            ? `move its due date ${action.days} day${action.days === 1 ? "" : "s"} later`
            : "remind me";
  return `${when}, ${then}.`;
}
