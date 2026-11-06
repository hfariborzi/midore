/**
 * Pure helpers for projects, tasks and links (no I/O; unit tested).
 */
import type { Task, TaskLink, TaskStatus } from "@/db/schema";

export const MAX_PROJECTS = 200;
export const MAX_TASKS = 5000;
export const MAX_LINKS_PER_TASK = 20;

export const TASK_STATUSES: TaskStatus[] = ["open", "good_enough", "done", "dropped"];
export const STATUS_LABEL: Record<TaskStatus, string> = { open: "Open", good_enough: "Good enough", done: "Done", dropped: "Dropped" };

/** Statuses that count as complete: the task has left the plate. */
export const isComplete = (s: TaskStatus) => s === "done" || s === "good_enough" || s === "dropped";

/**
 * "Good enough" needs a residue so the small part left is not forgotten; marking a task done again clears
 * it. Reopening keeps the residue text in case it was the useful part.
 */
export function transition(task: Pick<Task, "status" | "residue">, to: TaskStatus, residue?: string): { status: TaskStatus; residue: string; completed: boolean } | { error: string } {
  if (to === "good_enough") {
    const r = (residue ?? task.residue).trim();
    if (!r) return { error: "Say what is left to do, in a few words" };
    if (r.length > 300) return { error: "Keep the residue short" };
    return { status: "good_enough", residue: r, completed: true };
  }
  if (to === "done") return { status: "done", residue: "", completed: true };
  if (to === "dropped") return { status: "dropped", residue: task.residue, completed: true };
  return { status: "open", residue: task.residue, completed: false };
}

/**
 * Adding "from before to" must not create a cycle. Walks the existing "before" edges from `to` and refuses if
 * `from` is reachable. "together" links are symmetric and never create ordering, so they are not checked.
 */
export function wouldCycle(links: Pick<TaskLink, "fromTaskId" | "toTaskId" | "kind">[], fromTaskId: number, toTaskId: number): boolean {
  if (fromTaskId === toTaskId) return true;
  const next = new Map<number, number[]>();
  for (const l of links) {
    if (l.kind !== "before") continue;
    next.set(l.fromTaskId, [...(next.get(l.fromTaskId) ?? []), l.toTaskId]);
  }
  const seen = new Set<number>();
  const stack = [toTaskId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === fromTaskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

/** Open tasks that cannot start yet because something they come after is still open. */
export function blockedTaskIds(tasks: Pick<Task, "id" | "status">[], links: Pick<TaskLink, "fromTaskId" | "toTaskId" | "kind">[]): Set<number> {
  const open = new Set(tasks.filter((t) => !isComplete(t.status)).map((t) => t.id));
  const blocked = new Set<number>();
  for (const l of links) if (l.kind === "before" && open.has(l.fromTaskId) && open.has(l.toTaskId)) blocked.add(l.toTaskId);
  return blocked;
}

/** Sort for a list: open before complete; then hard deadlines, then any due date, then priority, then position. */
export function compareTasks(a: Task, b: Task): number {
  const ca = isComplete(a.status) ? 1 : 0;
  const cb = isComplete(b.status) ? 1 : 0;
  if (ca !== cb) return ca - cb;
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.hardDeadline !== b.hardDeadline) return a.hardDeadline ? -1 : 1;
  const rank = { high: 0, normal: 1, low: 2 };
  if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
  return a.position - b.position || a.id - b.id;
}

/** "3 of 5 done" for a project; good enough counts. */
export function progress(tasks: Pick<Task, "status" | "kind">[]): { done: number; total: number } {
  const real = tasks.filter((t) => t.status !== "dropped");
  return { done: real.filter((t) => isComplete(t.status)).length, total: real.length };
}

/** A due date pushed later (counted, so "which tasks keep getting pushed?" has an answer). */
export const deferred = (from: string | null, to: string | null | undefined) => !!(from && to && to > from);

/** Days until a YYYY-MM-DD date, in the user's time zone (negative when past). */
export function daysUntil(dateIso: string, todayIso: string): number {
  const d = Date.UTC(+dateIso.slice(0, 4), +dateIso.slice(5, 7) - 1, +dateIso.slice(8, 10));
  const t = Date.UTC(+todayIso.slice(0, 4), +todayIso.slice(5, 7) - 1, +todayIso.slice(8, 10));
  return Math.round((d - t) / 86_400_000);
}

export function dueLabel(dateIso: string | null, todayIso: string): { text: string; tone: "overdue" | "soon" | "later" } | null {
  if (!dateIso) return null;
  const n = daysUntil(dateIso, todayIso);
  if (n < 0) return { text: n === -1 ? "yesterday" : `${-n} days ago`, tone: "overdue" };
  if (n === 0) return { text: "today", tone: "soon" };
  if (n === 1) return { text: "tomorrow", tone: "soon" };
  if (n <= 7) return { text: `in ${n} days`, tone: "soon" };
  const d = new Date(Date.UTC(+dateIso.slice(0, 4), +dateIso.slice(5, 7) - 1, +dateIso.slice(8, 10)));
  return { text: d.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" }), tone: "later" };
}

export function formatEstimate(minutes: number | null): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}
