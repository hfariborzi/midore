/**
 * Dori's tools. Every tool validates its input with zod, acts only on the signed-in user's data through the
 * same rules as the UI, and records how to undo what it did. Anything that touches someone else or the
 * calendar (an email, a new event) becomes a card the user confirms; Dori never sends or books on her own.
 */
import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  db, categories, dayNotes, pinnedBlocks, projects, taskLinks, tasks, users,
  type DoriCard, type DoriProposal, type Task, type UndoOp, type User,
} from "@/db";
import type { ToolDef } from "../ai/client";
import { listAccounts } from "../calendar";
import { CATEGORY_PALETTE, MAX_CATEGORIES, listCategories } from "../labels";
import { capacityFor, freshPlan, replan, slotsFor, todayIn } from "../planner";
import { validTimezone } from "../oauth";
import { toPalette } from "../palette";
import { MAX_PROJECTS, MAX_TASKS, applyStatus, deferred, getTask, isComplete, listLinks, listProjects, listTasks, ownedTasks, wouldCycle } from "../tasks";
import { firstDueFor, isRepeat, parseRepeat } from "../tasks/repeat";
import { eventsWithRefs, type EventRefs } from "./context";
import { CALENDAR_TOOL_DEFS, CALENDAR_TOOL_STATUS, calendarExecutors } from "./tools-calendar";

export type ToolContext = {
  user: User;
  refs: EventRefs;
  undo: UndoOp[];
  actions: string[];
  cards: DoriCard[];
  proposal?: DoriProposal;
  changed: boolean; // tasks, notes or pins changed: the plan must be recomputed
  celebrated: boolean; // something got finished
  concerned: boolean; // a deadline or capacity warning came up
  bookingRefs?: Map<string, string>; // "b1" → booking uid, for this turn
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const time = z.string().regex(/^\d{2}:\d{2}$/, "use HH:mm");
const priority = z.enum(["high", "normal", "low"]);
const energy = z.enum(["deep", "light"]);
// "never" is accepted (models like to fill every field) and means no repeat. The grammar is in tasks/repeat.ts.
const repeat = z
  .string()
  .trim()
  .refine((v) => v === "never" || isRepeat(v), "unknown repeat; use daily, weekdays, weekly, biweekly, monthly, yearly, days:1,3,5, nth:-1:5, every:3, times:3 or hours:2:09:00-21:00")
  .transform((v) => (v === "never" ? null : v));
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "use YYYY-MM-DDTHH:mm");
// Models often send "" or 0 for fields they mean to leave empty; treat those as absent instead of failing a round.
const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToUndefined, s.optional());

const taskFields = {
  title: z.string().trim().min(1).max(200),
  project: opt(z.union([z.number().int(), z.string().max(120)])),
  area: opt(z.union([z.number().int(), z.string().max(60)])),
  kind: opt(z.enum(["task", "reminder"])),
  estimate_minutes: opt(z.preprocess((v) => (v === 0 ? undefined : typeof v === "number" ? Math.max(5, Math.min(24 * 60, Math.round(v))) : v), z.number().int().optional())),
  due_date: opt(day),
  hard_deadline: opt(z.boolean()),
  priority: opt(priority),
  energy: opt(energy),
  notes: opt(z.string().max(2000)),
  people: opt(z.array(z.string().trim().min(1).max(120)).max(20)),
  repeat: opt(repeat),
  remind_at: opt(z.union([localDateTime, z.literal("none")])),
};

// JSON schemas for the model. Kept plain (no strict mode) so every OpenAI-compatible provider accepts them.
const S = {
  str: (description?: string) => ({ type: "string", ...(description ? { description } : {}) }),
  int: (description?: string) => ({ type: "integer", ...(description ? { description } : {}) }),
  bool: { type: "boolean" },
  enum: (values: string[], description?: string) => ({ type: "string", enum: values, ...(description ? { description } : {}) }),
  arr: (items: object, description?: string) => ({ type: "array", items, ...(description ? { description } : {}) }),
  obj: (properties: Record<string, object>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false }),
};
const idOrName = (what: string) => ({ anyOf: [{ type: "integer" }, { type: "string" }], description: `${what} id, or its exact name` });
const taskProps = {
  title: S.str(),
  project: idOrName("Existing project"),
  area: idOrName("Area (used when there is no project)"),
  kind: S.enum(["task", "reminder"], "reminder = something to remember with no time (errands, chores); never scheduled"),
  estimate_minutes: S.int("Your best guess when the user didn't say"),
  due_date: S.str("YYYY-MM-DD"),
  hard_deadline: S.bool,
  priority: S.enum(["high", "normal", "low"]),
  energy: S.enum(["deep", "light"], "deep = needs focus"),
  notes: S.str(),
  people: S.arr(S.str(), "Names the user mentioned"),
  repeat: S.str(
    "Leave out unless the user said it repeats. daily | weekdays | weekly | biweekly | monthly | yearly | days:1,3,5 (ISO weekdays, 1 = Monday) | nth:2:2 (2nd Tuesday of the month; nth:-1:5 = last Friday) | every:3 (every 3 days) | times:3 (3 times a week, any days) | hours:2:09:00-21:00 (a nudge every 2 hours between those times, every day)",
  ),
  remind_at: S.str("YYYY-MM-DDTHH:mm, user's local time: when to alert them (\"remind me at 6\", \"in 2 hours\"). \"none\" removes the alert"),
};

