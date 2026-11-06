"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { DateTime } from "luxon";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ExternalLink, ListFilter, Loader2, MapPin, Pin, PinOff, Plus, Sparkles, Trash2, Users, Video, X } from "lucide-react";
import Link from "next/link";
import type { CalendarPrefs, Category, EventLocationKind, LabelSource, Priority, TaskStatus } from "@/db/schema";
import type { CalendarEvent } from "@/lib/calendar/types";
import { eventKey, LOCATION_KIND_LABEL, LOCATION_KINDS, PRIORITIES, PRIORITY_COLOR, PRIORITY_LABEL } from "@/lib/labels/core";
import { meetingLinkLabel } from "@/lib/locations";
import { labelEvent, saveCalendarPrefs } from "./actions";
import { markBlock, moveBlock, pinBlock, skipTaskOn, unpinTask, type BlockState } from "./dori-actions";
import { GRAPHITE, toPalette } from "@/lib/palette";
import { ProviderButton } from "@/components/ProviderButton";
import board from "./board.module.css";
import { DORI_CHANGED, TASKS_CHANGED } from "./DoriPanel";
import { CALENDAR_CONTROLS_ID } from "./TopBar";

/** Planned work from the planner, shown on the calendar next to real events. */
type PlannedBlock = {
  taskId: number;
  start: string;
  end: string;
  pinned: boolean;
  title: string;
  categoryId: number | null;
  priority: Priority;
  dueDate: string | null;
  risk: "late" | "unplaced" | null;
  status: TaskStatus;
  progress: number;
  past: boolean;
};

/** How a planned block shows: still to do, passed without being done, partly done, good enough, or done. */
type TaskState = "open" | "missed" | "partly" | "good_enough" | "done";
function blockState(b: PlannedBlock): TaskState {
  if (b.status === "done") return "done";
  if (b.status === "good_enough") return "good_enough";
  if (b.progress > 0) return "partly";
  return b.past ? "missed" : "open";
}
const PLAN_CAL = "doorcal-plan";

type Problem = { accountId: number; provider: "google" | "microsoft"; email: string; message: string; reconnect: boolean };
type Label = { categoryId: number | null; priority: Priority; source: LabelSource | null; location: EventLocationKind };
type Labels = Record<string, Label>;

const OTHER_COLOR = GRAPHITE;
const DEFAULT_PREFS: CalendarPrefs = { colorBy: "kind", v: 2, hidden: { categories: [], other: false, locations: [], priorities: [] } };

const labelKey = (e: CalendarEvent) => `${e.accountId}:${eventKey(e)}`;

function isHidden(label: Label | undefined, prefs: CalendarPrefs) {
  if (!label) return false;
  const h = prefs.hidden;
  if (label.categoryId === null ? h.other : h.categories.includes(label.categoryId)) return true;
  if (h.locations.includes(label.location) || h.priorities.includes(label.priority)) return true;
  return false;
}

const HOUR_PX = 60;
// A tab left in the background this long comes back on today and the current time.
const RESET_AFTER_HIDDEN_MS = 15 * 60_000;

/** Phones get a month with coloured dots and the chosen day as a list; wider screens get the week grid. */
type View = "week" | "day" | "month";

function layoutDay(events: CalendarEvent[], dayStart: DateTime) {
  const dayEnd = dayStart.plus({ days: 1 });
  const items = events
    .map((e) => {
      const s = DateTime.max(DateTime.fromISO(e.start), dayStart);
      const en = DateTime.min(DateTime.fromISO(e.end), dayEnd);
      return { e, s: s.toMillis(), en: Math.max(en.toMillis(), s.toMillis() + 15 * 60_000) };
    })
    .sort((a, b) => a.s - b.s || b.en - a.en);

  const placed: { e: CalendarEvent; s: number; en: number; lane: number; lanes: number }[] = [];
  let cluster: typeof placed = [];
  let clusterEnd = 0;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    cluster.forEach((c) => (c.lanes = lanes));
    cluster = [];
  };
  for (const it of items) {
    if (it.s >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.en > it.s).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    const p = { ...it, lane, lanes: 1 };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, it.en);
  }
  flush();
  return placed.map((p) => ({
    ...p,
    top: ((p.s - dayStart.toMillis()) / 3_600_000) * HOUR_PX,
    height: Math.max(((p.en - p.s) / 3_600_000) * HOUR_PX, 18),
  }));
}

/** Printed events in a colour: a light wash of the ink with a solid printed edge. */
function eventStyle(color: string): React.CSSProperties {
  return {
    background: `color-mix(in srgb, ${color} var(--event-wash), var(--board))`,
    borderLeft: `3px solid ${color}`,
    color: "var(--ink)",
  };
}

/** Magnet faces in light colours (amber, ochre, moss, coral) carry dark text; the rest carry white. */
function magnetText(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.22 ? "#1b1b1e" : "#ffffff";
}

