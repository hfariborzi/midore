/**
 * Planned against done, from the blocks kept after they pass (pinned history). Answers "am I keeping my
 * Wednesday writing mornings?": each passed block counts as done, partly done, done later, missed or dropped,
 * from what the user marked on it, when the task was finished, or a rise in its progress. Pure; unit tested.
 */
import { DateTime } from "luxon";

export type HistBlock = { taskId: number; start: number; end: number; outcome: string | null; progress: number | null };
export type HistTask = { id: number; title: string; status: string; completedAt: number | null; projectId: number | null; categoryId: number | null };
export type BlockResult = "done" | "partly" | "done_later" | "missed" | "dropped";
export type HistoryQuery = {
  tz: string;
  now: number;
  weeks: number;
  weekday?: number; // 1 = Monday … 7 = Sunday
  from?: string; // HH:mm, only planned time after this
  to?: string; // HH:mm, only planned time before this
  projectIds?: number[];
  areaIds?: number[];
};
export type HistoryDay = {
  day: string;
  weekday: string;
  planned: number; // minutes
  done: number;
  partly: number;
  doneLater: number;
  missed: number;
  dropped: number;
  blocks: { task: string; time: string; result: BlockResult }[];
};
export type History = { since: string | null; days: HistoryDay[]; total: Omit<HistoryDay, "day" | "weekday" | "blocks"> };

const localDay = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toISODate()!;

/** How one passed block went. `prevProgress` is the task's progress kept with its previous block. */
export function blockResult(b: HistBlock, task: HistTask | undefined, prevProgress: number | null, tz: string): BlockResult {
  if (b.outcome === "done" || b.outcome === "good_enough") return "done";
  if (b.outcome === "partly") return "partly";
  if (b.outcome === "not_done") return "missed";
  if (!task) return "missed";
  const day = localDay(b.start, tz);
  const finished = (task.status === "done" || task.status === "good_enough") && task.completedAt != null;
  // Finished that day, or before the block came round (a block kept for a task finished early).
  if (finished && localDay(task.completedAt!, tz) <= day) return "done";
  if (b.progress != null && b.progress > (prevProgress ?? 0) && b.progress < 100) return "partly";
  if (finished) return "done_later";
  if (task.status === "dropped") return "dropped";
  return "missed";
}

function clip(b: HistBlock, q: HistoryQuery): [number, number] | null {
  let s = b.start;
  let e = b.end;
  const day = DateTime.fromMillis(b.start, { zone: q.tz }).startOf("day");
  const at = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return day.set({ hour: h, minute: m }).toMillis();
  };
  if (q.from) s = Math.max(s, at(q.from));
  if (q.to) e = Math.min(e, at(q.to));
  return e > s ? [s, e] : null;
}

const hm = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat("HH:mm");

export function planHistory(blocks: HistBlock[], tasks: HistTask[], q: HistoryQuery): History {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const passed = blocks.filter((b) => b.end <= q.now).sort((a, b) => a.start - b.start);
  const since = passed.length ? localDay(passed[0].start, q.tz) : null;
  const today = DateTime.fromMillis(q.now, { zone: q.tz }).startOf("day");
  const first = today.minus({ days: q.weeks * 7 }).toISODate()!;

  // Results need every block of a task in order (for the progress before it), so work them out before filtering.
  const lastProgress = new Map<number, number | null>();
  const results = new Map<HistBlock, BlockResult>();
  for (const b of passed) {
    results.set(b, blockResult(b, byId.get(b.taskId), lastProgress.get(b.taskId) ?? null, q.tz));
    if (b.progress != null) lastProgress.set(b.taskId, b.progress);
  }

  const days = new Map<string, HistoryDay>();
  const dayEntry = (d: DateTime): HistoryDay => {
    const key = d.toISODate()!;
    let e = days.get(key);
    if (!e) days.set(key, (e = { day: key, weekday: d.toFormat("cccc"), planned: 0, done: 0, partly: 0, doneLater: 0, missed: 0, dropped: 0, blocks: [] }));
    return e;
  };
  // Every matching day since history began counts, even with nothing planned: that is an answer too.
  if (since) {
    for (let d = today.minus({ days: 1 }); d.toISODate()! >= first && d.toISODate()! >= since; d = d.minus({ days: 1 })) {
      if (!q.weekday || d.weekday === q.weekday) dayEntry(d);
    }
  }
  const key: Record<BlockResult, "done" | "partly" | "doneLater" | "missed" | "dropped"> = { done: "done", partly: "partly", done_later: "doneLater", missed: "missed", dropped: "dropped" };
  for (const b of passed) {
    const d = DateTime.fromMillis(b.start, { zone: q.tz });
    if (d.toISODate()! < first || d >= today) continue;
    if (q.weekday && d.weekday !== q.weekday) continue;
    const task = byId.get(b.taskId);
    if (q.projectIds?.length && !(task?.projectId != null && q.projectIds.includes(task.projectId))) continue;
    if (q.areaIds?.length && !(task?.categoryId != null && q.areaIds.includes(task.categoryId))) continue;
    const span = clip(b, q);
    if (!span) continue;
    const minutes = Math.round((span[1] - span[0]) / 60_000);
    const result = results.get(b)!;
    const e = dayEntry(d);
    e.planned += minutes;
    e[key[result]] += minutes;
    e.blocks.push({ task: task?.title ?? "(deleted task)", time: `${hm(span[0], q.tz)}–${hm(span[1], q.tz)}`, result });
  }
  const list = [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
  const total = { planned: 0, done: 0, partly: 0, doneLater: 0, missed: 0, dropped: 0 };
  for (const d of list) for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += d[k];
  return { since, days: list, total };
}
