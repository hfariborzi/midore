/**
 * The planner: places open tasks into free working time, around meetings and pinned work, in deadline order,
 * respecting "comes after" links and notes for the day. Pure and deterministic, so it can re-run on every
 * calendar change at no cost, and the same inputs always give the same plan. The model never does this part.
 */
import { DateTime } from "luxon";
import type { DateOverride, Priority, TaskEnergy, TaskLink, TaskStatus, WeeklyHours } from "@/db/schema";
import type { Interval } from "../calendar/types";
import { nextDueFor } from "../tasks/repeat.ts";

export const HORIZON_DAYS = 14;
export const DEFAULT_ESTIMATE = 30; // minutes, for tasks without one
const MIN_CHUNK = 25; // never plan less than this unless it finishes the task
const MAX_CHUNK = 120; // break long work into sittings of at most two hours
const STEP_MS = 5 * 60_000;

export type PlanTask = {
  id: number;
  title: string;
  estimateMinutes: number | null;
  dueDate: string | null; // YYYY-MM-DD
  hardDeadline: boolean;
  priority: Priority;
  energy: TaskEnergy | null;
  status: TaskStatus;
  kind: "task" | "reminder";
  position: number;
  projectId?: number | null;
  categoryId?: number | null;
};

export type DayRule = {
  day: string; // YYYY-MM-DD
  avoidEnergy?: TaskEnergy | null;
  skipTaskIds?: number[];
  reserveForTaskIds?: number[];
  reserveForProjectIds?: number[];
  reserveForAreaIds?: number[];
  maxWorkMinutes?: number | null;
  window?: { start: string; end: string } | null; // HH:mm; avoid, skip and reserve apply only inside it
  startAfter?: string | null; // HH:mm: nothing planned before
  endBy?: string | null; // HH:mm: nothing planned after
  bufferMinutes?: number | null; // kept free after each meeting that ends this day
};

export type PlanInput = {
  tz: string;
  now: number;
  horizonDays?: number;
  weekly: WeeklyHours; // working hours
  overrides?: DateOverride[];
  busy: Interval[]; // meetings and anything else on the calendars that block time
  tasks: PlanTask[];
  links: Pick<TaskLink, "fromTaskId" | "toTaskId" | "kind">[];
  pinned: { taskId: number; start: number; end: number }[];
  rules: DayRule[];
};

export type Block = { taskId: number; start: number; end: number; pinned: boolean };
export type Risk = { taskId: number; reason: "late" | "unplaced"; finishesAt?: number };
export type PlanOutput = { blocks: Block[]; atRisk: Risk[] };

type Free = { day: string; start: number; end: number };

const isOpen = (s: TaskStatus) => s === "open";
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

function at(date: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(":").map(Number);
  if (h === 24) return date.plus({ days: 1 }).startOf("day");
  return date.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

function subtract(list: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const a of list) {
    if (cut.end <= a.start || cut.start >= a.end) out.push(a);
    else {
      if (a.start < cut.start) out.push({ start: a.start, end: cut.start });
      if (cut.end < a.end) out.push({ start: cut.end, end: a.end });
    }
  }
  return out;
}

/** End of a YYYY-MM-DD date in the time zone, as epoch ms. */
export function endOfDay(day: string, tz: string): number {
  return DateTime.fromISO(day, { zone: tz }).endOf("day").toMillis();
}

