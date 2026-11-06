/**
 * Task changes shared by the dashboard (server actions) and the app API (/api/v1). Callers check who the user is;
 * these functions trust the user they are given.
 */
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, pinnedBlocks, plans, tasks, type TaskStatus, type User } from "@/db";
import { logError } from "@/lib/log";
import { markPlanDirty, replan } from "@/lib/planner";
import { MAX_TASKS, applyStatus, getTask, listTasks } from "@/lib/tasks";

/** The plan depends on tasks: mark it stale and recompute it after the response. */
export async function planChanged(user: User) {
  await markPlanDirty(user.id);
  after(() => replan(user, { notify: false }).catch((err) => logError("replan", err)));
}

/** How a planned block went, set from the calendar or a widget. */
export type BlockState = { status: "done" } | { status: "good_enough"; residue: string } | { status: "partly"; progress: number } | { status: "not_done" };

/**
 * Mark how a block went. The block is pinned where it is first, so it stays on the calendar showing its state
 * instead of disappearing from the plan. Partly done records a percentage; the planner then plans only the rest.
 */
export async function markBlockFor(user: User, taskId: number, start: string, end: string, state: BlockState): Promise<{ error?: string }> {
  const task = await getTask(user.id, taskId);
  if (!task) return { error: "Task not found" };
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return { error: "Invalid time" };
  const [have] = await db
    .select({ id: pinnedBlocks.id })
    .from(pinnedBlocks)
    .where(and(eq(pinnedBlocks.userId, user.id), eq(pinnedBlocks.taskId, taskId), eq(pinnedBlocks.start, s)))
    .limit(1);
  const progress = state.status === "partly" ? Math.round(Math.min(95, Math.max(5, state.progress))) : state.status === "not_done" ? 0 : 100;
  // The outcome stays on the block, so "am I keeping my Wednesday mornings?" can be answered later.
  if (have) await db.update(pinnedBlocks).set({ outcome: state.status, progress }).where(eq(pinnedBlocks.id, have.id));
  else await db.insert(pinnedBlocks).values({ userId: user.id, taskId, start: s, end: e, outcome: state.status, progress });

  if (state.status === "partly") {
    const pct = progress;
    if (task.status !== "open") await applyStatus(user.id, task, "open", undefined, user.timezone);
    await db.update(tasks).set({ progress: pct, updatedAt: new Date() }).where(and(eq(tasks.id, taskId), eq(tasks.userId, user.id)));
  } else if (state.status === "not_done") {
    if (task.status !== "open") await applyStatus(user.id, task, "open", undefined, user.timezone);
    await db.update(tasks).set({ progress: 0, updatedAt: new Date() }).where(and(eq(tasks.id, taskId), eq(tasks.userId, user.id)));
  } else {
    const r = await applyStatus(user.id, task, state.status, state.status === "good_enough" ? state.residue : undefined, user.timezone);
    if (r.error) return { error: r.error };
    if (state.status === "done") await db.update(tasks).set({ progress: 100 }).where(and(eq(tasks.id, taskId), eq(tasks.userId, user.id)));
  }
  await planChanged(user);
  return {};
}

/** A task finished today keeps its blocks for today on the calendar, so the day shows it done instead of empty. */
export async function keepTodaysBlocks(user: User, taskId: number) {
  const [plan] = await db.select().from(plans).where(eq(plans.userId, user.id)).limit(1);
  if (!plan) return;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: user.timezone });
  const rows = plan.blocks
    .filter((b) => b.taskId === taskId && !b.pinned && new Date(b.start).toLocaleDateString("en-CA", { timeZone: user.timezone }) === today)
    .map((b) => ({ userId: user.id, taskId, start: new Date(b.start), end: new Date(b.end), progress: 100 }));
  if (rows.length) await db.insert(pinnedBlocks).values(rows);
}

/** Set a task's status from anywhere (list, widget). Finishing keeps today's blocks on the calendar. */
export async function setStatusFor(user: User, taskId: number, status: TaskStatus, residue?: string): Promise<{ error?: string }> {
  const task = await getTask(user.id, taskId);
  if (!task) return { error: "Task not found" };
  const finishing = (status === "done" || status === "good_enough") && task.status === "open";
  const r = await applyStatus(user.id, task, status, residue, user.timezone);
  if (r.error) return { error: r.error };
  if (status === "done") await db.update(tasks).set({ progress: 100 }).where(eq(tasks.id, task.id));
  if (finishing) await keepTodaysBlocks(user, task.id);
  await planChanged(user);
  return {};
}

/** Quick add from an app: a plain task (or a reminder) with a title, planned like any other. */
export async function quickAddTask(user: User, title: string, kind: "task" | "reminder" = "task"): Promise<{ error?: string; id?: number }> {
  const t = title.trim().slice(0, 300);
  if (!t) return { error: "Write what to add" };
  const count = (await listTasks(user.id)).length;
  if (count >= MAX_TASKS) return { error: `You can have up to ${MAX_TASKS} tasks` };
  const [row] = await db.insert(tasks).values({ userId: user.id, title: t, kind, position: count }).returning({ id: tasks.id });
  await planChanged(user);
  return { id: row.id };
}