const TASK_TOOL_DEFS: ToolDef[] = [
  { type: "function", function: { name: "propose_plan", description: "For a brain dump or setting up many things at once: propose areas, projects and tasks for the user to review. Nothing is created until they accept. Reuse existing area and project names where they fit.", parameters: S.obj({
    areas: S.arr(S.obj({ name: S.str(), description: S.str() }, ["name"]), "Only new areas"),
    projects: S.arr(S.obj({ ref: S.str("Short id like p1, used by tasks"), name: S.str(), area: S.str("Area name"), target_date: S.str("YYYY-MM-DD"), notes: S.str() }, ["ref", "name"])),
    tasks: S.arr(S.obj({ ...taskProps, project: S.str("A project ref from this proposal, or an existing project's exact name"), area: S.str("Area name, when there is no project") }, ["title"])),
    links: S.arr(S.obj({ before: S.int("Index into tasks"), after: S.int("Index into tasks") }, ["before", "after"]), "Ordering: 'after' can only start when 'before' is done"),
  }, ["areas", "projects", "tasks", "links"]) } },
  { type: "function", function: { name: "add_tasks", description: "Add one or a few tasks or reminders right away (\"add …\", \"remind me to …\").", parameters: S.obj({ tasks: S.arr(S.obj(taskProps, ["title"])) }, ["tasks"]) } },
  { type: "function", function: { name: "update_task", description: "Change a task: title, project, due date, estimate, priority, energy, notes, people, repeat, kind, alert time, or how far along it is.", parameters: S.obj({ id: S.int(), ...taskProps, title: S.str("New title"), progress: S.int("Percent done, 0-100 (\"halfway\" = 50); the planner plans only what is left") }, ["id"]) } },
  { type: "function", function: { name: "set_task_status", description: "Mark a task done, good enough (mostly done, with a short note of what's left), dropped, or open again. skip = drop only this occurrence of a repeating task; the next one is created.", parameters: S.obj({ id: S.int(), status: S.enum(["done", "good_enough", "dropped", "open", "skip"]), residue: S.str("What is left, for good_enough") }, ["id", "status"]) } },
  { type: "function", function: { name: "delete_tasks", description: "Delete tasks the user asked to remove.", parameters: S.obj({ ids: S.arr(S.int()) }, ["ids"]) } },
  { type: "function", function: { name: "create_project", description: "Create a project under an area.", parameters: S.obj({ name: S.str(), area: idOrName("Area"), target_date: S.str("YYYY-MM-DD"), notes: S.str() }, ["name"]) } },
  { type: "function", function: { name: "update_project", description: "Rename a project, move it to another area, change its target date or notes, or pause or finish it. A paused project's work is not planned; paused_until resumes it on that day.", parameters: S.obj({ id: S.int(), name: S.str(), area: idOrName("Area"), target_date: S.str("YYYY-MM-DD"), notes: S.str(), status: S.enum(["active", "paused", "done"]), paused_until: S.str("YYYY-MM-DD") }, ["id"]) } },
  { type: "function", function: { name: "delete_project", description: "Delete a project and all its tasks. Only when the user asked to delete it (finishing or pausing keeps it).", parameters: S.obj({ id: S.int() }, ["id"]) } },
  { type: "function", function: { name: "create_area", description: "Create a new area of life (e.g. Research, Home). Areas also colour the calendar.", parameters: S.obj({ name: S.str(), description: S.str() }, ["name"]) } },
  { type: "function", function: { name: "update_area", description: "Rename an area, change its description or colour.", parameters: S.obj({ id: S.int(), name: S.str(), description: S.str(), color: S.str("A colour name (red, orange, yellow, green, teal, blue, purple, pink, brown, grey) or #rrggbb") }, ["id"]) } },
  { type: "function", function: { name: "delete_area", description: "Delete an area. Its projects and tasks stay, with no area. Ask the user first: it also forgets which events were labelled with it.", parameters: S.obj({ id: S.int() }, ["id"]) } },
  { type: "function", function: { name: "find_tasks", description: "Search all tasks, including finished ones and ones beyond what you were given: history (\"what did I do last month\", \"when did I last call Dad\"), finished tasks to reopen, old reminders, tasks that keep getting pushed.", parameters: S.obj({
    text: S.str("Words in the title"), status: S.enum(["open", "finished", "any"]), finished_from: S.str("YYYY-MM-DD"), finished_to: S.str("YYYY-MM-DD"),
    created_before: S.str("YYYY-MM-DD"), area: idOrName("Area"), project: idOrName("Project"), kind: S.enum(["task", "reminder"]), repeating: S.bool,
    sort: S.enum(["recent", "most_pushed", "due"]), limit: S.int("Default 30, at most 100"),
  }) } },
  { type: "function", function: { name: "habit_stats", description: "How repeating tasks and habits are going: completions per week, this week's count, current streak, last done.", parameters: S.obj({ text: S.str("Words in the habit's title; omit for all"), weeks: S.int("How many weeks back, default 8") }) } },
  { type: "function", function: { name: "set_preferences", description: "Change how Dori greets the user, her character, or the user's time zone (when they travel or move).", parameters: S.obj({ nickname: S.str("Empty to use their first name"), character: S.enum(["puppy", "kitten"]), timezone: S.str("IANA name, e.g. America/Toronto") }) } },
  { type: "function", function: { name: "link_tasks", description: "Say one task must be done before another, or that tasks go together.", parameters: S.obj({ before: S.int("Task id that comes first"), after: S.int("Task id that comes after"), together: S.arr(S.int(), "Instead of before/after: two task ids that go together") }) } },
  { type: "function", function: { name: "add_day_note", description: "Remember something about a day, a range of days, a weekday or always: moods (\"not in the mood for writing today\"), days kept for one thing, a cap on work, when the day starts or ends, time kept for a project (\"Wednesday mornings for writing\"), a vacation. The planner follows the structured fields.", parameters: S.obj({
    day: S.str("YYYY-MM-DD; omit for a standing note"), to_day: S.str("YYYY-MM-DD: the same note for every day from day to to_day (at most 60)"),
    weekdays: S.arr(S.int(), "1 = Monday … 7 = Sunday: a standing note for these weekdays every week (omit day); [1,2,3,4,5] = every weekday"),
    note: S.str("In the user's words, short"),
    avoid_energy: S.enum(["deep", "light"], "Don't plan this kind of work"),
    skip_task_ids: S.arr(S.int(), "Don't plan these tasks"),
    reserve_for_task_ids: S.arr(S.int(), "Only plan these tasks"),
    reserve_for_project_ids: S.arr(S.int(), "Only plan work from these projects"),
    reserve_for_area_ids: S.arr(S.int(), "Only plan work from these areas"),
    window_start: S.str("HH:mm: with window_end, avoid/skip/reserve apply only between these times"),
    window_end: S.str("HH:mm"),
    start_after: S.str("HH:mm: no planned work before this"),
    end_by: S.str("HH:mm: no planned work after this"),
    max_work_minutes: S.int("At most this much planned work per day (0 = a day off). With a window: 0 keeps the window free"),
    buffer_minutes: S.int("Keep this long free after each meeting"),
  }, ["note"]) } },
  { type: "function", function: { name: "remove_day_notes", description: "Forget notes, e.g. when the user's mood changed.", parameters: S.obj({ ids: S.arr(S.int()) }, ["ids"]) } },
  { type: "function", function: { name: "schedule_task", description: "Fix a task at a time (\"work on X tomorrow 9 to 11\"). The planner fits everything else around it.", parameters: S.obj({ id: S.int(), day: S.str("YYYY-MM-DD"), start: S.str("HH:mm, user's local time"), minutes: S.int() }, ["id", "day", "start", "minutes"]) } },
  { type: "function", function: { name: "unschedule_task", description: "Remove fixed times for a task so the planner places it again.", parameters: S.obj({ id: S.int() }, ["id"]) } },
  { type: "function", function: { name: "set_work_hours", description: "Change the hours when work can be planned, per weekday. Days not listed are off.", parameters: S.obj({ days: S.arr(S.obj({ weekday: S.int("1 = Monday … 7 = Sunday"), start: S.str("HH:mm"), end: S.str("HH:mm") }, ["weekday", "start", "end"])) }, ["days"]) } },
  { type: "function", function: { name: "get_plan", description: "The freshly computed plan after changes: planned work and deadlines at risk.", parameters: S.obj({ days: S.int("How many days ahead, default 7") }) } },
  { type: "function", function: { name: "find_meeting_times", description: "Find times for a meeting that clash with no calendar event. Planned work can move; each option says what would shift.", parameters: S.obj({ minutes: S.int(), from_day: S.str("YYYY-MM-DD"), to_day: S.str("YYYY-MM-DD"), earliest: S.str("HH:mm"), latest: S.str("HH:mm") }, ["minutes"]) } },
  { type: "function", function: { name: "check_capacity", description: "Could the user take on new work? Give your estimate of the hours and an optional deadline; returns free time and which tasks would slip.", parameters: S.obj({ hours: { type: "number" }, by_day: S.str("YYYY-MM-DD") }, ["hours"]) } },
  { type: "function", function: { name: "list_meetings", description: "Calendar events between two days (beyond the week in context), with refs usable by draft_emails.", parameters: S.obj({ from_day: S.str("YYYY-MM-DD"), to_day: S.str("YYYY-MM-DD") }, ["from_day", "to_day"]) } },
  { type: "function", function: { name: "draft_emails", description: "Prepare emails to the attendees of some events (to cancel or move them). The app adds the recipients; the user sends them from their own mail app.", parameters: S.obj({ event_refs: S.arr(S.str()), subject: S.str(), body: S.str("Signed with the user's first name") }, ["event_refs", "subject", "body"]) } },
];

