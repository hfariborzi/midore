/**
 * Projects, tasks and links for one user. Everything here is scoped by user id; the actions in
 * src/app/dashboard/actions.ts do the validation and the writes.
 */
import { and, asc, eq, gte, inArray, like, lt, lte, or } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, projects, taskLinks, tasks, type Project, type Task, type TaskLink, type TaskStatus, type User } from "@/db";
import { nextDue } from "../planner/core";
import { MAX_TASKS, transition } from "./core";
import { nudgeTimes } from "./repeat";

export * from "./core";

export async function listProjects(userId: number): Promise<Project[]> {
  return db.select().from(projects).where(eq(projects.userId, userId)).orderBy(asc(projects.position), asc(projects.id));
}

export async function listTasks(userId: number): Promise<Task[]> {
  return db.select().from(tasks).where(eq(tasks.userId, userId)).orderBy(asc(tasks.position), asc(tasks.id));
}

export async function listLinks(userId: number): Promise<TaskLink[]> {
  return db.select().from(taskLinks).where(eq(taskLinks.userId, userId));
}

export async function getProject(userId: number, id: number): Promise<Project | null> {
  const [p] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, userId))).limit(1);
  return p ?? null;
}

export async function getTask(userId: number, id: number): Promise<Task | null> {
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, userId))).limit(1);
  return t ?? null;
}

/** Tasks owned by the user among the given ids (for validating links). */
export async function ownedTasks(userId: number, ids: number[]): Promise<Task[]> {
  if (!ids.length) return [];
  return db.select().from(tasks).where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)));
}

/**
 * Change a task's status (open, good enough with a residue, done, dropped). Completing a repeating task
 * creates its next occurrence; so does `skip` (drop just this occurrence of a repeating task).
 * Returns the id of that new task, if any.
 */
