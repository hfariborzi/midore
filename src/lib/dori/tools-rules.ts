/**
 * Dori's tools for standing arrangements: the order of projects by importance, automations ("every time I finish
 * a chapter, …", "if it isn't done by Wednesday, drop it") and check-ins (times Dori speaks first, like a Sunday
 * review). All are the user's own settings, so Dori changes them directly, with undo.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { automations, db, doriActions, doriMessages, projects, users, type AutomationAction, type AutomationTrigger, type CheckIn } from "@/db";
import type { ToolDef } from "../ai/client";
import { describe } from "../automations-core";
import { checkInLabel } from "./brief";
import { listAutomations, MAX_AUTOMATIONS } from "../automations";
import { listCategories } from "../labels";
import { todayIn } from "../planner";
import { getTask, listProjects } from "../tasks";
import type { ToolContext } from "./tools";
import { undoMessage } from "./undo";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const time = z.string().regex(/^\d{2}:\d{2}$/, "use HH:mm");
const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToUndefined, s.optional());
const idOrName = z.union([z.number().int(), z.string().max(120)]);

const S = {
  str: (description?: string) => ({ type: "string", ...(description ? { description } : {}) }),
  int: (description?: string) => ({ type: "integer", ...(description ? { description } : {}) }),
  enum: (values: string[], description?: string) => ({ type: "string", enum: values, ...(description ? { description } : {}) }),
  arr: (items: object, description?: string) => ({ type: "array", items, ...(description ? { description } : {}) }),
  obj: (properties: Record<string, object>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false }),
};
const ref = (what: string) => ({ anyOf: [{ type: "integer" }, { type: "string" }], description: `${what} id, or its exact name` });

export const RULE_TOOL_DEFS: ToolDef[] = [
  { type: "function", function: { name: "rank_projects", description: "Order projects by importance (\"the thesis comes first, then teaching\"). The planner fits work from higher-ranked projects first when deadlines and priority are equal. Projects not listed lose their rank.", parameters: S.obj({ ids: S.arr(S.int(), "Project ids, most important first") }, ["ids"]) } },
  { type: "function", function: { name: "add_automation", description: "Set up a rule that runs by itself. when task_done: each time a matching task is finished (give title_has, project or area), add a new task. when not_done_by: if one task is still open after by_day, drop it, raise its priority, push its due date or remind the user.", parameters: S.obj({
    label: S.str("The rule in the user's words, short"),
    when: S.enum(["task_done", "not_done_by"]),
    title_has: S.str("task_done: words in the finished task's title; several as \"chapter|draft\""),
    project: ref("task_done: only tasks in this project"),
    area: ref("task_done: only tasks in this area"),
    task_id: S.int("not_done_by: the task"),
    by_day: S.str("not_done_by: YYYY-MM-DD, the last day it may still be done"),
    then: S.enum(["create_task", "drop", "set_priority", "move_due", "remind"], "task_done only allows create_task"),
    new_title: S.str("create_task: the new task's title; {task} stands for the finished task's title"),
    new_project: ref("create_task: project for the new task (default: the finished task's)"),
    due_in_days: S.int("create_task: due this many days after it's added"),
    estimate_minutes: S.int("create_task"),
    priority: S.enum(["high", "normal", "low"], "create_task or set_priority"),
    days: S.int("move_due: how many days later"),
  }, ["label", "when", "then"]) } },
  { type: "function", function: { name: "undo_last", description: "Undo what you changed in your most recent message that changed something (\"undo that\", \"undo the last thing\"). Things the user confirmed on a card (events, emails, replies) can't be undone this way.", parameters: S.obj({}) } },
  { type: "function", function: { name: "remove_automation", description: "Stop and delete an automation.", parameters: S.obj({ id: S.int() }, ["id"]) } },
  { type: "function", function: { name: "set_check_in", description: "A time Dori speaks first besides the morning brief: a notification, and Dori opens with that conversation. week_review (\"every Sunday evening ask me how the week went\"), day_wrap (end of day: done, left, what moves), habits (habit report), custom (text says what to ask). remove deletes one by id.", parameters: S.obj({
    action: S.enum(["add", "remove"]),
    id: S.str("remove: the check-in's id"),
    topic: S.enum(["week_review", "day_wrap", "habits", "custom"]),
    weekdays: S.arr(S.int(), "1 = Monday … 7 = Sunday; empty = every day"),
    time: S.str("HH:mm"),
    text: S.str("custom: what to ask or do, short"),
  }, ["action"]) } },
];

export const RULE_TOOL_STATUS: Record<string, string> = {
  rank_projects: "Ordering your projects",
  add_automation: "Setting up that rule",
  remove_automation: "Removing that rule",
  set_check_in: "Saving that",
  undo_last: "Undoing",
};

type Exec = (ctx: ToolContext, args: unknown) => Promise<string>;

function findByRef<T extends { id: number; name: string }>(list: T[], r: number | string | undefined): T | null | "unknown" {
  if (r === undefined) return null;
  const found = typeof r === "number" ? list.find((x) => x.id === r) : list.find((x) => x.name.toLowerCase() === r.trim().toLowerCase());
  return found ?? "unknown";
}

export const ruleExecutors: Record<string, Exec> = {
  async rank_projects(ctx, raw) {
    const a = z.object({ ids: z.array(z.number().int()).min(1).max(50) }).parse(raw);
    const list = await listProjects(ctx.user.id);
    const unknown = a.ids.filter((id) => !list.some((p) => p.id === id));
    if (unknown.length) return `Error: no project with id ${unknown.join(", ")}.`;
    const ids = [...new Set(a.ids)];
    // The listed ones first, in the user's order; the rest keep their order after them.
    const order = [...ids.map((id) => list.find((p) => p.id === id)!), ...list.filter((p) => !ids.includes(p.id))];
    for (const [i, p] of order.entries()) {
      const rank = i < ids.length ? i + 1 : null;
      if (p.rank === rank && p.position === i) continue;
      ctx.undo.push({ op: "patchProject", id: p.id, fields: { rank: p.rank, position: p.position } });
      await db.update(projects).set({ rank, position: i }).where(and(eq(projects.id, p.id), eq(projects.userId, ctx.user.id)));
    }
    ctx.actions.push(`Ordered projects: ${ids.map((id) => list.find((p) => p.id === id)!.name).join(", ")}`);
    ctx.changed = true;
    return "ordered";
  },

  async add_automation(ctx, raw) {
    const a = z.object({
      label: z.string().trim().min(1).max(200), when: z.enum(["task_done", "not_done_by"]),
      title_has: opt(z.string().trim().max(120)), project: opt(idOrName), area: opt(idOrName), task_id: opt(z.number().int()), by_day: opt(day),
      then: z.enum(["create_task", "drop", "set_priority", "move_due", "remind"]),
      new_title: opt(z.string().trim().min(1).max(200)), new_project: opt(idOrName), due_in_days: opt(z.number().int().min(0).max(365)),
      estimate_minutes: opt(z.number().int().min(5).max(24 * 60)), priority: opt(z.enum(["high", "normal", "low"])), days: opt(z.number().int().min(1).max(365)),
    }).parse(raw);
    const existing = await listAutomations(ctx.user.id);
    if (existing.filter((r) => r.enabled).length >= MAX_AUTOMATIONS) return `Error: at most ${MAX_AUTOMATIONS} automations; remove one first.`;
    const [projectList, areas] = await Promise.all([listProjects(ctx.user.id), listCategories(ctx.user.id)]);
    const names: { project?: string; area?: string; task?: string } = {};

    let trigger: AutomationTrigger;
    if (a.when === "task_done") {
      const project = findByRef(projectList, a.project);
      if (project === "unknown") return `Error: no project called ${JSON.stringify(a.project)}.`;
      const area = findByRef(areas, a.area);
      if (area === "unknown") return `Error: no area called ${JSON.stringify(a.area)}.`;
      if (!a.title_has && !project && !area) return "Error: say which finished tasks set it off: title_has, project or area.";
      if (a.then !== "create_task") return "Error: when a task is finished, the rule can only add a task.";
      trigger = { on: "task_done", projectId: project?.id ?? null, areaId: area?.id ?? null, titleHas: a.title_has ?? null };
      names.project = project?.name;
      names.area = area?.name;
    } else {
      if (!a.task_id || !a.by_day) return "Error: give task_id and by_day.";
      const task = await getTask(ctx.user.id, a.task_id);
      if (!task) return "Error: no such task.";
      if (a.by_day < todayIn(ctx.user.timezone)) return "Error: by_day has passed.";
      trigger = { on: "not_done_by", taskId: task.id, day: a.by_day };
      names.task = task.title;
    }

    let action: AutomationAction;
    if (a.then === "create_task") {
      if (!a.new_title) return "Error: give new_title for the task to add.";
      const project = findByRef(projectList, a.new_project);
      if (project === "unknown") return `Error: no project called ${JSON.stringify(a.new_project)}.`;
      action = { do: "create_task", title: a.new_title, ...(project ? { projectId: project.id, areaId: project.categoryId } : {}), dueInDays: a.due_in_days ?? null, estimateMinutes: a.estimate_minutes ?? null, priority: a.priority ?? null };
    } else if (a.then === "set_priority") action = { do: "set_priority", priority: a.priority ?? "high" };
    else if (a.then === "move_due") action = { do: "move_due", days: a.days ?? 1 };
    else if (a.then === "remind") action = { do: "remind" };
    else action = { do: "drop" };

    const label = a.label || describe(trigger, action, names);
    const [row] = await db.insert(automations).values({ userId: ctx.user.id, label, trigger, action }).returning({ id: automations.id });
    ctx.undo.push({ op: "deleteAutomation", id: row.id });
    ctx.actions.push(`New rule: ${label}`);
    return `added rule #${row.id}: ${describe(trigger, action, names)}`;
  },

  async undo_last(ctx) {
    const [last] = await db
      .select({ messageId: doriActions.messageId })
      .from(doriActions)
      .where(and(eq(doriActions.userId, ctx.user.id), isNull(doriActions.undoneAt)))
      .orderBy(desc(doriActions.id))
      .limit(1);
    if (!last) return "Nothing to undo.";
    const [m] = await db.select().from(doriMessages).where(and(eq(doriMessages.id, last.messageId), eq(doriMessages.userId, ctx.user.id))).limit(1);
    const n = await undoMessage(ctx.user.id, last.messageId);
    if (m) await db.update(doriMessages).set({ meta: { ...m.meta, undone: true, undoable: false } }).where(eq(doriMessages.id, m.id));
    ctx.changed = true;
    return `Undid ${n} change${n === 1 ? "" : "s"} from: "${(m?.content ?? "").slice(0, 120)}"`;
  },

  async remove_automation(ctx, raw) {
    const a = z.object({ id: z.number().int() }).parse(raw);
    const [row] = await db.select().from(automations).where(and(eq(automations.id, a.id), eq(automations.userId, ctx.user.id))).limit(1);
    if (!row) return "Error: no such automation.";
    await db.delete(automations).where(eq(automations.id, row.id));
    ctx.undo.push({ op: "restoreAutomation", row: { ...row, createdAt: row.createdAt.toISOString(), lastRunAt: row.lastRunAt?.toISOString() ?? null } });
    ctx.actions.push(`Removed rule: ${row.label}`);
    return "removed";
  },

  async set_check_in(ctx, raw) {
    const a = z.object({
      action: z.enum(["add", "remove"]), id: opt(z.string().max(20)), topic: opt(z.enum(["week_review", "day_wrap", "habits", "custom"])),
      weekdays: opt(z.array(z.number().int().min(1).max(7)).max(7)), time: opt(time), text: opt(z.string().trim().max(200)),
    }).parse(raw);
    const prefs = { nickname: "", ...ctx.user.doriPrefs };
    const list = prefs.checkIns ?? [];
    let next: CheckIn[];
    let done: string;
    if (a.action === "remove") {
      const gone = list.find((c) => c.id === a.id);
      if (!gone) return `Error: no check-in with id ${JSON.stringify(a.id)}.`;
      next = list.filter((c) => c.id !== a.id);
      done = `Stopped: ${checkInLabel(gone)}`;
    } else {
      if (!a.topic || !a.time) return "Error: give topic and time.";
      if (a.topic === "custom" && !a.text) return "Error: say what to ask in text.";
      if (list.length >= 10) return "Error: at most 10 check-ins; remove one first.";
      const c: CheckIn = { id: Math.random().toString(36).slice(2, 8), weekdays: [...new Set(a.weekdays ?? [])].sort(), at: a.time, topic: a.topic, ...(a.text ? { text: a.text } : {}) };
      next = [...list, c];
      done = `Check-in: ${checkInLabel(c)}`;
    }
    ctx.undo.push({ op: "patchUser", fields: { doriPrefs: ctx.user.doriPrefs ?? null } });
    const doriPrefs = { ...prefs, checkIns: next };
    await db.update(users).set({ doriPrefs }).where(eq(users.id, ctx.user.id));
    ctx.user = { ...ctx.user, doriPrefs };
    ctx.actions.push(done);
    return "saved";
  },
};