export const TOOL_DEFS: ToolDef[] = [...TASK_TOOL_DEFS, ...CALENDAR_TOOL_DEFS];

// --- Helpers ----------------------------------------------------------------------------------------------

type Areas = Awaited<ReturnType<typeof listCategories>>;
type Projects = Awaited<ReturnType<typeof listProjects>>;

function resolveArea(areas: Areas, ref: number | string | undefined): number | null | "unknown" {
  if (ref === undefined || ref === "") return null;
  const found = typeof ref === "number" ? areas.find((a) => a.id === ref) : areas.find((a) => a.name.toLowerCase() === ref.trim().toLowerCase());
  return found ? found.id : "unknown";
}

function resolveProject(list: Projects, ref: number | string | undefined) {
  if (ref === undefined || ref === "") return null;
  const found = typeof ref === "number" ? list.find((p) => p.id === ref) : list.find((p) => p.name.toLowerCase() === ref.trim().toLowerCase());
  return found ?? "unknown";
}

function localInstant(user: User, d: string, hm: string) {
  return DateTime.fromISO(`${d}T${hm}`, { zone: user.timezone });
}

const COLOR_NAMES: Record<string, string> = {
  red: "#e11d48", vermilion: "#e11d48", orange: "#e2603f", coral: "#e2603f", yellow: "#f5a524", amber: "#f5a524", gold: "#b8861f", brown: "#b8861f",
  green: "#7d9550", olive: "#7d9550", sage: "#557563", teal: "#2f7a78", blue: "#4a6a8c", navy: "#4a6a8c", purple: "#6b5bb5", violet: "#6b5bb5",
  pink: "#9a4a78", plum: "#9a4a78", grey: "#6b6b74", gray: "#6b6b74",
};
function colorFor(name: string): string | null {
  const n = name.toLowerCase();
  if (COLOR_NAMES[n]) return COLOR_NAMES[n];
  return /^#[0-9a-f]{6}$/i.test(n) ? toPalette(n) : null;
}

const snapshotTask = (t: Task): Record<string, unknown> => ({ ...t, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), completedAt: t.completedAt?.toISOString() ?? null });

// --- Executors --------------------------------------------------------------------------------------------

type Exec = (ctx: ToolContext, args: unknown) => Promise<string>;