export async function applyStatus(userId: number, task: Task, status: TaskStatus, residue: string | undefined, tz: string, opts: { skip?: boolean } = {}): Promise<{ error?: string; nextId?: number }> {
  const next = transition(task, status, residue);
  if ("error" in next) return { error: next.error };
  await db
    .update(tasks)
    .set({ status: next.status, residue: next.residue, completedAt: next.completed ? (task.completedAt ?? new Date()) : null, updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
  const finishing = (status === "done" || status === "good_enough" || (status === "dropped" && opts.skip)) && task.status === "open";
  if (!finishing || !task.repeat) return {};
  const count = (await listTasks(userId)).length;
  if (count >= MAX_TASKS) return {};
  const today = DateTime.now().setZone(tz).toISODate()!;
  const from = task.dueDate ?? today;
  const seriesId = task.seriesId ?? task.id;
  let doneThisWeek = 0;
  if (task.repeat.startsWith("times:")) {
    // Counted in the week of the occurrence's due date (a late one still belongs to its week).
    const week = DateTime.fromISO(from, { zone: tz });
    const occurrences = await db.select({ status: tasks.status, dueDate: tasks.dueDate }).from(tasks).where(and(eq(tasks.userId, userId), or(eq(tasks.seriesId, seriesId), eq(tasks.id, seriesId))));
    doneThisWeek = occurrences.filter((o) => (o.status === "done" || o.status === "good_enough") && o.dueDate && DateTime.fromISO(o.dueDate, { zone: tz }).hasSame(week, "week")).length;
  }
  let due = nextDue(task.repeat, from, tz, doneThisWeek);
  // Never create the next one in the past: a habit missed for a week picks up from today.
  while (due < today && !task.repeat.startsWith("times:")) due = nextDue(task.repeat, due, tz);
  if (due < today) due = today;
  const [row] = await db
    .insert(tasks)
    .values({
      userId, projectId: task.projectId, categoryId: task.categoryId, title: task.title, notes: task.notes, kind: task.kind,
      estimateMinutes: task.estimateMinutes, dueDate: due, hardDeadline: task.hardDeadline,
      priority: task.priority, energy: task.energy, people: task.people, repeat: task.repeat, seriesId, remindAt: nextRemindAt(task, due, tz), position: count,
    })
    .returning({ id: tasks.id });
  if (!task.seriesId) await db.update(tasks).set({ seriesId }).where(eq(tasks.id, task.id));
  return { nextId: row.id };
}

/** A repeating task's alert keeps its time of day on the next occurrence's due date. */
function nextRemindAt(task: Task, due: string, tz: string): Date | null {
  if (!task.remindAt) return null;
  const t = DateTime.fromJSDate(task.remindAt, { zone: tz });
  return DateTime.fromISO(due, { zone: tz }).set({ hour: t.hour, minute: t.minute }).toJSDate();
}

export type Alert = { taskId: number; title: string; at: string };

/**
 * Alerts in [from, to): open tasks and reminders with an alert time, and the nudges of "every n hours" reminders
 * (each day from the one it's due, or today when that has passed). What the apps and the web page notify about.
 */
export async function upcomingAlerts(user: Pick<User, "id" | "timezone" | "doriPrefs">, from: Date, to: Date): Promise<Alert[]> {
  const tz = user.timezone;
  // A heads-up n days before every due date, at 9 am (a setting the user can ask Dori for).
  const ahead = user.doriPrefs?.dueHeadsUpDays ?? 0;
  const dueFrom = DateTime.fromJSDate(from, { zone: tz }).plus({ days: ahead }).toISODate()!;
  const dueTo = DateTime.fromJSDate(to, { zone: tz }).plus({ days: ahead }).toISODate()!;
  const [timed, nudges, due] = await Promise.all([
    db
      .select({ id: tasks.id, title: tasks.title, remindAt: tasks.remindAt })
      .from(tasks)
      .where(and(eq(tasks.userId, user.id), eq(tasks.status, "open"), gte(tasks.remindAt, from), lt(tasks.remindAt, to)))
      .orderBy(asc(tasks.remindAt))
      .limit(50),
    db
      .select({ id: tasks.id, title: tasks.title, repeat: tasks.repeat, dueDate: tasks.dueDate })
      .from(tasks)
      .where(and(eq(tasks.userId, user.id), eq(tasks.status, "open"), like(tasks.repeat, "hours:%")))
      .limit(20),
    ahead
      ? db
          .select({ id: tasks.id, title: tasks.title, dueDate: tasks.dueDate })
          .from(tasks)
          .where(and(eq(tasks.userId, user.id), eq(tasks.status, "open"), gte(tasks.dueDate, dueFrom), lte(tasks.dueDate, dueTo)))
          .limit(30)
      : Promise.resolve([]),
  ]);
  const out: Alert[] = timed.map((r) => ({ taskId: r.id, title: r.title, at: r.remindAt!.toISOString() }));
  for (const d of due) {
    const at = DateTime.fromISO(d.dueDate!, { zone: tz }).minus({ days: ahead }).set({ hour: 9 }).toMillis();
    if (at >= from.getTime() && at < to.getTime()) out.push({ taskId: d.id, title: `Due ${ahead === 1 ? "tomorrow" : `in ${ahead} days`}: ${d.title}`, at: new Date(at).toISOString() });
  }
  const today = DateTime.now().setZone(tz).toISODate()!;
  for (const n of nudges) {
    let day = DateTime.fromISO(n.dueDate && n.dueDate > today ? n.dueDate : today, { zone: tz });
    for (let i = 0; i < 3 && day.toMillis() < to.getTime(); i++, day = day.plus({ days: 1 })) {
      for (const ms of nudgeTimes(n.repeat!, day.toISODate()!, tz)) if (ms >= from.getTime() && ms < to.getTime()) out.push({ taskId: n.id, title: n.title, at: new Date(ms).toISOString() });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 80);
}

/** Alerts from a few minutes ago to a day and a half ahead, for the open web page. */
export function alertsSoon(user: Pick<User, "id" | "timezone" | "doriPrefs">) {
  const now = Date.now();
  return upcomingAlerts(user, new Date(now - 10 * 60_000), new Date(now + 36 * 3_600_000));
}