function stripHtml(html: string) {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

const noopSubscribe = () => () => {};
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const isNarrow = () => window.innerWidth < 768;

export function CalendarView() {
  const tz = useSyncExternalStore(noopSubscribe, browserTz, () => "UTC");
  const narrow = useSyncExternalStore(noopSubscribe, isNarrow, () => false);
  const [viewChoice, setView] = useState<View | null>(null);
  const view: View = viewChoice ?? (narrow ? "month" : "week");
  const views: View[] = narrow ? ["month", "day"] : ["week", "day"];
  const [anchor, setAnchor] = useState<DateTime>(() => DateTime.now().startOf("day"));
  const [result, setResult] = useState<{ rangeKey: string; events: CalendarEvent[]; problems: Problem[]; labels: Labels; categories: Category[]; booked?: string[]; error?: string } | null>(null);
  const [prefs, setPrefs] = useState<CalendarPrefs | null>(null); // null until the first load brings the saved ones
  const [aiRetry, setAiRetry] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const [planned, setPlanned] = useState<{ rangeKey: string; blocks: PlannedBlock[] } | null>(null);
  const [showPlan, setShowPlan] = useState(true);
  const [selectedBlock, setSelectedBlock] = useState<PlannedBlock | null>(null);
  const [creating, setCreating] = useState<DateTime | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "no"; key: number } | null>(null);
  const [dropped, setDropped] = useState<string | null>(null);
  const grabbed = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const noteSeq = useRef(0);
  // The day/week controls render in the top bar.
  const controlsSlot = useSyncExternalStore(noopSubscribe, () => document.getElementById(CALENDAR_CONTROLS_ID), () => null);
  const [, setClock] = useState(0); // re-renders each minute so "now" stays current
  const scroller = useRef<HTMLDivElement>(null);

  /** Scroll the time grid so the current time sits near the top, with a little of the past above it. */
  function scrollToNow() {
    const n = DateTime.now().setZone(tz);
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (n.hour + n.minute / 60 - 1.5) * HOUR_PX);
  }
  function goToNow() {
    setAnchor(DateTime.now().setZone(tz).startOf("day"));
    scrollToNow();
  }

  const range = useMemo(() => {
    const a = anchor.setZone(tz, { keepLocalTime: true }).startOf("day");
    const first = a.startOf("month");
    // Sunday-first weeks; a month shows the six weeks around it.
    const start = view === "week" ? a.minus({ days: a.weekday % 7 }) : view === "month" ? first.minus({ days: first.weekday % 7 }) : a;
    const days = view === "week" ? 7 : view === "month" ? 42 : 1;
    return {
      key: `${start.toISO()}|${days}`,
      start,
      end: start.plus({ days }),
      days: Array.from({ length: days }, (_, i) => start.plus({ days: i })),
    };
  }, [anchor, view, tz]);

  const events = result?.rangeKey === range.key ? result.events : null;
  const error = result?.rangeKey === range.key ? (result.error ?? null) : null;
  const problems = result?.rangeKey === range.key ? result.problems : [];
  const labels: Labels = result?.labels ?? {};
  const categories: Category[] = result?.categories ?? [];
  const view_prefs = prefs ?? DEFAULT_PREFS;
  const load = () => setReloadTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ start: range.start.toUTC().toISO()!, end: range.end.toUTC().toISO()! });
    fetch(`/api/calendar/events?${q}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load your calendar");
        if (cancelled) return;
        setResult({ rangeKey: range.key, events: data.events, problems: data.problems ?? [], labels: data.labels ?? {}, categories: data.categories ?? [], booked: data.booked ?? [] });
        setPrefs((p) => p ?? data.prefs ?? DEFAULT_PREFS);
        // The AI labels events after the response; fetch once more to pick its answers up.
        if (data.pendingAi > 0 && aiRetry === 0) setTimeout(() => setAiRetry(1), 4000);
      })
      .catch((e) => !cancelled && setResult({ rangeKey: range.key, events: [], problems: [], labels: {}, categories: [], error: (e as Error).message }));
    return () => {
      cancelled = true;
    };
  }, [range, reloadTick, aiRetry]);

  // Planned work for the same range; reloads with the calendar and whenever Dori changes something.
  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ start: range.start.toUTC().toISO()!, end: range.end.toUTC().toISO()! });
    fetch(`/api/plan?${q}`)
      .then((r) => (r.ok ? r.json() : { blocks: [] }))
      .then((d: { blocks?: PlannedBlock[] }) => !cancelled && setPlanned({ rangeKey: range.key, blocks: d.blocks ?? [] }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [range, reloadTick]);

  useEffect(() => {
    const onChange = () => setReloadTick((t) => t + 1);
    window.addEventListener(DORI_CHANGED, onChange);
    return () => window.removeEventListener(DORI_CHANGED, onChange);
  }, []);

  function updatePrefs(next: CalendarPrefs) {
    setPrefs(next);
    void saveCalendarPrefs(next);
  }
  function toggleHidden<K extends keyof CalendarPrefs["hidden"]>(key: K, value: CalendarPrefs["hidden"][K] extends (infer T)[] ? T : boolean) {
    const h = { ...view_prefs.hidden };
    if (key === "other") h.other = !h.other;
    else {
      const list = h[key] as unknown[];
      h[key] = (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]) as never;
    }
    updatePrefs({ ...view_prefs, hidden: h });
  }

  // Board notes fade after a few seconds.
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(t);
  }, [note]);

  // Open on the current time, and keep it there when switching between day and week.
  useEffect(scrollToNow, [view, tz]);

  // Keep the "now" line moving, and bring a tab that sat in the background back to today and now.
  useEffect(() => {
    const timer = setInterval(() => setClock((c) => c + 1), 60_000);
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      setClock((c) => c + 1);
      if (hiddenAt && Date.now() - hiddenAt > RESET_AFTER_HIDDEN_MS) {
        goToNow();
        setReloadTick((t) => t + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tz]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = (events ?? []).filter((e) => !isHidden(labels[labelKey(e)], view_prefs));
  const blocks = planned?.rangeKey === range.key ? planned.blocks : [];
  // Colour: in Midore's scheme events and tasks take their category's shade, so work on a project and its
  // meetings match. "Type" from older saved prefs means the same thing now.
  const mode = view_prefs.colorBy === "type" ? "kind" : view_prefs.colorBy;
  const catColor = (id: number | null | undefined) => {
    const c = categories.find((x) => x.id === id);
    return c ? toPalette(c.color) : null;
  };
  function taskInk(b: PlannedBlock) {
    return mode === "priority" ? PRIORITY_COLOR[b.priority] : (catColor(b.categoryId) ?? "#e11d48");
  }
  const eventInk = (e: CalendarEvent): string | null => {
    const label = labels[labelKey(e)];
    if (mode === "calendar") return toPalette(e.color);
    if (mode === "priority") return PRIORITY_COLOR[label?.priority ?? "normal"];
    return catColor(label?.categoryId);
  };
  const blockEvents: CalendarEvent[] = showPlan
    ? blocks.map((b) => ({ id: `${b.taskId}-${b.start}`, accountId: -1, calendarId: PLAN_CAL, title: b.title, start: b.start, end: b.end, allDay: false, color: taskInk(b), attendees: [], canEdit: false }))
    : [];
  const blockFor = (e: CalendarEvent) => blocks.find((b) => `${b.taskId}-${b.start}` === e.id) ?? null;
  const timed = [...shown.filter((e) => !e.allDay), ...blockEvents];
  const allDay = shown.filter((e) => e.allDay);
  const hiddenCount = (events?.length ?? 0) - shown.length;
  const booked = new Set(result?.booked ?? []);
  const isBooked = (e: CalendarEvent) => booked.has(`${e.accountId}:${e.id}`);
  const byKind = mode === "kind";
  /** The small label at the top of a block in Midore's scheme. */
  const eyebrow = (e: CalendarEvent): { text: string; className: string } | null => {
    if (e.calendarId === PLAN_CAL) return null;
    if (!byKind) return null;
    if (isBooked(e)) return { text: "Booked", className: "text-accent-soft" };
    const where = e.meetLink ? meetingLinkLabel(e.meetLink) : e.calendarName;
    return where ? { text: where, className: "text-faint" } : null;
  };
  /** Tasks carry their colour as an underline and a wash; events as a printed left edge. */
  const styleFor = (e: CalendarEvent): React.CSSProperties => {
    if (e.calendarId === PLAN_CAL) {
      const b = blockFor(e);
      return { "--c": e.color, "--text": magnetText(e.color), "--p": `${b?.progress ?? 0}%` } as React.CSSProperties;
    }
    const low = labels[labelKey(e)]?.priority === "low" ? 0.7 : 1;
    const ink = eventInk(e);
    return ink ? { ...eventStyle(ink), opacity: low } : { opacity: low };
  };
  const now = DateTime.now().setZone(tz);

  // Dragging a magnet: it follows the pointer, then snaps to the nearest quarter hour on the day it was dropped on.
  // Meetings are printed on the board, so a drop that would cover one is refused and the magnet springs back.
  function grab(ev: React.PointerEvent<HTMLButtonElement>, b: PlannedBlock) {
    if (ev.button !== 0 || !b) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    grabbed.current = { x: ev.clientX, y: ev.clientY, moved: false };
  }
  function moveGrab(ev: React.PointerEvent<HTMLButtonElement>) {
    const g = grabbed.current;
    if (!g) return;
    const dx = ev.clientX - g.x;
    const dy = ev.clientY - g.y;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    g.moved = true;
    ev.currentTarget.dataset.lifted = "";
    ev.currentTarget.style.transition = "none";
    ev.currentTarget.style.transform = `translate(${dx}px, ${dy}px) rotate(-1.5deg)`;
  }
  function drop(ev: React.PointerEvent<HTMLButtonElement>, b: PlannedBlock) {
    const g = grabbed.current;
    grabbed.current = null;
    const el = ev.currentTarget;
    delete el.dataset.lifted;
    el.style.transition = "";
    el.style.transform = "";
    if (!g?.moved) return;
    suppressClick.current = true;
    const colW = (el.parentElement?.getBoundingClientRect().width ?? 1) || 1;
    const days = Math.round((ev.clientX - g.x) / colW);
    const minutes = Math.round((ev.clientY - g.y) / (HOUR_PX / 4)) * 15;
    if (days === 0 && minutes === 0) return;
    const s = DateTime.fromISO(b.start).setZone(tz).plus({ days, minutes });
    const e = DateTime.fromISO(b.end).setZone(tz).plus({ days, minutes });
    const refuse = (text: string) => {
      el.dataset.refused = "";
      setTimeout(() => delete el.dataset.refused, 400);
      setNote({ text, tone: "no", key: ++noteSeq.current });
    };
    if (s < range.start || e > range.end) return refuse("Keep it on this week's board.");
    if (!s.hasSame(e.minus({ milliseconds: 1 }), "day")) return refuse("It has to fit inside one day.");
    const clash = shown.find((x) => !x.allDay && DateTime.fromISO(x.start) < e && DateTime.fromISO(x.end) > s);
    if (clash) return refuse(`${clash.title} is there. Meetings stay put.`);
    setPlanned((p) => (p ? { ...p, blocks: p.blocks.map((x) => (x === b ? { ...x, start: s.toISO()!, end: e.toISO()!, pinned: true } : x)) } : p));
    setDropped(`${b.taskId}-${s.toISO()}`);
    setNote({ text: `${b.title}: ${s.toFormat("ccc h:mm a")}, pinned`, tone: "ok", key: ++noteSeq.current });
    void moveBlock(b.taskId, b.start, s.toISO()!, e.toISO()!).then((r) => {
      if (r.error) setNote({ text: r.error, tone: "no", key: ++noteSeq.current });
      load();
    });
  }

  // Display controls live in a strip along the top of the board, where they double as the colour legend.
  // Location and priority filters, used less, sit behind "More".
  const moreHidden = view_prefs.hidden.locations.length + view_prefs.hidden.priorities.length;
  const strip = (
    <div className={board.strip} role="toolbar" aria-label="Colour and filters">
      <div className={board.seg} role="radiogroup" aria-label="Colour by">
        {(["kind", "calendar", "priority"] as const).map((m) => (
          <button key={m} role="radio" aria-checked={mode === m} onClick={() => updatePrefs({ ...view_prefs, colorBy: m })} data-on={mode === m || undefined}>
            {m === "kind" ? "Category" : m === "calendar" ? "Calendar" : "Priority"}
          </button>
        ))}
      </div>
      <span className={board.rule} aria-hidden />
      {categories.map((c) => (
        <Chip key={c.id} color={mode === "kind" ? toPalette(c.color) : undefined} label={c.name} off={view_prefs.hidden.categories.includes(c.id)} onClick={() => toggleHidden("categories", c.id)} />
      ))}
      <Chip color={mode === "kind" ? OTHER_COLOR : undefined} label="Other" off={view_prefs.hidden.other} onClick={() => toggleHidden("other", true)} />
      <span className={board.rule} aria-hidden />
      <Chip label="Planned work" off={!showPlan} onClick={() => setShowPlan(!showPlan)} />
      <div className="relative">
        <button className={`${board.more} ${filtersOpen || moreHidden ? "text-ink" : ""}`} onClick={() => setFiltersOpen(!filtersOpen)} aria-expanded={filtersOpen}>
          <ListFilter size={14} /> More{moreHidden > 0 && <span className="tnum"> ({moreHidden})</span>}
        </button>
        {filtersOpen && (
          <div className="absolute right-0 z-50 mt-2 w-64 space-y-4 rounded-lg border border-line bg-modal p-4 text-xs shadow-(--shadow-modal)">
            <div>
              <p className="mb-1.5 text-faint">Location</p>
              <div className="flex flex-wrap gap-1.5">
                {LOCATION_KINDS.map((k) => (
                  <Chip key={k} label={LOCATION_KIND_LABEL[k]} off={view_prefs.hidden.locations.includes(k)} onClick={() => toggleHidden("locations", k)} icon={k === "video" ? <Video size={11} /> : k === "in_person" ? <MapPin size={11} /> : undefined} />
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-faint">Priority</p>
              <div className="flex flex-wrap gap-1.5">
                {PRIORITIES.map((pr) => (
                  <Chip key={pr} color={PRIORITY_COLOR[pr]} label={PRIORITY_LABEL[pr]} off={view_prefs.hidden.priorities.includes(pr)} onClick={() => toggleHidden("priorities", pr)} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      {hiddenCount > 0 && <span className="ml-auto shrink-0 pr-1 text-xs text-faint">{hiddenCount} hidden</span>}
    </div>
  );

  /** Phone calendar: the month with a dot per colour on each day, and the chosen day's events and work below. */
  function monthView() {
    const sel = anchor.setZone(tz, { keepLocalTime: true }).startOf("day");
    const month = sel.startOf("month");
    const items = [...shown, ...blockEvents];
    const onDay = (d: DateTime) => {
      const s = d.toMillis();
      const e = d.plus({ days: 1 }).toMillis();
      return items
        .filter((x) => DateTime.fromISO(x.start, { zone: tz }).toMillis() < e && DateTime.fromISO(x.end, { zone: tz }).toMillis() > s)
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
    };
    const ink = (x: CalendarEvent) => (x.calendarId === PLAN_CAL ? x.color : (eventInk(x) ?? OTHER_COLOR));
    // Drop the sixth week when the month ends before it.
    const days = range.days.filter((d, i) => i < 35 || d.hasSame(month, "month"));
    const list = onDay(sel);
    const nowMs = now.toMillis();
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-7 px-2 pt-2 pb-3">
          {range.days.slice(0, 7).map((d) => (
            <div key={d.weekday} className={`${board.dayName} pb-1 text-center`} data-weekend={d.weekday > 5 || undefined}>
              {d.toFormat("ccccc")}
            </div>
          ))}
          {days.map((d) => {
            const isSel = d.hasSame(sel, "day");
            const isToday = d.hasSame(now, "day");
            const dots = [...new Set(onDay(d).map(ink))].slice(0, 4);
            return (
              <button
                key={d.toISODate()}
                onClick={() => setAnchor(d)}
                aria-label={d.toFormat("cccc, LLLL d")}
                aria-current={isSel ? "date" : undefined}
                className={`flex h-12 flex-col items-center gap-1 pt-1 ${d.hasSame(month, "month") ? "" : "opacity-40"}`}
              >
                <span
                  className={`grid h-7 w-7 place-items-center rounded-full text-sm tnum transition-colors ${
                    isSel ? (isToday ? "bg-vermilion font-semibold text-white" : "bg-ink font-semibold text-board") : isToday ? "font-semibold text-vermilion ring-[1.5px] ring-vermilion" : "text-ink"
                  }`}
                >
                  {d.day}
                </span>
                <span className="flex h-1.5 gap-[3px]" aria-hidden>
                  {dots.map((c) => (
                    <span key={c} className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>

        <div className="border-t border-line px-3 pt-3 pb-24">
          <h3 className="px-1 pb-2 text-sm font-semibold text-ink">
            {sel.hasSame(now, "day") ? `Today · ${sel.toFormat("cccc, LLLL d")}` : sel.toFormat("cccc, LLLL d")}
          </h3>
          {events === null ? (
            <p className="flex items-center gap-2 px-1 py-6 text-sm text-muted"><Loader2 size={16} className="animate-spin" /> Loading your calendar…</p>
          ) : list.length === 0 ? (
            <p className="px-1 py-6 text-sm text-faint">{sel.hasSame(now, "day") ? "Nothing on today. Time is yours." : "Nothing on this day."}</p>
          ) : (
            <ul className="space-y-1">
              {list.map((x) => {
                const isPlan = x.calendarId === PLAN_CAL;
                const blk = isPlan ? blockFor(x) : null;
                const state = blk ? blockState(blk) : null;
                const c = ink(x);
                const s = DateTime.fromISO(x.start).setZone(tz);
                const e = DateTime.fromISO(x.end).setZone(tz);
                const live = !x.allDay && s.toMillis() <= nowMs && e.toMillis() > nowMs;
                const doneish = state === "done" || state === "good_enough";
                return (
                  <li key={`${x.accountId}-${x.calendarId}-${x.id}`}>
                    <button
                      onClick={() => (isPlan ? setSelectedBlock(blk) : setSelected(x))}
                      className="grid w-full grid-cols-[4.25rem_1fr] items-center gap-3 rounded-lg px-1 py-2 text-left active:bg-hover"
                      style={live ? { background: `color-mix(in srgb, ${c} 12%, transparent)` } : undefined}
                    >
                      <span className="text-xs leading-tight text-muted tnum">
                        {x.allDay ? "All day" : s.toFormat("h:mm a")}
                        {!x.allDay && <span className="block text-faint">{e.toFormat("h:mm a")}</span>}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={`block truncate text-[0.9375rem] ${isPlan ? "" : "font-medium"} ${doneish ? "text-faint line-through" : state === "missed" ? "text-muted" : "text-ink"}`}
                          style={
                            isPlan
                              ? { textDecorationLine: doneish ? "line-through" : "underline", textDecorationColor: c, textDecorationThickness: 2, textUnderlineOffset: 4 }
                              : { boxShadow: `inset 3px 0 0 ${c}`, paddingLeft: 10 }
                          }
                        >
                          {x.title}
                        </span>
                        {(live || (state && state !== "open") || blk?.risk) && (
                          <span className={`mt-0.5 block text-xs ${isPlan ? "" : "pl-[10px]"} ${live ? "font-semibold text-vermilion" : "text-faint"}`}>
                            {live
                              ? "Now"
                              : state === "done"
                                ? "Done"
                                : state === "good_enough"
                                  ? "Good enough"
                                  : state === "partly"
                                    ? `${blk!.progress}% done`
                                    : state === "missed"
                                      ? "Not done"
                                      : blk?.risk === "late"
                                        ? "Might be late"
                                        : "No room before it's due"}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const last = range.end.minus({ days: 1 });
  const step = view === "week" ? { weeks: 1 } : view === "month" ? { months: 1 } : { days: 1 };
  const title =
    view === "month"
      ? anchor.toFormat("LLLL yyyy")
      : view === "week"
      ? range.start.hasSame(last, "month")
        ? `${range.start.toFormat("LLL d")} – ${last.toFormat("d, yyyy")}`
        : `${range.start.toFormat("LLL d")} – ${last.toFormat("LLL d, yyyy")}`
      : range.start.toFormat("cccc, LLL d, yyyy");
  // Phone widths: "Oct" (with the year only for other years), "Oct 11–17", "Oct 14".
  const shortTitle =
    view === "month"
      ? anchor.toFormat(anchor.hasSame(DateTime.now(), "year") ? "LLL" : "LLL yyyy")
      : view === "week"
        ? `${range.start.toFormat("LLL d")}–${last.toFormat(range.start.hasSame(last, "month") ? "d" : "LLL d")}`
        : range.start.toFormat("LLL d");

  return (
    <div className="flex h-full flex-col">
      {controlsSlot &&
        createPortal(
          <div className="flex w-full min-w-0 items-center gap-1.5">
            <button className="btn-secondary px-3 py-1" onClick={goToNow}>
              Today
            </button>
            <button className="btn-ghost px-1.5 py-1" aria-label="Previous" onClick={() => setAnchor(anchor.minus(step))}><ChevronLeft size={18} /></button>
            <button className="btn-ghost px-1.5 py-1" aria-label="Next" onClick={() => setAnchor(anchor.plus(step))}><ChevronRight size={18} /></button>
            <h2 className="ml-1 min-w-0 truncate text-base font-semibold tracking-[-0.015em] text-ink sm:text-lg">
              <span className="sm:hidden">{shortTitle}</span>
              <span className="hidden sm:inline">{title}</span>
            </h2>
            <div className="ml-auto flex items-center gap-1.5 md:ml-3">
              <div className="flex rounded-md border border-line bg-canvas p-0.5 text-sm">
                {views.map((v) => (
                  <button key={v} onClick={() => setView(v)} className={`rounded px-2.5 py-0.5 capitalize ${view === v ? "bg-surface font-medium text-ink shadow-(--shadow-card)" : "text-muted hover:text-ink"}`}>
                    {v}
                  </button>
                ))}
              </div>
              <button className="btn-primary px-2.5 py-1" onClick={() => setCreating(now.plus({ hours: 1 }).startOf("hour"))} title="New meeting">
                <Plus size={16} /> <span className="hidden xl:inline">New</span>
              </button>
            </div>
          </div>,
          controlsSlot,
        )}
      <div className={`${board.board} relative flex min-h-0 flex-1 flex-col`}>
        {error && <p className="m-4 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        {problems.length > 0 && (
          <div className="m-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-ink">
            <p className="min-w-0 flex-1">
              {problems.map((p) => `${p.email} ${p.message}`).join(". ")}.{" "}
              {problems.some((p) => p.reconnect) && <span className="text-muted">Its events are hidden until then. Allow all calendar permissions on the consent screen.</span>}
            </p>
            {problems
              .filter((p) => p.reconnect)
              .map((p) => (
                <ProviderButton key={p.accountId} provider={p.provider} reconnect={p.accountId} label={`Reconnect ${p.email}`} compact />
              ))}
          </div>
        )}

        {strip}
        {view === "month" ? monthView() : (<>
        <div className={`${board.head} pt-2 pb-1.5`}>
          <div className="w-11 shrink-0 sm:w-14" />
          {range.days.map((d) => {
            const isToday = d.hasSame(now, "day");
            const weekend = d.weekday > 5;
            return (
              <div key={d.toISODate()} className={`${board.dayCell} min-w-0 flex-1 ${view === "week" ? "px-1 sm:px-2" : "px-2"}`} data-today={isToday || undefined}>
                {/* A phone-width week has no room for "Mon 12" on one line: stack the name over the date. */}
                <div className={view === "week" ? "flex flex-col leading-tight sm:flex-row sm:items-baseline sm:gap-1.5" : "flex items-baseline gap-1.5"} aria-label={isToday ? `Today, ${d.toFormat("cccc d")}` : d.toFormat("cccc d")}>
                  <span className={board.dayName} data-today={isToday || undefined} data-weekend={(weekend && !isToday) || undefined}>
                    {d.toFormat("ccc")}
                  </span>
                  <span className={board.date} data-today={isToday || undefined} data-past={(!isToday && d < now.startOf("day")) || undefined}>
                    {d.day}
                  </span>
                </div>
                <div className="mt-1 space-y-0.5">
                  {allDay
                    .filter((e) => {
                      const s = DateTime.fromISO(e.start, { zone: tz });
                      const en = DateTime.fromISO(e.end, { zone: tz });
                      return s <= d && en > d;
                    })
                    .map((e) => (
                      <button key={`${e.accountId}-${e.calendarId}-${e.id}`} onClick={() => setSelected(e)} className={`${board.allDay} block w-full truncate text-left text-xs`} style={styleFor(e)}>
                        {e.title}
                      </button>
                    ))}
                </div>
              </div>
            );
          })}
        </div>

        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="relative flex" style={{ height: 24 * HOUR_PX, "--hour": `${HOUR_PX}px` } as React.CSSProperties}>
            <div className="w-11 shrink-0 sm:w-14">
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className={`${board.hour} relative text-right`} style={{ height: HOUR_PX }}>
                  {h > 0 && <span className="absolute -top-2 right-1.5 sm:right-2">{DateTime.fromObject({ hour: h }).toFormat("h a")}</span>}
                </div>
              ))}
            </div>
            {range.days.map((d) => {
              const dayStart = d.startOf("day");
              const dayEvents = timed.filter((e) => {
                const s = DateTime.fromISO(e.start).toMillis();
                const en = DateTime.fromISO(e.end).toMillis();
                return s < dayStart.plus({ days: 1 }).toMillis() && en > dayStart.toMillis();
              });
              return (
                <div
                  key={d.toISODate()}
                  data-day={d.toISODate()}
                  className={board.col}
                  data-today={d.hasSame(now, "day") || undefined}
                  onClick={(ev) => {
                    const rect = (ev.currentTarget as HTMLDivElement).getBoundingClientRect();
                    const minutes = Math.floor(((ev.clientY - rect.top) / HOUR_PX) * 2) * 30;
                    setCreating(dayStart.plus({ minutes }));
                  }}
                >
                  {d.hasSame(now, "day") && (
                    <div className="pointer-events-none absolute right-0 left-0 z-20 h-0.5 bg-vermilion" style={{ top: (now.diff(dayStart, "minutes").minutes / 60) * HOUR_PX }}>
                      <span className="absolute -top-[4px] -left-1.5 h-2.5 w-2.5 rounded-full bg-vermilion" />
                    </div>
                  )}
                  {(() => {
                    const placed = layoutDay(dayEvents, dayStart);
                    // Back-to-back tasks in the same lane run into each other with no gap; only events keep hard edges.
                    const plan = placed.filter((q) => q.e.calendarId === PLAN_CAL);
                    const above = (q: (typeof placed)[number]) => plan.find((o) => o !== q && o.lane === q.lane && Math.abs(o.en - q.s) < 60_000);
                    const below = (q: (typeof placed)[number]) => plan.find((o) => o !== q && o.lane === q.lane && Math.abs(o.s - q.en) < 60_000);
                    return placed.map((p) => {
                    const isPlan = p.e.calendarId === PLAN_CAL;
                    const blk = isPlan ? blockFor(p.e) : null;
                    const state = blk ? blockState(blk) : null;
                    const movable = !!blk && state === "open";
                    const joinTop = isPlan ? above(p) : undefined;
                    const joinBottom = isPlan ? below(p) : undefined;
                    return (
                    <button
                      key={`${p.e.accountId}-${p.e.calendarId}-${p.e.id}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (suppressClick.current) return void (suppressClick.current = false);
                        if (isPlan) setSelectedBlock(blk);
                        else setSelected(p.e);
                      }}
                      onPointerDown={movable ? (ev) => grab(ev, blk!) : undefined}
                      onPointerMove={movable ? moveGrab : undefined}
                      onPointerUp={movable ? (ev) => drop(ev, blk!) : undefined}
                      onPointerCancel={movable ? (ev) => drop(ev, blk!) : undefined}
                      data-booked={(!isPlan && byKind && isBooked(p.e)) || undefined}
                      data-dropped={(isPlan && dropped === p.e.id) || undefined}
                      data-state={state ?? undefined}
                      data-movable={movable || undefined}
                      data-join-top={joinTop ? "" : undefined}
                      data-join-bottom={joinBottom ? "" : undefined}
                      className={isPlan ? board.task : board.print}
                      title={movable ? "Drag to another free time to pin it there" : undefined}
                      style={{
                        top: isPlan ? p.top : p.top + 1,
                        height: isPlan ? p.height : p.height - 2,
                        left: `calc(${(p.lane / p.lanes) * 100}% + 4px)`,
                        width: `calc(${100 / p.lanes}% - 8px)`,
                        ...styleFor(p.e),
                        ...(joinTop ? ({ "--prev": joinTop.e.color } as React.CSSProperties) : {}),
                      }}
                    >
                      {!isPlan && p.height >= 56 && eyebrow(p.e) && (
                        <div className={`truncate text-[0.625rem] font-semibold tracking-[0.06em] uppercase ${eyebrow(p.e)!.className}`}>{eyebrow(p.e)!.text}</div>
                      )}
                      <div className={`flex items-center gap-1 truncate ${isPlan ? "" : "font-medium"}`}>
                        {state === "done" && <Check size={12} strokeWidth={3} className="shrink-0" aria-label="Done" />}
                        {state === "open" && blk?.pinned && <Pin size={11} strokeWidth={2.5} className="shrink-0" aria-label="Pinned" />}
                        {blk?.risk && <AlertTriangle size={11} strokeWidth={2.5} className="shrink-0" aria-label="At risk" />}
                        {labels[labelKey(p.e)]?.priority === "high" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" title="High priority" />}
                        <span className="truncate">{p.e.title}</span>
                      </div>
                      {p.height >= 36 && (
                        <div className={`truncate tnum ${isPlan ? board.time : "opacity-75"}`}>
                          {DateTime.fromISO(p.e.start).setZone(tz).toFormat("h:mm")} – {DateTime.fromISO(p.e.end).setZone(tz).toFormat("h:mm a")}
                          {blk?.risk && <span className={`${board.late} ml-1.5`}>{blk.risk === "late" ? "late?" : "no room"}</span>}
                          {state === "partly" && <span className={`${board.late} ml-1.5`}>{blk!.progress}%</span>}
                          {state === "good_enough" && <span className={`${board.late} ml-1.5`}>good enough</span>}
                          {state === "missed" && <span className={`${board.late} ml-1.5`}>not done</span>}
                        </div>
                      )}
                    </button>
                    );
                  });
                  })()}
                </div>
              );
            })}
          </div>
          {note && (
            <p key={note.key} className={board.note} data-tone={note.tone} role="status">
              {note.text}
            </p>
          )}
          {events === null && (
            <div className="absolute inset-0 grid place-items-center bg-canvas/60 text-sm text-muted">
              <span className="inline-flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Loading your calendar…</span>
            </div>
          )}
        </div>
        </>)}
      </div>


      {selected && (
        <EventDetails
          event={selected}
          label={labels[labelKey(selected)]}
          categories={categories}
          tz={tz}
          onClose={() => setSelected(null)}
          onDeleted={() => {
            setSelected(null);
            load();
          }}
          onLabeled={load}
        />
      )}
      {selectedBlock && (
        <BlockDetails
          block={selectedBlock}
          tz={tz}
          onClose={() => setSelectedBlock(null)}
          onChanged={() => {
            setSelectedBlock(null);
            load();
          }}
        />
      )}
      {creating && (
        <NewMeeting
          start={creating}
          tz={tz}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function Chip({ label, color, off, onClick, icon }: { label: string; color?: string; off: boolean; onClick: () => void; icon?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={!off}
      title={off ? `Show ${label}` : `Hide ${label}`}
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 transition ${off ? "border-line text-faint line-through opacity-60" : "border-line-strong text-ink"}`}
    >
      {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
      {icon}
      {label}
    </button>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-line bg-modal p-6 shadow-(--shadow-modal) sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
  </div>
);
}

function EventDetails({
  event,
  label,
  categories,
  tz,
  onClose,
  onDeleted,
  onLabeled,
}: {
  event: CalendarEvent;
  label: Label | undefined;
  categories: Category[];
  tz: string;
  onClose: () => void;
  onDeleted: () => void;
  onLabeled: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(label?.categoryId ?? null);
  const [priority, setPriority] = useState<Priority | "">(label?.source ? label.priority : "");
  const [applyToTitle, setApplyToTitle] = useState(false);
  const [saving, setSaving] = useState(false);
  const labelDirty = categoryId !== (label?.categoryId ?? null) || (priority || null) !== (label?.source ? label.priority : null);

  async function saveLabel() {
    setSaving(true);
    setError(null);
    const r = await labelEvent({ accountId: event.accountId, eventKey: eventKey(event), title: event.title, categoryId, priority: priority || null, applyToTitle });
    setSaving(false);
    if (r.error) return setError(r.error);
    onLabeled();
  }
  const s = DateTime.fromISO(event.start).setZone(tz);
  const e = DateTime.fromISO(event.end).setZone(tz);

  async function remove() {
    if (!confirm("Delete this event? Guests will be notified.")) return;
    setDeleting(true);
    const q = new URLSearchParams({ accountId: String(event.accountId), calendarId: event.calendarId, eventId: event.id });
    const res = await fetch(`/api/calendar/events?${q}`, { method: "DELETE" });
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not delete");
      setDeleting(false);
      return;
    }
    onDeleted();
  }

  return (
    <Modal onClose={onClose}>
      <div className="flex items-start gap-3">
        <span className="mt-2 h-3 w-3 shrink-0 rounded-full" style={{ background: event.color }} />
        <div className="min-w-0 flex-1">
          <h3 className="text-xl font-semibold tracking-tight break-words">{event.title}</h3>
          <p className="mt-1 text-sm text-muted tnum">
            {event.allDay
              ? DateTime.fromISO(event.start).toFormat("cccc, LLLL d")
              : `${s.toFormat("cccc, LLLL d · h:mm a")} – ${e.toFormat("h:mm a")}`}
          </p>
        </div>
        <button onClick={onClose} className="btn-ghost px-2 py-1" aria-label="Close"><X size={18} /></button>
      </div>
      <div className="mt-6 space-y-5 text-sm">
        {event.meetLink && (
          <a href={event.meetLink} target="_blank" rel="noreferrer" className="btn-primary w-full py-2.5"><Video size={16} /> Join with {meetingLinkLabel(event.meetLink)}</a>
        )}
        {event.location && (
          <p className="flex gap-2.5 text-muted"><MapPin size={16} className="mt-0.5 shrink-0 text-accent-soft" /> <span className="break-words">{event.location}</span></p>
        )}
        {event.attendees.length > 0 && (
          <div>
            <p className="flex items-center gap-2.5 font-medium text-ink"><Users size={16} className="text-accent-soft" /> {event.attendees.length} guest{event.attendees.length === 1 ? "" : "s"}</p>
            <ul className="mt-2 space-y-1 pl-6.5 text-muted">
              {event.attendees.map((a) => (
                <li key={a.email}>
                  {a.name ? `${a.name} · ` : ""}
                  {a.email}
                  {a.status && a.status !== "needsAction" && <span className="ml-1 text-xs text-faint">({a.status})</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {event.description && <p className="rounded-xl bg-well p-4 break-words whitespace-pre-line text-muted">{stripHtml(event.description)}</p>}

        <div className="rounded-xl border border-line p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="eyebrow">Category</span>
            {label?.source === "ai" && <span className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent-soft"><Sparkles size={10} /> AI</span>}
            {label?.source === "rule" && <span className="rounded-md bg-well px-1.5 py-0.5 text-[11px] text-faint">rule</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <select className="input w-44 py-1.5" value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)} aria-label="Category">
              <option value="">Other</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select className="input w-40 py-1.5" value={priority} onChange={(e) => setPriority(e.target.value as Priority | "")} aria-label="Priority">
              <option value="">Priority: default</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>Priority: {PRIORITY_LABEL[p]}</option>
              ))}
            </select>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={applyToTitle} onChange={(e) => setApplyToTitle(e.target.checked)} />
            Apply to every event titled &ldquo;{event.title.slice(0, 40)}{event.title.length > 40 ? "…" : ""}&rdquo;
          </label>
          {(labelDirty || applyToTitle) && (
            <button onClick={saveLabel} disabled={saving} className="btn-secondary mt-3 py-1.5">{saving ? "Saving…" : "Save label"}</button>
          )}
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-7 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-5">
        {event.canEdit ? (
          <button onClick={remove} disabled={deleting} className="btn-ghost text-danger hover:text-danger"><Trash2 size={16} /> {deleting ? "Deleting…" : "Delete"}</button>
        ) : <span />}
        {event.htmlLink && (
          <a href={event.htmlLink} target="_blank" rel="noreferrer" className="btn-secondary"><ExternalLink size={15} /> Open in calendar</a>
        )}
      </div>
    </Modal>
  );
}

function NewMeeting({ start, tz, onClose, onCreated }: { start: DateTime; tz: string; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(start.toISODate()!);
  const [from, setFrom] = useState(start.toFormat("HH:mm"));
  const [to, setTo] = useState(start.plus({ minutes: 30 }).toFormat("HH:mm"));
  const [attendees, setAttendees] = useState("");
  const [locationType, setLocationType] = useState("online");
  const [locationValue, setLocationValue] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Writable calendars across all connected accounts; "" means the user's default.
  const [targets, setTargets] = useState<{ value: string; label: string; onlineMeetings: boolean }[] | null>(null);
  const [target, setTarget] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/calendar/calendars")
      .then((r) => r.json())
      .then((d: { targets?: { value: string; label: string; onlineMeetings: boolean }[]; default?: { accountId: number | null; calendarId: string } }) => {
        if (cancelled) return;
        const list = d.targets ?? [];
        setTargets(list);
        const def = `${d.default?.accountId}:${d.default?.calendarId}`;
        setTarget(list.some((t) => t.value === def) ? def : (list[0]?.value ?? ""));
      })
      .catch(() => !cancelled && setTargets([]));
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const s = DateTime.fromISO(`${date}T${from}`, { zone: tz });
    let e = DateTime.fromISO(`${date}T${to}`, { zone: tz });
    if (e <= s) e = e.plus({ days: 1 });
    const res = await fetch("/api/calendar/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        start: s.toUTC().toISO(),
        end: e.toUTC().toISO(),
        timezone: tz,
        attendees: attendees.split(/[\s,;]+/).filter(Boolean),
        description,
        locationType,
        locationValue,
        ...(target ? { accountId: Number(target.slice(0, target.indexOf(":"))), calendarId: target.slice(target.indexOf(":") + 1) } : {}),
      }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not create the meeting");
      setBusy(false);
      return;
    }
    onCreated();
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-semibold tracking-tight">New meeting</h3>
          <button type="button" onClick={onClose} className="btn-ghost px-2 py-1" aria-label="Close"><X size={18} /></button>
        </div>
        <div>
          <label className="label" htmlFor="nm-title">Title</label>
          <input id="nm-title" className="input" required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project sync" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="label" htmlFor="nm-date">Date</label>
            <input id="nm-date" type="date" className="input" required value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="nm-from">Start</label>
            <input id="nm-from" type="time" className="input" required value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="nm-to">End</label>
            <input id="nm-to" type="time" className="input" required value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="nm-loc">Location</label>
          <select id="nm-loc" className="input" value={locationType} onChange={(e) => setLocationType(e.target.value)}>
            <option value="online">Video call (Meet or Teams link added automatically)</option>
            <option value="in_person">In person</option>
            <option value="phone">Phone call</option>
            <option value="custom_link">Other video link (Zoom, Teams…)</option>
            <option value="none">No location</option>
          </select>
          {(locationType === "in_person" || locationType === "phone" || locationType === "custom_link") && (
            <input
              className="input mt-2"
              required
              value={locationValue}
              onChange={(e) => setLocationValue(e.target.value)}
              placeholder={locationType === "in_person" ? "Address or room" : locationType === "phone" ? "Phone number" : "https://zoom.us/j/…"}
            />
          )}
        </div>
        {targets && targets.length > 1 && (
          <div>
            <label className="label" htmlFor="nm-cal">Calendar</label>
            <select id="nm-cal" className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="label" htmlFor="nm-guests">Guests</label>
          <textarea id="nm-guests" className="input" rows={2} value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="alex@example.com, sam@example.com" />
          <p className="help">Guests receive a calendar invitation.</p>
        </div>
        <div>
          <label className="label" htmlFor="nm-desc">Description</label>
          <textarea id="nm-desc" className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <p className="text-xs text-faint">Times are in {tz.replace(/_/g, " ")}.</p>
        {error && <p className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="btn-primary">{busy ? "Creating…" : "Create meeting"}</button>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

/** A planned block: finish the task, push it to another day, or keep it at this time. */
const PROGRESS_STEPS = [25, 50, 75];

function BlockDetails({ block, tz, onClose, onChanged }: { block: PlannedBlock; tz: string; onClose: () => void; onChanged: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = blockState(block);
  const [picking, setPicking] = useState<"partly" | "good_enough" | null>(null);
  const [residue, setResidue] = useState("");
  const s = DateTime.fromISO(block.start).setZone(tz);
  const e = DateTime.fromISO(block.end).setZone(tz);
  const run = async (fn: () => Promise<{ error?: string }>) => {
    setPending(true);
    setError(null);
    const r = await fn();
    setPending(false);
    if (r.error) setError(r.error);
    else {
      onChanged();
      window.dispatchEvent(new Event(TASKS_CHANGED));
    }
  };
  const mark = (state: BlockState) => run(() => markBlock(block.taskId, block.start, block.end, state));
  const options: { id: "not_done" | "partly" | "good_enough" | "done"; label: string }[] = [
    { id: "not_done", label: "Not done" },
    { id: "partly", label: current === "partly" ? `${block.progress}% done` : "Partly" },
    { id: "good_enough", label: "Good enough" },
    { id: "done", label: "Done" },
  ];
  const active = current === "missed" || current === "open" ? "not_done" : current;
  return (
    <Modal onClose={onClose}>
      <div className="space-y-5">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">{block.title}</h3>
          <p className="text-sm text-muted tnum">{s.toFormat("cccc, LLL d · h:mm")} – {e.toFormat("h:mm a")}</p>
          {block.dueDate && <p className="text-sm text-faint">Due {DateTime.fromISO(block.dueDate).toFormat("ccc, LLL d")}</p>}
          {block.risk && (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-warning">
              <AlertTriangle size={14} /> {block.risk === "late" ? "This won't be finished by its due date at the current pace." : "Not all of this fits in the next two weeks."}
            </p>
          )}
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-ink">How did it go?</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="How did it go?">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={active === o.id}
                disabled={pending}
                onClick={() => (o.id === "partly" || o.id === "good_enough" ? setPicking(o.id) : mark({ status: o.id }))}
                className={`flex flex-col items-start gap-1.5 rounded-md border px-2.5 py-2 text-left text-sm transition ${active === o.id ? "border-ink text-ink" : "border-line text-muted hover:border-line-strong"}`}
              >
                <StateSwatch state={o.id === "not_done" ? "missed" : o.id} />
                {o.label}
              </button>
            ))}
          </div>
          {picking === "partly" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">How much is done?</span>
              {PROGRESS_STEPS.map((pct) => (
                <button key={pct} type="button" className="btn-secondary px-3 py-1 tnum" disabled={pending} onClick={() => mark({ status: "partly", progress: pct })}>
                  {pct}%
                </button>
              ))}
            </div>
          )}
          {picking === "good_enough" && (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(ev) => {
                ev.preventDefault();
                void mark({ status: "good_enough", residue });
              }}
            >
              <input className="input py-1.5" placeholder="What's left, in a few words" value={residue} onChange={(ev) => setResidue(ev.target.value)} autoFocus maxLength={300} />
              <button className="btn-primary py-1.5" disabled={pending || !residue.trim()}>Save</button>
            </form>
          )}
          <p className="mt-2 text-xs text-faint">It stays here on your calendar either way. Partly done means Midore plans only what is left.</p>
        </div>

        {!block.past && current !== "done" && current !== "good_enough" && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <button className="btn-secondary py-1.5" disabled={pending} onClick={() => run(() => skipTaskOn(block.taskId, s.toISODate()))}>Not this day</button>
            {block.pinned ? (
              <button className="btn-secondary py-1.5" disabled={pending} onClick={() => run(() => unpinTask(block.taskId))}><PinOff size={15} /> Let it move</button>
            ) : (
              <button className="btn-secondary py-1.5" disabled={pending} onClick={() => run(() => pinBlock(block.taskId, block.start, block.end))}><Pin size={15} /> Keep it here</button>
            )}
            <Link href="/dashboard/tasks" className="btn-ghost py-1.5">Open tasks</Link>
          </div>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  );
}

/** A tiny sample of how each state looks on the calendar. */
function StateSwatch({ state }: { state: TaskState | "not_done" }) {
  return <span className={board.swatch} data-state={state} style={{ "--c": "#e11d48" } as React.CSSProperties} aria-hidden />;
}