const executors: Record<string, Exec> = {
  async propose_plan(ctx, raw) {
    const a = z.object({
      areas: z.array(z.object({ name: z.string().trim().min(1).max(30), description: opt(z.string().max(200)) })).max(10).default([]),
      projects: z.array(z.object({ ref: z.string().max(20), name: z.string().trim().min(1).max(120), area: opt(z.string().max(60)), target_date: opt(day), notes: opt(z.string().max(2000)) })).max(40).default([]),
      tasks: z.array(z.object({ ...taskFields, project: opt(z.string().max(120)), area: opt(z.string().max(60)) })).max(150).default([]),
      links: z.array(z.object({ before: z.number().int(), after: z.number().int() })).max(100).default([]),
    }).parse(raw);
    ctx.proposal = {
      areas: a.areas,
      projects: a.projects.map((p) => ({ ref: p.ref, name: p.name, area: p.area, targetDate: p.target_date ?? null, notes: p.notes })),
      tasks: a.tasks.map((t) => ({ title: t.title, project: t.project, area: t.area, kind: t.kind, estimateMinutes: t.estimate_minutes ?? null, dueDate: t.due_date ?? null, hardDeadline: t.hard_deadline, priority: t.priority, energy: t.energy ?? null, notes: t.notes, people: t.people, repeat: t.repeat ?? null })),
      links: a.links.filter((l) => l.before !== l.after && a.tasks[l.before] && a.tasks[l.after]),
      status: "pending",
    };
    return `Shown to the user for review: ${a.areas.length} new areas, ${a.projects.length} projects, ${a.tasks.length} tasks. Nothing is created until they accept. Tell them briefly what you propose and that they can untick anything before accepting.`;
  },

  async add_tasks(ctx, raw) {
    const a = z.object({ tasks: z.array(z.object(taskFields)).min(1).max(30) }).parse(raw);
    const [areas, projectList, existing] = await Promise.all([listCategories(ctx.user.id), listProjects(ctx.user.id), listTasks(ctx.user.id)]);
    if (existing.length + a.tasks.length > MAX_TASKS) return `Error: the task limit (${MAX_TASKS}) would be exceeded.`;
    const out: string[] = [];
    let position = existing.length;
    for (const t of a.tasks) {
      const project = resolveProject(projectList, t.project);
      if (project === "unknown") {
        out.push(`"${t.title}": no project called ${JSON.stringify(t.project)}; create it first or leave project empty`);
        continue;
      }
      const area = project ? project.categoryId : resolveArea(areas, t.area);
      if (area === "unknown") {
        out.push(`"${t.title}": no area called ${JSON.stringify(t.area)}`);
        continue;
      }
      // A nudge ("every 2 hours") is a reminder whose alerts come from its rule.
      const nudge = t.repeat?.startsWith("hours:");
      const kind = nudge ? "reminder" : (t.kind ?? "task");
      const remindAt = !nudge && t.remind_at && t.remind_at !== "none" ? localInstant(ctx.user, t.remind_at.slice(0, 10), t.remind_at.slice(11)) : null;
      // An alert implies the day; a repeat starts on its first matching day.
      let dueDate = t.due_date ?? (remindAt ? remindAt.toISODate() : null);
      if (t.repeat) dueDate = firstDueFor(t.repeat, dueDate ?? todayIn(ctx.user.timezone), ctx.user.timezone);
      const [row] = await db
        .insert(tasks)
        .values({
          userId: ctx.user.id, projectId: project ? project.id : null, categoryId: area, title: t.title, notes: t.notes ?? "", kind,
          estimateMinutes: kind === "reminder" ? null : (t.estimate_minutes ?? null), dueDate, hardDeadline: t.hard_deadline ?? false,
          priority: t.priority ?? "normal", energy: t.energy ?? null, people: t.people ?? [], repeat: t.repeat ?? null,
          remindAt: remindAt?.isValid ? remindAt.toJSDate() : null, position: position++,
        })
        .returning({ id: tasks.id });
      ctx.undo.push({ op: "deleteTask", id: row.id });
      ctx.actions.push(`Added ${kind === "reminder" ? "reminder" : "task"} "${t.title}"`);
      out.push(`added #${row.id} "${t.title}"`);
    }
    ctx.changed = true;
    return out.join("; ");
  },

  async update_task(ctx, raw) {
    const a = z.object({ id: z.number().int(), ...taskFields, title: opt(z.string().trim().min(1).max(200)), progress: opt(z.number().int().min(0).max(100)) }).parse(raw);
    const task = await getTask(ctx.user.id, a.id);
    if (!task) return "Error: no such task.";
    const fields: Partial<Task> = {};
    if (a.title !== undefined) fields.title = a.title;
    if (a.project !== undefined) {
      const project = resolveProject(await listProjects(ctx.user.id), a.project);
      if (project === "unknown") return `Error: no project called ${JSON.stringify(a.project)}.`;
      fields.projectId = project ? project.id : null;
      if (project) fields.categoryId = project.categoryId;
    }
    if (a.area !== undefined && !fields.projectId && !task.projectId) {
      const area = resolveArea(await listCategories(ctx.user.id), a.area);
      if (area === "unknown") return `Error: no area called ${JSON.stringify(a.area)}.`;
      fields.categoryId = area;
    }
    if (a.kind !== undefined) fields.kind = a.kind;
    if (a.estimate_minutes !== undefined) fields.estimateMinutes = a.estimate_minutes;
    if (a.due_date !== undefined) {
      fields.dueDate = a.due_date;
      if (deferred(task.dueDate, a.due_date)) fields.deferCount = task.deferCount + 1;
    }
    if (a.progress !== undefined) fields.progress = a.progress;
    if (a.remind_at !== undefined) {
      const at = a.remind_at === "none" ? null : localInstant(ctx.user, a.remind_at.slice(0, 10), a.remind_at.slice(11));
      if (at && !at.isValid) return "Error: invalid alert time.";
      fields.remindAt = at ? at.toJSDate() : null;
      if (at && !task.dueDate && a.due_date === undefined) fields.dueDate = at.toISODate();
    }
    if (a.hard_deadline !== undefined) fields.hardDeadline = a.hard_deadline;
    if (a.priority !== undefined) fields.priority = a.priority;
    if (a.energy !== undefined) fields.energy = a.energy;
    if (a.notes !== undefined) fields.notes = a.notes;
    if (a.people !== undefined) fields.people = a.people;
    if (a.repeat !== undefined) fields.repeat = a.repeat;
    if (!Object.keys(fields).length) return "Nothing to change.";
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(fields)) {
      const v = task[k as keyof Task];
      before[k] = v instanceof Date ? v.toISOString() : v;
    }
    await db.update(tasks).set({ ...fields, updatedAt: new Date() }).where(and(eq(tasks.id, task.id), eq(tasks.userId, ctx.user.id)));
    ctx.undo.push({ op: "patchTask", id: task.id, fields: before });
    ctx.actions.push(`Updated "${fields.title ?? task.title}"`);
    ctx.changed = true;
    return "updated";
  },

  async set_task_status(ctx, raw) {
    const a = z.object({ id: z.number().int(), status: z.enum(["done", "good_enough", "dropped", "open", "skip"]), residue: opt(z.string().max(300)) }).parse(raw);
    const task = await getTask(ctx.user.id, a.id);
    if (!task) return "Error: no such task.";
    if (a.status === "skip" && !task.repeat) return "Error: only a repeating task can skip one time; use dropped.";
    const r = await applyStatus(ctx.user.id, task, a.status === "skip" ? "dropped" : a.status, a.residue, ctx.user.timezone, { skip: a.status === "skip" });
    if (r.error) return `Error: ${r.error}`;
    ctx.undo.push({ op: "patchTask", id: task.id, fields: { status: task.status, residue: task.residue, completedAt: task.completedAt?.toISOString() ?? null, seriesId: task.seriesId } });
    if (r.nextId) ctx.undo.push({ op: "deleteTask", id: r.nextId });
    const word = { done: "Done", good_enough: "Good enough", dropped: "Dropped", open: "Reopened", skip: "Skipped this time" }[a.status];
    ctx.actions.push(`${word}: "${task.title}"${a.status === "good_enough" && a.residue ? ` (left: ${a.residue})` : ""}`);
    if (a.status === "done" || a.status === "good_enough") ctx.celebrated = true;
    ctx.changed = true;
    return r.nextId ? `${word}. Created the next occurrence (#${r.nextId}).` : word;
  },

  async delete_tasks(ctx, raw) {
    const a = z.object({ ids: z.array(z.number().int()).min(1).max(50) }).parse(raw);
    const rows = await ownedTasks(ctx.user.id, a.ids);
    if (!rows.length) return "Error: none of those tasks exist.";
    const links = await db.select().from(taskLinks).where(and(eq(taskLinks.userId, ctx.user.id), inArray(taskLinks.fromTaskId, rows.map((r) => r.id))));
    const links2 = await db.select().from(taskLinks).where(and(eq(taskLinks.userId, ctx.user.id), inArray(taskLinks.toTaskId, rows.map((r) => r.id))));
    const allLinks = [...new Map([...links, ...links2].map((l) => [l.id, l])).values()];
    for (const t of rows) {
      ctx.undo.push({ op: "restoreTask", row: snapshotTask(t), links: allLinks.filter((l) => l.fromTaskId === t.id || l.toTaskId === t.id) });
      ctx.actions.push(`Removed "${t.title}"`);
    }
    await db.delete(tasks).where(and(eq(tasks.userId, ctx.user.id), inArray(tasks.id, rows.map((r) => r.id))));
    ctx.changed = true;
    return `deleted ${rows.length}`;
  },

  async create_project(ctx, raw) {
    const a = z.object({ name: z.string().trim().min(1).max(120), area: opt(z.union([z.number().int(), z.string().max(60)])), target_date: opt(day), notes: opt(z.string().max(2000)) }).parse(raw);
    const list = await listProjects(ctx.user.id);
    if (list.length >= MAX_PROJECTS) return `Error: the project limit (${MAX_PROJECTS}) is reached.`;
    const existing = list.find((p) => p.name.toLowerCase() === a.name.toLowerCase());
    if (existing) return `A project called "${existing.name}" already exists (#${existing.id}).`;
    const area = resolveArea(await listCategories(ctx.user.id), a.area);
    if (area === "unknown") return `Error: no area called ${JSON.stringify(a.area)}.`;
    const [row] = await db.insert(projects).values({ userId: ctx.user.id, name: a.name, categoryId: area, targetDate: a.target_date ?? null, notes: a.notes ?? "", position: list.length }).returning({ id: projects.id });
    ctx.undo.push({ op: "deleteProject", id: row.id });
    ctx.actions.push(`Created project "${a.name}"`);
    return `created project #${row.id}`;
  },

  async update_project(ctx, raw) {
    const a = z.object({ id: z.number().int(), name: opt(z.string().trim().min(1).max(120)), area: opt(z.union([z.number().int(), z.string().max(60)])), target_date: opt(day), notes: opt(z.string().max(2000)), status: opt(z.enum(["active", "paused", "done"])), paused_until: opt(day) }).parse(raw);
    const [p] = await db.select().from(projects).where(and(eq(projects.id, a.id), eq(projects.userId, ctx.user.id))).limit(1);
    if (!p) return "Error: no such project.";
    const fields: Record<string, unknown> = {};
    if (a.name !== undefined) fields.name = a.name;
    if (a.target_date !== undefined) fields.targetDate = a.target_date;
    if (a.notes !== undefined) fields.notes = a.notes;
    if (a.status !== undefined) {
      fields.status = a.status;
      fields.completedAt = a.status === "done" ? (p.completedAt ?? new Date()) : null;
      if (a.status !== "paused") fields.pausedUntil = null;
    }
    if (a.paused_until !== undefined) {
      fields.status = "paused";
      fields.pausedUntil = a.paused_until;
    }
    if (a.area !== undefined) {
      const area = resolveArea(await listCategories(ctx.user.id), a.area);
      if (area === "unknown") return `Error: no area called ${JSON.stringify(a.area)}.`;
      fields.categoryId = area;
    }
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(fields)) {
      const v = p[k as keyof typeof p];
      before[k] = v instanceof Date ? v.toISOString() : v;
    }
    await db.update(projects).set(fields).where(eq(projects.id, p.id));
    if ("categoryId" in fields) await db.update(tasks).set({ categoryId: fields.categoryId as number | null }).where(and(eq(tasks.projectId, p.id), eq(tasks.userId, ctx.user.id)));
    ctx.undo.push({ op: "patchProject", id: p.id, fields: before });
    ctx.actions.push(`Updated project "${(fields.name as string) ?? p.name}"`);
    ctx.changed = true;
    return "updated";
  },

  async create_area(ctx, raw) {
    const a = z.object({ name: z.string().trim().min(1).max(30), description: opt(z.string().max(200)) }).parse(raw);
    const areas = await listCategories(ctx.user.id);
    const existing = areas.find((c) => c.name.toLowerCase() === a.name.toLowerCase());
    if (existing) return `An area called "${existing.name}" already exists (#${existing.id}).`;
    if (areas.length >= MAX_CATEGORIES) return `Error: the area limit (${MAX_CATEGORIES}) is reached.`;
    const [row] = await db.insert(categories).values({ userId: ctx.user.id, name: a.name, description: a.description ?? "", color: CATEGORY_PALETTE[areas.length % CATEGORY_PALETTE.length], position: areas.length }).returning({ id: categories.id });
    ctx.undo.push({ op: "deleteCategory", id: row.id });
    ctx.actions.push(`Created area "${a.name}"`);
    return `created area #${row.id}`;
  },

  async delete_project(ctx, raw) {
    const a = z.object({ id: z.number().int() }).parse(raw);
    const [p] = await db.select().from(projects).where(and(eq(projects.id, a.id), eq(projects.userId, ctx.user.id))).limit(1);
    if (!p) return "Error: no such project.";
    const rows = await db.select().from(tasks).where(and(eq(tasks.userId, ctx.user.id), eq(tasks.projectId, p.id)));
    const ids = rows.map((r) => r.id);
    const links = ids.length ? (await listLinks(ctx.user.id)).filter((l) => ids.includes(l.fromTaskId) || ids.includes(l.toTaskId)) : [];
    ctx.undo.push({ op: "restoreProject", row: { ...p, createdAt: p.createdAt.toISOString(), completedAt: p.completedAt?.toISOString() ?? null }, tasks: rows.map(snapshotTask), links });
    await db.delete(projects).where(eq(projects.id, p.id)); // its tasks go with it (cascade)
    ctx.actions.push(`Deleted project "${p.name}"${rows.length ? ` and its ${rows.length} task${rows.length > 1 ? "s" : ""}` : ""}`);
    ctx.changed = true;
    return `deleted the project and ${rows.length} tasks`;
  },

  async update_area(ctx, raw) {
    const a = z.object({ id: z.number().int(), name: opt(z.string().trim().min(1).max(30)), description: opt(z.string().max(200)), color: opt(z.string().trim().max(20)) }).parse(raw);
    const areas = await listCategories(ctx.user.id);
    const c = areas.find((x) => x.id === a.id);
    if (!c) return "Error: no such area.";
    const fields: Record<string, unknown> = {};
    if (a.name !== undefined) {
      if (areas.some((x) => x.id !== c.id && x.name.toLowerCase() === a.name!.toLowerCase())) return `Error: an area called "${a.name}" already exists.`;
      fields.name = a.name;
    }
    if (a.description !== undefined) fields.description = a.description;
    if (a.color !== undefined) {
      const color = colorFor(a.color);
      if (!color) return "Error: unknown colour; use red, orange, yellow, green, teal, blue, purple, pink, brown, grey or #rrggbb.";
      fields.color = color;
    }
    if (!Object.keys(fields).length) return "Nothing to change.";
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(fields)) before[k] = c[k as keyof typeof c];
    await db.update(categories).set(fields).where(and(eq(categories.id, c.id), eq(categories.userId, ctx.user.id)));
    ctx.undo.push({ op: "patchCategory", id: c.id, fields: before });
    ctx.actions.push(`Updated area "${(fields.name as string) ?? c.name}"`);
    return "updated";
  },

  async delete_area(ctx, raw) {
    const a = z.object({ id: z.number().int() }).parse(raw);
    const c = (await listCategories(ctx.user.id)).find((x) => x.id === a.id);
    if (!c) return "Error: no such area.";
    const [taskRows, projectRows] = await Promise.all([
      db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.userId, ctx.user.id), eq(tasks.categoryId, c.id))),
      db.select({ id: projects.id }).from(projects).where(and(eq(projects.userId, ctx.user.id), eq(projects.categoryId, c.id))),
    ]);
    ctx.undo.push({ op: "restoreCategory", row: { ...c, createdAt: c.createdAt.toISOString() }, taskIds: taskRows.map((r) => r.id), projectIds: projectRows.map((r) => r.id) });
    await db.delete(categories).where(and(eq(categories.id, c.id), eq(categories.userId, ctx.user.id)));
    ctx.actions.push(`Deleted area "${c.name}"`);
    ctx.changed = true;
    return `deleted; ${projectRows.length} projects and ${taskRows.length} tasks now have no area`;
  },

  async find_tasks(ctx, raw) {
    const a = z.object({
      text: opt(z.string().trim().max(100)), status: opt(z.enum(["open", "finished", "any"])), finished_from: opt(day), finished_to: opt(day), created_before: opt(day),
      area: opt(z.union([z.number().int(), z.string().max(60)])), project: opt(z.union([z.number().int(), z.string().max(120)])), kind: opt(z.enum(["task", "reminder"])),
      repeating: opt(z.boolean()), sort: opt(z.enum(["recent", "most_pushed", "due"])), limit: opt(z.number().int().min(1).max(100)),
    }).parse(raw ?? {});
    const tz = ctx.user.timezone;
    const [all, areas, projectList] = await Promise.all([listTasks(ctx.user.id), listCategories(ctx.user.id), listProjects(ctx.user.id)]);
    const area = a.area !== undefined ? resolveArea(areas, a.area) : null;
    const project = a.project !== undefined ? resolveProject(projectList, a.project) : null;
    if (area === "unknown" || project === "unknown") return "Error: no such area or project.";
    const localDay = (d: Date | null) => (d ? DateTime.fromJSDate(d, { zone: tz }).toISODate()! : null);
    const words = a.text?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    let rows = all.filter((t) => {
      const finished = isComplete(t.status);
      if ((a.status ?? "any") === "open" && finished) return false;
      if (a.status === "finished" && !finished) return false;
      const done = localDay(t.completedAt);
      if (a.finished_from && (!done || done < a.finished_from)) return false;
      if (a.finished_to && (!done || done > a.finished_to)) return false;
      if (a.created_before && localDay(t.createdAt)! >= a.created_before) return false;
      if (area && t.categoryId !== area) return false;
      if (project && t.projectId !== project.id) return false;
      if (a.kind && t.kind !== a.kind) return false;
      if (a.repeating !== undefined && !!t.repeat !== a.repeating) return false;
      return words.every((w) => t.title.toLowerCase().includes(w) || t.notes.toLowerCase().includes(w));
    });
    const sort = a.sort ?? (a.status === "open" ? "due" : "recent");
    if (sort === "most_pushed") rows = rows.filter((t) => t.deferCount > 0).sort((x, y) => y.deferCount - x.deferCount);
    else if (sort === "due") rows.sort((x, y) => (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999"));
    else rows.sort((x, y) => (y.completedAt ?? y.updatedAt).getTime() - (x.completedAt ?? x.updatedAt).getTime());
    const limit = a.limit ?? 30;
    const out = rows.slice(0, limit).map((t) => ({
      id: t.id, title: t.title.slice(0, 120), status: t.status, ...(t.kind === "reminder" ? { reminder: true } : {}),
      ...(t.dueDate ? { due: t.dueDate } : {}), ...(t.completedAt ? { finished: localDay(t.completedAt) } : {}), created: localDay(t.createdAt),
      ...(t.deferCount ? { pushed: t.deferCount } : {}), ...(t.repeat ? { repeat: t.repeat } : {}), ...(t.residue ? { left: t.residue } : {}),
    }));
    return JSON.stringify({ matches: rows.length, shown: out.length, tasks: out });
  },

  async habit_stats(ctx, raw) {
    const a = z.object({ text: opt(z.string().trim().max(100)), weeks: opt(z.number().int().min(1).max(52)) }).parse(raw ?? {});
    const tz = ctx.user.timezone;
    const weeks = a.weeks ?? 8;
    const all = await listTasks(ctx.user.id);
    const words = a.text?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    // A series is every occurrence of one repeating task: the first one and everything pointing to it.
    const series = new Map<number, Task[]>();
    for (const t of all) {
      if (!t.repeat && !t.seriesId) continue;
      const key = t.seriesId ?? t.id;
      series.set(key, [...(series.get(key) ?? []), t]);
    }
    const now = DateTime.now().setZone(tz);
    const out = [...series.values()]
      .map((occ) => {
        const latest = occ.reduce((x, y) => (y.id > x.id ? y : x));
        if (words.length && !words.every((w) => latest.title.toLowerCase().includes(w))) return null;
        if (!latest.repeat) return null; // the habit was stopped
        const done = occ.filter((o) => o.status === "done" || o.status === "good_enough").map((o) => DateTime.fromJSDate(o.completedAt ?? o.updatedAt, { zone: tz }));
        const perWeek = Array.from({ length: weeks }, (_, i) => {
          const w = now.minus({ weeks: i }).startOf("week");
          return done.filter((d) => d.hasSame(w, "week")).length;
        });
        // A weekly target only for rules that repeat within a week; monthly and rarer ones just count.
        const r = parseRepeat(latest.repeat);
        const target = r?.kind === "times" ? r.perWeek : r?.kind === "daily" ? 7 : r?.kind === "weekdays" ? 5 : r?.kind === "days" ? r.days.length : r?.kind === "weekly" ? 1 : null;
        // Streak in weeks that met the target, not counting this week until it has.
        let streak = 0;
        if (target) for (let i = perWeek[0] >= target ? 0 : 1; i < perWeek.length && perWeek[i] >= target; i++) streak++;
        const last = done.sort((x, y) => y.toMillis() - x.toMillis())[0];
        return {
          habit: latest.title.slice(0, 100), repeat: latest.repeat, ...(target ? { target_per_week: target, week_streak: streak } : {}), this_week: perWeek[0],
          per_week_newest_first: perWeek, total_done: done.length,
          skipped: occ.filter((o) => o.status === "dropped").length, last_done: last?.toISODate() ?? null, next_due: latest.status === "open" ? latest.dueDate : null,
        };
      })
      .filter(Boolean)
      .slice(0, 30);
    return out.length ? JSON.stringify(out) : "No repeating tasks match.";
  },

  async set_preferences(ctx, raw) {
    const a = z.object({ nickname: opt(z.string().trim().max(40)), character: opt(z.enum(["puppy", "kitten"])), timezone: opt(z.string().trim().max(60)) }).parse(raw ?? {});
    const fields: Partial<User> = {};
    if (a.nickname !== undefined || a.character) fields.doriPrefs = { nickname: a.nickname ?? ctx.user.doriPrefs?.nickname ?? "", character: a.character ?? ctx.user.doriPrefs?.character };
    if (a.timezone !== undefined) {
      if (!validTimezone(a.timezone)) return "Error: unknown time zone; use an IANA name like America/Toronto.";
      fields.timezone = a.timezone;
    }
    if (!Object.keys(fields).length) return "Nothing to change.";
    ctx.undo.push({ op: "patchUser", fields: { doriPrefs: ctx.user.doriPrefs ?? null, timezone: ctx.user.timezone } });
    await db.update(users).set(fields).where(eq(users.id, ctx.user.id));
    ctx.user = { ...ctx.user, ...fields };
    if (fields.timezone) {
      ctx.actions.push(`Time zone set to ${fields.timezone}`);
      ctx.changed = true;
    }
    if (fields.doriPrefs) ctx.actions.push(a.character ? `Dori is now a ${a.character}` : "Changed how Dori greets you");
    return "saved";
  },

  async link_tasks(ctx, raw) {
    const a = z.object({ before: opt(z.number().int()), after: opt(z.number().int()), together: opt(z.array(z.number().int()).length(2)) }).parse(raw);
    const [from, to, kind] = a.together ? [a.together[0], a.together[1], "together" as const] : [a.before, a.after, "before" as const];
    if (from === undefined || to === undefined || from === to) return "Error: give two different tasks.";
    if ((await ownedTasks(ctx.user.id, [from, to])).length !== 2) return "Error: no such task.";
    const links = await listLinks(ctx.user.id);
    if (links.some((l) => (l.fromTaskId === from && l.toTaskId === to) || (l.fromTaskId === to && l.toTaskId === from))) return "They are already linked.";
    if (kind === "before" && wouldCycle(links, from, to)) return "Error: that would make a loop.";
    const [row] = await db.insert(taskLinks).values({ userId: ctx.user.id, fromTaskId: from, toTaskId: to, kind }).returning({ id: taskLinks.id });
    ctx.undo.push({ op: "deleteLink", id: row.id });
    ctx.actions.push(kind === "before" ? "Linked two tasks in order" : "Grouped two tasks");
    ctx.changed = true;
    return "linked";
  },

  async add_day_note(ctx, raw) {
    const ids = z.array(z.number().int()).max(50);
    const a = z.object({
      day: opt(day), to_day: opt(day), weekday: opt(z.number().int().min(1).max(7)), weekdays: opt(z.array(z.number().int().min(1).max(7)).max(7)), note: z.string().trim().min(1).max(300),
      avoid_energy: opt(energy), skip_task_ids: opt(ids), reserve_for_task_ids: opt(ids), reserve_for_project_ids: opt(ids), reserve_for_area_ids: opt(ids),
      window_start: opt(time), window_end: opt(time), start_after: opt(time), end_by: opt(time), max_work_minutes: opt(z.number().int().min(0).max(24 * 60)),
      buffer_minutes: opt(z.number().int().min(5).max(120)),
    }).parse(raw);
    const weekdays = [...new Set([...(a.weekdays ?? []), ...(a.weekday ? [a.weekday] : [])])].sort();
    const taskIds = [...(a.skip_task_ids ?? []), ...(a.reserve_for_task_ids ?? [])];
    if (taskIds.length && (await ownedTasks(ctx.user.id, taskIds)).length !== new Set(taskIds).size) return "Error: one of those tasks doesn't exist.";
    if (a.reserve_for_project_ids?.length) {
      const mine = new Set((await listProjects(ctx.user.id)).map((p) => p.id));
      if (!a.reserve_for_project_ids.every((id) => mine.has(id))) return "Error: one of those projects doesn't exist.";
    }
    if (a.reserve_for_area_ids?.length) {
      const mine = new Set((await listCategories(ctx.user.id)).map((c) => c.id));
      if (!a.reserve_for_area_ids.every((id) => mine.has(id))) return "Error: one of those areas doesn't exist.";
    }
    if (!!a.window_start !== !!a.window_end || (a.window_start && a.window_end && a.window_end <= a.window_start)) return "Error: give both window_start and window_end, end after start.";
    // One note per day of a range, or per weekday; otherwise one note (dated or standing).
    let days: (string | null)[] = [a.day ?? null];
    if (a.day && a.to_day) {
      const from = DateTime.fromISO(a.day);
      const n = Math.round(DateTime.fromISO(a.to_day).diff(from, "days").days);
      if (n < 0 || n > 60) return "Error: to_day must be on or after day, at most 60 days later.";
      days = Array.from({ length: n + 1 }, (_, i) => from.plus({ days: i }).toISODate()!);
    }
    const slots: { day: string | null; weekday: number | null }[] = a.day || !weekdays.length ? days.map((d) => ({ day: d, weekday: null })) : weekdays.map((w) => ({ day: null, weekday: w }));
    const values = slots.map(({ day: d, weekday }) => ({
      userId: ctx.user.id, day: d, weekday, text: a.note,
      avoidEnergy: a.avoid_energy ?? null, skipTaskIds: a.skip_task_ids ?? [], reserveForTaskIds: a.reserve_for_task_ids ?? [],
      reserveForProjectIds: a.reserve_for_project_ids ?? [], reserveForAreaIds: a.reserve_for_area_ids ?? [],
      windowStart: a.window_start ?? null, windowEnd: a.window_end ?? null, startAfter: a.start_after ?? null, endBy: a.end_by ?? null,
      maxWorkMinutes: a.max_work_minutes ?? null, bufferMinutes: a.buffer_minutes ?? null,
    }));
    const rows = await db.insert(dayNotes).values(values).returning({ id: dayNotes.id });
    for (const r of rows) ctx.undo.push({ op: "deleteNote", id: r.id });
    const WEEKDAY = ["", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
    const when = days.length > 1 ? `${DateTime.fromISO(days[0]!).toFormat("d LLL")} to ${DateTime.fromISO(days.at(-1)!).toFormat("d LLL")}` : a.day ? DateTime.fromISO(a.day).toFormat("ccc d LLL") : weekdays.length === 5 && weekdays[4] === 5 && weekdays[0] === 1 ? "weekdays" : weekdays.map((w) => WEEKDAY[w]).join(", ");
    ctx.actions.push(when ? `Noted for ${when}: ${a.note}` : `Noted: ${a.note}`);
    ctx.changed = true;
    return days.length > 1 ? `noted for ${days.length} days` : "noted";
  },

  async remove_day_notes(ctx, raw) {
    const a = z.object({ ids: z.array(z.number().int()).min(1).max(50) }).parse(raw);
    const rows = await db.select().from(dayNotes).where(and(eq(dayNotes.userId, ctx.user.id), inArray(dayNotes.id, a.ids)));
    for (const r of rows) ctx.undo.push({ op: "restoreNote", row: { ...r, createdAt: r.createdAt.toISOString() } });
    await db.delete(dayNotes).where(and(eq(dayNotes.userId, ctx.user.id), inArray(dayNotes.id, a.ids)));
    if (rows.length) ctx.actions.push(`Forgot ${rows.length === 1 ? "a note" : `${rows.length} notes`}`);
    ctx.changed = true;
    return `removed ${rows.length}`;
  },

  async schedule_task(ctx, raw) {
    const a = z.object({ id: z.number().int(), day, start: time, minutes: z.number().int().min(5).max(12 * 60) }).parse(raw);
    const task = await getTask(ctx.user.id, a.id);
    if (!task) return "Error: no such task.";
    const start = localInstant(ctx.user, a.day, a.start);
    if (!start.isValid) return "Error: invalid time.";
    const [row] = await db.insert(pinnedBlocks).values({ userId: ctx.user.id, taskId: task.id, start: start.toJSDate(), end: start.plus({ minutes: a.minutes }).toJSDate() }).returning({ id: pinnedBlocks.id });
    ctx.undo.push({ op: "deletePinned", id: row.id });
    ctx.actions.push(`Set "${task.title}" for ${start.toFormat("ccc h:mm a")}`);
    ctx.changed = true;
    return "scheduled";
  },

  async unschedule_task(ctx, raw) {
    const a = z.object({ id: z.number().int() }).parse(raw);
    const rows = await db.select().from(pinnedBlocks).where(and(eq(pinnedBlocks.userId, ctx.user.id), eq(pinnedBlocks.taskId, a.id)));
    for (const r of rows) ctx.undo.push({ op: "restorePinned", row: { ...r, start: r.start.toISOString(), end: r.end.toISOString() } });
    await db.delete(pinnedBlocks).where(and(eq(pinnedBlocks.userId, ctx.user.id), eq(pinnedBlocks.taskId, a.id)));
    if (rows.length) ctx.actions.push("Let the planner place a task again");
    ctx.changed = true;
    return `removed ${rows.length} fixed times`;
  },

  async set_work_hours(ctx, raw) {
    const a = z.object({ days: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: time, end: time })).max(21) }).parse(raw);
    const weekly: Record<string, { start: string; end: string }[]> = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] };
    for (const d of a.days) if (d.end > d.start) weekly[String(d.weekday)].push({ start: d.start, end: d.end });
    ctx.undo.push({ op: "setWorkHours", weekly: ctx.user.workHours ?? null });
    await db.update(users).set({ workHours: weekly }).where(eq(users.id, ctx.user.id));
    ctx.user = { ...ctx.user, workHours: weekly };
    ctx.actions.push("Changed your work hours");
    ctx.changed = true;
    return "work hours saved";
  },

  async get_plan(ctx, raw) {
    const a = z.object({ days: opt(z.number().int().min(1).max(14)) }).parse(raw ?? {});
    const plan = ctx.changed ? (await replan(ctx.user, { notify: false })).plan : await freshPlan(ctx.user);
    ctx.changed = false;
    const tz = ctx.user.timezone;
    const titles = new Map((await listTasks(ctx.user.id)).map((t) => [t.id, t.title]));
    const until = Date.now() + (a.days ?? 7) * 86_400_000;
    const blocks = plan.blocks.filter((b) => Date.parse(b.start) < until).slice(0, 80).map((b) => `${DateTime.fromISO(b.start, { zone: tz }).toFormat("ccc yyyy-MM-dd HH:mm")}-${DateTime.fromISO(b.end, { zone: tz }).toFormat("HH:mm")} ${titles.get(b.taskId) ?? "?"}${b.pinned ? " (fixed)" : ""}`);
    if (plan.atRisk.length) ctx.concerned = true;
    const risk = plan.atRisk.map((r) => `${titles.get(r.taskId) ?? "?"}: ${r.reason === "late" ? `finishes after its due date${r.finishesAt ? ` (${DateTime.fromISO(r.finishesAt, { zone: tz }).toFormat("ccc d LLL")})` : ""}` : "does not fit in the next two weeks"}`);
    return JSON.stringify({ planned: blocks, at_risk: risk });
  },

  async find_meeting_times(ctx, raw) {
    const a = z.object({ minutes: z.number().int().min(10).max(8 * 60), from_day: opt(day), to_day: opt(day), earliest: opt(time), latest: opt(time) }).parse(raw);
    const { slots, titles } = await slotsFor(ctx.user, { minutes: a.minutes, fromDay: a.from_day, toDay: a.to_day, earliest: a.earliest, latest: a.latest });
    const tz = ctx.user.timezone;
    ctx.cards.push({ kind: "slots", items: slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), shifts: s.shifts.map((id) => titles.get(id) ?? "planned work") })) });
    if (!slots.length) return "No free time without clashing with an event in that window.";
    return JSON.stringify(slots.map((s) => ({ when: DateTime.fromMillis(s.start, { zone: tz }).toFormat("ccc yyyy-MM-dd HH:mm") + "-" + DateTime.fromMillis(s.end, { zone: tz }).toFormat("HH:mm"), would_shift: s.shifts.map((id) => titles.get(id)) })));
  },

  async check_capacity(ctx, raw) {
    const a = z.object({ hours: z.number().min(0.25).max(500), by_day: opt(day) }).parse(raw);
    const r = await capacityFor(ctx.user, Math.round(a.hours * 60), a.by_day ?? null);
    if (!r.newWorkFits || r.newlyAtRisk.length) ctx.concerned = true;
    return JSON.stringify({ free_work_hours_until_deadline: { until: r.until, hours: Math.round(r.freeMinutes / 6) / 10, after_existing_planned_work: true }, new_work_fits_before_deadline: r.newWorkFits, existing_tasks_that_would_slip: r.newlyAtRisk });
  },

  async list_meetings(ctx, raw) {
    const a = z.object({ from_day: day, to_day: day }).parse(raw);
    const tz = ctx.user.timezone;
    const from = DateTime.fromISO(a.from_day, { zone: tz }).startOf("day");
    let to = DateTime.fromISO(a.to_day, { zone: tz }).endOf("day");
    if (to.diff(from, "days").days > 31) to = from.plus({ days: 31 });
    const { rows } = await eventsWithRefs(ctx.user, from.toJSDate(), to.toJSDate(), ctx.refs);
    return JSON.stringify(rows);
  },

  async draft_emails(ctx, raw) {
    const a = z.object({ event_refs: z.array(z.string().max(10)).min(1).max(20), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(1500) }).parse(raw);
    const mine = new Set((await listAccounts(ctx.user.id)).map((acc) => acc.email.toLowerCase()));
    const items: { label: string; href: string; count: number }[] = [];
    for (const ref of a.event_refs) {
      const e = ctx.refs.get(ref);
      if (!e) continue;
      const to = [...new Set(e.attendees.map((x) => x.email.toLowerCase()).filter((x) => !mine.has(x) && !x.endsWith("resource.calendar.google.com")))];
      if (!to.length) continue;
      const href = `mailto:${to.map(encodeURIComponent).join(",")}?subject=${encodeURIComponent(a.subject)}&body=${encodeURIComponent(a.body)}`;
      items.push({ label: e.title, href, count: to.length });
    }
    if (!items.length) return "None of those events have other attendees to email.";
    ctx.cards.push({ kind: "emails", items });
    return `Prepared ${items.length} email draft${items.length > 1 ? "s" : ""}; the user opens each in their mail app and sends it. Do not say they were sent.`;
  },

};