/** Free working time per day: working hours, from now on, minus busy time and pinned work. */
export function freeTime(input: Pick<PlanInput, "tz" | "now" | "weekly" | "overrides" | "busy" | "pinned" | "horizonDays">): Free[] {
  const { tz, now } = input;
  const start = Math.ceil(now / STEP_MS) * STEP_MS;
  const today = DateTime.fromMillis(now, { zone: tz }).startOf("day");
  const cuts = [...input.busy, ...input.pinned.map((p) => ({ start: p.start, end: p.end }))];
  const out: Free[] = [];
  for (let i = 0; i < (input.horizonDays ?? HORIZON_DAYS); i++) {
    const date = today.plus({ days: i });
    const day = date.toISODate()!;
    const override = input.overrides?.find((o) => o.date === day);
    const ranges = override ? override.ranges : (input.weekly[String(date.weekday)] ?? []);
    let windows: Interval[] = ranges
      .map((r) => ({ start: Math.max(at(date, r.start).toMillis(), start), end: at(date, r.end).toMillis() }))
      .filter((w) => w.end > w.start);
    for (const c of cuts) windows = subtract(windows, c);
    for (const w of windows) if (w.end - w.start >= STEP_MS) out.push({ day, ...w });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Planning order: deadline first (hard before soft on the same day), then priority, then the user's order. */
function compare(a: PlanTask, b: PlanTask): number {
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.hardDeadline !== b.hardDeadline) return a.hardDeadline ? -1 : 1;
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.position - b.position || a.id - b.id;
}

/** Meetings take their buffer with them: busy time ends later on days with a buffer rule. */
function padBusy(input: PlanInput): PlanInput {
  const buffer = new Map<string, number>();
  for (const r of input.rules) if (r.bufferMinutes) buffer.set(r.day, Math.max(buffer.get(r.day) ?? 0, r.bufferMinutes));
  if (!buffer.size) return input;
  const busy = input.busy.map((b) => {
    const pad = buffer.get(DateTime.fromMillis(b.end, { zone: input.tz }).toISODate()!) ?? 0;
    return pad ? { start: b.start, end: b.end + pad * 60_000 } : b;
  });
  return { ...input, busy };
}

/** Drop free time before a day's "start after" and after its "end by". */
function trimDays(free: Free[], rules: DayRule[], tz: string): Free[] {
  let out = free;
  for (const r of rules) {
    if (!r.startAfter && !r.endBy) continue;
    const date = DateTime.fromISO(r.day, { zone: tz });
    const cuts: Interval[] = [];
    if (r.startAfter) cuts.push({ start: date.startOf("day").toMillis(), end: at(date, r.startAfter).toMillis() });
    if (r.endBy) cuts.push({ start: at(date, r.endBy).toMillis(), end: date.endOf("day").toMillis() + 1 });
    out = out.flatMap((f) => {
      if (f.day !== r.day) return [f];
      let pieces: Interval[] = [f];
      for (const c of cuts) pieces = subtract(pieces, c);
      return pieces.filter((p) => p.end - p.start >= STEP_MS).map((p) => ({ day: f.day, ...p }));
    });
  }
  return out;
}

/** Split free windows at the edges of windowed rules, so each piece is wholly inside or outside every window. */
function splitAtWindows(free: Free[], rules: DayRule[], tz: string): Free[] {
  const edges = new Map<string, number[]>();
  for (const r of rules) {
    if (!r.window) continue;
    const date = DateTime.fromISO(r.day, { zone: tz });
    edges.set(r.day, [...(edges.get(r.day) ?? []), at(date, r.window.start).toMillis(), at(date, r.window.end).toMillis()]);
  }
  return free.flatMap((f) => {
    const cuts = (edges.get(f.day) ?? []).filter((e) => e > f.start && e < f.end).sort((a, b) => a - b);
    const out: Free[] = [];
    let s = f.start;
    for (const c of [...cuts, f.end]) {
      if (c > s) out.push({ day: f.day, start: s, end: c });
      s = c;
    }
    return out;
  });
}

export function plan(input: PlanInput): PlanOutput {
  const { tz } = input;
  const tasks = input.tasks.filter((t) => isOpen(t.status) && t.kind === "task");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rules = new Map<string, DayRule[]>();
  for (const r of input.rules) rules.set(r.day, [...(rules.get(r.day) ?? []), r]);
  // A cap in a windowed note is about the window (0 = keep it free), not the whole day.
  const dayCap = (day: string) => {
    const caps = (rules.get(day) ?? []).filter((r) => !r.window).map((r) => r.maxWorkMinutes).filter((m): m is number => m != null);
    return caps.length ? Math.min(...caps) : Infinity;
  };
  const inWindow = (f: Free, r: DayRule) => {
    if (!r.window) return true;
    const date = DateTime.fromMillis(f.start, { zone: tz }).startOf("day");
    return f.start >= at(date, r.window.start).toMillis() && f.end <= at(date, r.window.end).toMillis();
  };
  const reserved = (r: DayRule) => !!(r.reserveForTaskIds?.length || r.reserveForProjectIds?.length || r.reserveForAreaIds?.length);
  const covers = (r: DayRule, task: PlanTask) =>
    !!(r.reserveForTaskIds?.includes(task.id) || (task.projectId != null && r.reserveForProjectIds?.includes(task.projectId)) || (task.categoryId != null && r.reserveForAreaIds?.includes(task.categoryId)));
  // Skips and energy rules always hold; when time is reserved, a task fits if any reservation covers it.
  const allowed = (task: PlanTask, f: Free) => {
    const here = (rules.get(f.day) ?? []).filter((r) => inWindow(f, r));
    if (here.some((r) => (r.window && r.maxWorkMinutes === 0) || r.skipTaskIds?.includes(task.id) || (r.avoidEnergy && task.energy === r.avoidEnergy))) return false;
    const reservations = here.filter(reserved);
    return !reservations.length || reservations.some((r) => covers(r, task));
  };

  const free = splitAtWindows(trimDays(freeTime(padBusy(input)), input.rules, tz), input.rules, tz);
  const usedPerDay = new Map<string, number>(); // planned minutes per day, for maxWorkMinutes
  const blocks: Block[] = input.pinned.filter((p) => p.end > input.now).map((p) => ({ ...p, pinned: true }));
  const finish = new Map<number, number>(); // when each task's last block ends
  for (const b of blocks) finish.set(b.taskId, Math.max(finish.get(b.taskId) ?? 0, b.end));

  // Predecessors that are still open (finished ones no longer hold anything up).
  const preds = new Map<number, number[]>();
  for (const l of input.links) {
    if (l.kind !== "before" || !byId.has(l.fromTaskId) || !byId.has(l.toTaskId)) continue;
    preds.set(l.toTaskId, [...(preds.get(l.toTaskId) ?? []), l.fromTaskId]);
  }

  const atRisk: Risk[] = [];
  const placed = new Set<number>();
  const pending = [...tasks].sort(compare);

  while (pending.length) {
    // The first task in planning order whose predecessors are all planned (or blocked forever by a cycle guard).
    let idx = pending.findIndex((t) => (preds.get(t.id) ?? []).every((p) => placed.has(p)));
    if (idx < 0) idx = 0; // a loop in the links: plan in order rather than stall
    const task = pending.splice(idx, 1)[0];
    placed.add(task.id);

    const pinnedMinutes = blocks.filter((b) => b.taskId === task.id).reduce((m, b) => m + (b.end - b.start) / 60_000, 0);
    let remaining = Math.max(0, (task.estimateMinutes ?? DEFAULT_ESTIMATE) - pinnedMinutes);
    const earliest = Math.max(input.now, ...(preds.get(task.id) ?? []).map((p) => finish.get(p) ?? Infinity));
    if (!Number.isFinite(earliest)) {
      atRisk.push({ taskId: task.id, reason: "unplaced" });
      continue;
    }

    // Take the earliest free window that suits this task, use part of it, and repeat until the task fits.
    for (let guard = 0; remaining > 0 && guard < 500; guard++) {
      let chosen = -1;
      let start = 0;
      let minutes = 0;
      for (let i = 0; i < free.length; i++) {
        const f = free[i];
        if (f.end <= earliest) continue;
        if (!allowed(task, f)) continue;
        const dayRoom = dayCap(f.day) - (usedPerDay.get(f.day) ?? 0);
        const s0 = Math.max(f.start, earliest);
        const room = Math.min((f.end - s0) / 60_000, dayRoom);
        const chunk = Math.min(remaining, room, MAX_CHUNK);
        if (chunk < Math.min(MIN_CHUNK, remaining) || chunk <= 0) continue;
        chosen = i;
        start = s0;
        minutes = chunk >= 5 ? Math.floor(chunk / 5) * 5 : chunk;
        break;
      }
      if (chosen < 0) break;
      const f = free[chosen];
      const end = start + minutes * 60_000;
      blocks.push({ taskId: task.id, start, end, pinned: false });
      remaining -= minutes;
      usedPerDay.set(f.day, (usedPerDay.get(f.day) ?? 0) + minutes);
      finish.set(task.id, Math.max(finish.get(task.id) ?? 0, end));
      // Replace the window with whatever is left of it on either side.
      const rest: Free[] = [];
      if (start > f.start) rest.push({ day: f.day, start: f.start, end: start });
      if (end < f.end) rest.push({ day: f.day, start: end, end: f.end });
      free.splice(chosen, 1, ...rest);
    }

    if (remaining > 0) atRisk.push({ taskId: task.id, reason: "unplaced" });
    else if (task.dueDate && (finish.get(task.id) ?? 0) > endOfDay(task.dueDate, tz)) atRisk.push({ taskId: task.id, reason: "late", finishesAt: finish.get(task.id) });
  }

  // Overdue tasks are late even when they could be planned.
  for (const t of tasks) {
    if (t.dueDate && endOfDay(t.dueDate, tz) < input.now && !atRisk.some((r) => r.taskId === t.id)) atRisk.push({ taskId: t.id, reason: "late", finishesAt: finish.get(t.id) });
  }

  return { blocks: blocks.sort((a, b) => a.start - b.start), atRisk };
}

/** Working minutes still free before a date (end of that day), after the plan's own blocks. */
export function freeMinutesUntil(input: PlanInput, out: PlanOutput, untilDay: string): number {
  const limit = endOfDay(untilDay, input.tz);
  let windows = trimDays(freeTime(padBusy(input)), input.rules, input.tz).filter((f) => f.start < limit).map((f) => ({ start: f.start, end: Math.min(f.end, limit) }));
  for (const b of out.blocks) windows = subtract(windows, b);
  return Math.round(windows.reduce((m, w) => m + (w.end - w.start), 0) / 60_000);
}

/**
 * Times for a meeting of `minutes` that collide with no calendar event. Planned work can move, so it does not
 * block a slot, but each slot lists the tasks whose planned time it would take.
 */
export function meetingSlots(
  input: PlanInput,
  out: PlanOutput,
  opts: { minutes: number; fromDay?: string; toDay?: string; earliest?: string; latest?: string; limit?: number },
): { start: number; end: number; shifts: number[] }[] {
  const { tz } = input;
  const startDay = opts.fromDay ?? DateTime.fromMillis(input.now, { zone: tz }).toISODate()!;
  const endDay = opts.toDay ?? DateTime.fromISO(startDay, { zone: tz }).plus({ days: 7 }).toISODate()!;
  const days = Math.max(1, Math.round(DateTime.fromISO(endDay, { zone: tz }).diff(DateTime.fromISO(startDay, { zone: tz }), "days").days) + 1);
  const windows: Interval[] = [];
  for (let i = 0; i < days; i++) {
    const date = DateTime.fromISO(startDay, { zone: tz }).plus({ days: i });
    const ranges = opts.earliest || opts.latest ? [{ start: opts.earliest ?? "09:00", end: opts.latest ?? "17:00" }] : (input.weekly[String(date.weekday)] ?? []);
    for (const r of ranges) windows.push({ start: Math.max(at(date, r.start).toMillis(), Math.ceil(input.now / (15 * 60_000)) * 15 * 60_000), end: at(date, r.end).toMillis() });
  }
  let free = windows.filter((w) => w.end > w.start);
  for (const b of input.busy) free = subtract(free, b);
  const len = opts.minutes * 60_000;
  const candidates: { start: number; end: number; shifts: number[] }[] = [];
  for (const w of free) {
    for (let s = w.start; s + len <= w.end; s += 30 * 60_000) {
      const e = s + len;
      const shifts = [...new Set(out.blocks.filter((b) => !b.pinned && b.start < e && b.end > s).map((b) => b.taskId))];
      candidates.push({ start: s, end: e, shifts });
    }
  }
  // Prefer times that move no planned work, keep picks at least an hour apart, then list them in time order.
  candidates.sort((a, b) => Number(a.shifts.length > 0) - Number(b.shifts.length > 0) || a.start - b.start);
  const picked: typeof candidates = [];
  for (const c of candidates) {
    if (picked.length >= (opts.limit ?? 6)) break;
    if (picked.some((p) => Math.abs(p.start - c.start) < 60 * 60_000)) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.start - b.start);
}

/** Next due date for a repeating task, from its last due date (or today when it had none). See tasks/repeat.ts. */
export function nextDue(repeat: string, fromDay: string, tz: string, doneThisWeek = 0): string {
  return nextDueFor(repeat, fromDay, tz, doneThisWeek);
}

/**
 * What changed between two plans, in words, for tasks whose first block moved by more than half an hour.
 * `reason` names what caused it ("a new event", "your note for today").
 */
export function describeMoves(before: Block[], after: Block[], titles: Map<number, string>, tz: string): string[] {
  const first = (list: Block[]) => {
    const m = new Map<number, number>();
    for (const b of list) if (!m.has(b.taskId) || b.start < m.get(b.taskId)!) m.set(b.taskId, b.start);
    return m;
  };
  const a = first(before);
  const b = first(after);
  const out: string[] = [];
  for (const [id, was] of a) {
    const now = b.get(id);
    if (now === undefined || Math.abs(now - was) <= 30 * 60_000 || !titles.has(id)) continue;
    const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: tz }).toFormat("ccc h:mm a");
    out.push(`Moved "${titles.get(id)}" from ${fmt(was)} to ${fmt(now)}`);
  }
  return out.slice(0, 10);
}
