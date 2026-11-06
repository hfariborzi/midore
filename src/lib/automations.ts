/**
 * Automations: rules the user set up with Dori. "Every time I finish a chapter, add a review with my supervisor"
 * runs when a matching task is finished (from applyStatus). "If the review isn't done by Wednesday, drop it" runs
 * once, in the daily job after that day, if the task is still open. Each run is counted and shown in Settings.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { automations, db, tasks, users, type Automation, type Task } from "@/db";
import { logError } from "./log";
import { matchesDone, renderTitle, ruleMark } from "./automations-core";

export const MAX_AUTOMATIONS = 30;

export async function listAutomations(userId: number): Promise<Automation[]> {
  return db.select().from(automations).where(eq(automations.userId, userId)).orderBy(asc(automations.id));
}

async function counted(id: number, opts: { finish?: boolean } = {}) {
  await db
    .update(automations)
    .set({ runs: sql`${automations.runs} + 1`, lastRunAt: new Date(), ...(opts.finish ? { enabled: false } : {}) })
    .where(eq(automations.id, id));
}

/** A task one rule adds: in the rule's project or area (or the finished task's), due some days later. */
async function addTask(rule: Automation, from: Pick<Task, "title" | "projectId" | "categoryId">, tz: string) {
  if (rule.action.do !== "create_task") return;
  const a = rule.action;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.userId, rule.userId));
  const projectId = a.projectId !== undefined ? a.projectId : from.projectId;
  const categoryId = a.areaId !== undefined ? a.areaId : from.categoryId;
  await db.insert(tasks).values({
    userId: rule.userId,
    projectId: projectId ?? null,
    categoryId: categoryId ?? null,
    title: renderTitle(a.title, from.title),
    notes: `Added by your rule: ${rule.label} ${ruleMark(rule.id)}`,
    estimateMinutes: a.estimateMinutes ?? null,
    priority: a.priority ?? "normal",
    dueDate: a.dueInDays != null ? DateTime.now().setZone(tz).plus({ days: a.dueInDays }).toISODate() : null,
    position: n,
  });
}

/** After a task is finished: run every rule it sets off. Errors are logged, never shown; the task stays done. */
export async function runDoneRules(userId: number, task: Task, tz: string): Promise<number> {
  try {
    const rules = (await listAutomations(userId)).filter((r) => r.enabled && matchesDone(r.trigger, task, r.id));
    for (const rule of rules.slice(0, 5)) {
      await addTask(rule, task, tz);
      await counted(rule.id);
    }
    return rules.length;
  } catch (err) {
    logError("automations done", err);
    return 0;
  }
}

/** In the daily job: "if not done by <day>" rules whose day has passed, for every user. Returns the users whose tasks changed. */
export async function runDeadlineRules(): Promise<Set<number>> {
  const rows = await db
    .select({ rule: automations, tz: users.timezone })
    .from(automations)
    .innerJoin(users, eq(users.id, automations.userId))
    .where(and(eq(automations.enabled, true), sql`${automations.trigger}->>'on' = 'not_done_by'`))
    .limit(500);
  const changed = new Set<number>();
  for (const { rule, tz } of rows) {
    if (rule.trigger.on !== "not_done_by") continue;
    const today = DateTime.now().setZone(tz).toISODate()!;
    if (rule.trigger.day >= today) continue;
    try {
      const [task] = await db.select().from(tasks).where(and(eq(tasks.id, rule.trigger.taskId), eq(tasks.userId, rule.userId))).limit(1);
      if (task && task.status === "open") {
        const a = rule.action;
        if (a.do === "drop") await db.update(tasks).set({ status: "dropped", completedAt: new Date(), updatedAt: new Date() }).where(eq(tasks.id, task.id));
        else if (a.do === "set_priority") await db.update(tasks).set({ priority: a.priority, updatedAt: new Date() }).where(eq(tasks.id, task.id));
        else if (a.do === "move_due") {
          const from = task.dueDate && task.dueDate > today ? task.dueDate : today;
          await db.update(tasks).set({ dueDate: DateTime.fromISO(from, { zone: tz }).plus({ days: a.days }).toISODate(), deferCount: task.deferCount + 1, updatedAt: new Date() }).where(eq(tasks.id, task.id));
        } else if (a.do === "remind") {
          // An alert in a few minutes (the apps pick it up on their next sync).
          await db.update(tasks).set({ remindAt: new Date(Date.now() + 5 * 60_000), updatedAt: new Date() }).where(eq(tasks.id, task.id));
        } else await addTask(rule, task, tz);
        changed.add(rule.userId);
        await counted(rule.id, { finish: true });
      } else {
        // Finished or deleted in time: the rule has nothing left to do.
        await db.update(automations).set({ enabled: false }).where(eq(automations.id, rule.id));
      }
    } catch (err) {
      logError("automations deadline", err);
    }
  }
  return changed;
}