export async function runTool(ctx: ToolContext, name: string, argsJson: string): Promise<string> {
  const exec = executors[name] ?? calendarExecutors[name];
  if (!exec) return `Error: unknown tool ${name}.`;
  let args: unknown;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return "Error: arguments were not valid JSON.";
  }
  try {
    return await exec(ctx, args);
  } catch (err) {
    if (err instanceof z.ZodError) return `Error: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400)}`;
    throw err;
  }
}

export const TOOL_STATUS: Record<string, string> = {
  propose_plan: "Sorting it all out",
  add_tasks: "Adding",
  update_task: "Updating",
  set_task_status: "Updating",
  delete_tasks: "Removing",
  create_project: "Creating a project",
  update_project: "Updating a project",
  create_area: "Creating an area",
  link_tasks: "Linking",
  add_day_note: "Noting that",
  remove_day_notes: "Forgetting that",
  schedule_task: "Scheduling",
  unschedule_task: "Rescheduling",
  set_work_hours: "Updating your hours",
  get_plan: "Checking the plan",
  delete_project: "Deleting a project",
  update_area: "Updating an area",
  delete_area: "Deleting an area",
  find_tasks: "Looking through your tasks",
  habit_stats: "Counting your habits",
  set_preferences: "Saving that",
  find_meeting_times: "Looking for free time",
  check_capacity: "Checking your capacity",
  list_meetings: "Looking at your calendar",
  draft_emails: "Drafting emails",
  ...CALENDAR_TOOL_STATUS,
};

export { todayIn };
