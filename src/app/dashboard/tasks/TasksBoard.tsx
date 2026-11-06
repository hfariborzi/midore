"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertCircle, Bell, Check, ChevronDown, ChevronRight, CircleDashed, Link2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { Category, Priority, Project, Task, TaskLink, TaskStatus } from "@/db/schema";
import { PRIORITY_LABEL } from "@/lib/labels/core";
import { Dori, type DoriMood } from "@/components/Dori";
import { blockedTaskIds, compareTasks, dueLabel, formatEstimate, isComplete, progress } from "@/lib/tasks/core";
import { repeatLabel } from "@/lib/tasks/repeat";
import { OPEN_DORI, type OpenDoriDetail } from "../DoriPanel";
import { addTaskLink, deleteProject, deleteTask, deleteTaskLink, promoteResidue, saveProject, saveTask, setTaskStatus, type TaskInput } from "../actions";
import { GRAPHITE, toPalette } from "@/lib/palette";

const SIMPLE_REPEATS = ["daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"];

type View = { kind: "area"; id: number | null } | { kind: "all" } | { kind: "loose" } | { kind: "reminders" } | { kind: "completed" };

const NO_AREA = { id: null, name: "No area", color: GRAPHITE };

export function TasksBoard({ categories, projects, tasks, links, today }: { categories: Category[]; projects: Project[]; tasks: Task[]; links: TaskLink[]; today: string }) {
  const [view, setView] = useState<View>({ kind: "all" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ error?: string }>) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (r.error) setError(r.error);
    });
  };

  const blocked = useMemo(() => blockedTaskIds(tasks, links), [tasks, links]);
  const open = tasks.filter((t) => !isComplete(t.status));
  const openCount = (categoryId: number | null) => open.filter((t) => t.categoryId === categoryId).length;
  const loose = tasks.filter((t) => t.status === "good_enough" && t.residue);
  const reminders = open.filter((t) => t.kind === "reminder");
  const completed = tasks.filter((t) => isComplete(t.status)).sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));

  const areaOf = (id: number | null) => (id === null ? NO_AREA : (categories.find((c) => c.id === id) ?? NO_AREA));
  const inView = (t: Task) => (view.kind === "area" ? t.categoryId === view.id : true);
  const visibleProjects = projects.filter((p) => (view.kind === "area" ? p.categoryId === view.id : true));
  const ctx = { tasks, links, blocked, today, projects, categories, run, pending };

  const navItem = (label: string, active: boolean, onClick: () => void, extra?: React.ReactNode, color?: string) => (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${active ? "bg-accent/15 font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink"}`}
    >
      {color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {extra}
    </button>
  );
  const count = (n: number) => (n > 0 ? <span className="text-xs tnum text-faint">{n}</span> : null);

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <aside className="card p-3 lg:sticky lg:top-6 lg:w-56 lg:shrink-0">
        <p className="eyebrow px-2.5 pb-1.5">Areas</p>
        {navItem("Everything", view.kind === "all", () => setView({ kind: "all" }), count(open.length))}
        {categories.map((c) => navItem(c.name, view.kind === "area" && view.id === c.id, () => setView({ kind: "area", id: c.id }), count(openCount(c.id)), toPalette(c.color)))}
        {navItem(NO_AREA.name, view.kind === "area" && view.id === null, () => setView({ kind: "area", id: null }), count(openCount(null)), NO_AREA.color)}
        <p className="eyebrow mt-4 px-2.5 pb-1.5">Lists</p>
        {navItem("Loose ends", view.kind === "loose", () => setView({ kind: "loose" }), count(loose.length))}
        {navItem("Reminders", view.kind === "reminders", () => setView({ kind: "reminders" }), count(reminders.length))}
        {navItem("Completed", view.kind === "completed", () => setView({ kind: "completed" }), count(completed.length))}
      </aside>

      <div className="min-w-0 flex-1 space-y-4">
        {error && <p className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        {view.kind === "loose" && (
          <section className="card p-5">
            <h2 className="font-semibold">Loose ends</h2>
            <p className="text-sm text-faint">The small parts left on tasks you called good enough. Clear them when they&apos;re done, or make one its own task.</p>
            <ul className="mt-4 divide-y divide-line">
              {loose.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <CircleDashed size={16} className="shrink-0 text-accent-soft" />
                  <div className="min-w-0 flex-1">
                    <div className="text-ink">{t.residue}</div>
                    <div className="text-xs text-faint">from “{t.title}”{t.projectId && ` · ${projects.find((p) => p.id === t.projectId)?.name ?? ""}`}</div>
                  </div>
                  <button className="btn-ghost px-2.5 py-1.5 text-xs" disabled={pending} onClick={() => run(() => setTaskStatus({ id: t.id, status: "done" }))}><Check size={14} /> Nothing left</button>
                  <button className="btn-ghost px-2.5 py-1.5 text-xs" disabled={pending} onClick={() => run(() => promoteResidue(t.id))}><Plus size={14} /> Make it a task</button>
                </li>
              ))}
              {loose.length === 0 && (
                <li className="py-6">
                  <EmptyState mood="celebrating" text="Nothing hanging. Good." />
                </li>
              )}
            </ul>
          </section>
        )}

        {view.kind === "reminders" && (
          <section className="card p-5">
            <h2 className="font-semibold">Reminders</h2>
            <p className="text-sm text-faint">Things to remember, with no time attached.</p>
            <TaskList {...ctx} items={reminders} empty={{ mood: "happy", text: "Nothing to remember right now." }} />
            <QuickAdd kind="reminder" placeholder="Something to remember…" projectId={null} categoryId={null} run={run} pending={pending} />
          </section>
        )}

        {view.kind === "completed" && (
          <section className="card p-5">
            <h2 className="font-semibold">Completed</h2>
            <TaskList {...ctx} items={completed.slice(0, 200)} empty={{ mood: "sleeping", text: "Finished tasks will rest here." }} />
          </section>
        )}

        {(view.kind === "all" || view.kind === "area") && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold tracking-tight">{view.kind === "all" ? "Everything" : areaOf(view.id).name}</h2>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary py-1.5"
                  onClick={() => window.dispatchEvent(new CustomEvent<OpenDoriDetail>(OPEN_DORI, { detail: { prefill: "Here's everything on my plate: " } }))}
                >
                  <Dori mood="happy" size={22} /> Tell Dori everything
                </button>
                <NewProject categoryId={view.kind === "area" ? view.id : categories[0]?.id ?? null} categories={categories} run={run} pending={pending} />
              </div>
            </div>
            {projects.length === 0 && tasks.length === 0 && (
              <section className="card flex flex-col items-center gap-5 p-6 text-center sm:flex-row sm:text-left">
                <Dori mood="happy" size={120} live />
                <div>
                  <h3 className="text-lg font-semibold tracking-tight">Hi, I&apos;m Dori.</h3>
                  <p className="mt-1 max-w-lg text-sm leading-relaxed text-muted">
                    Tell me everything on your plate once, in any order, and I&apos;ll sort it into areas, projects and tasks
                    and plan them around your calendar. Or add things yourself below. When something is mostly done,
                    call it good enough and note what&apos;s left.
                  </p>
                  <button
                    type="button"
                    className="btn-primary mt-3 py-1.5"
                    onClick={() => window.dispatchEvent(new CustomEvent<OpenDoriDetail>(OPEN_DORI, { detail: { prefill: "Here's everything on my plate: " } }))}
                  >
                    Tell Dori everything
                  </button>
                </div>
              </section>
            )}
            {visibleProjects.filter((p) => p.status !== "done").map((p) => (
              <ProjectCard key={p.id} project={p} area={areaOf(p.categoryId)} {...ctx} />
            ))}
            <section className="card p-5">
              <h3 className="font-semibold">{view.kind === "all" ? "Tasks without a project" : "Other tasks"}</h3>
              <TaskList {...ctx} items={open.filter((t) => t.projectId === null && t.kind === "task" && inView(t))} />
              <QuickAdd kind="task" placeholder="Add a task…" projectId={null} categoryId={view.kind === "area" ? view.id : null} run={run} pending={pending} />
            </section>
            {visibleProjects.some((p) => p.status === "done") && (
              <details className="px-1 text-sm text-faint">
                <summary className="cursor-pointer">Finished projects</summary>
                <div className="mt-3 space-y-3">
                  {visibleProjects.filter((p) => p.status === "done").map((p) => (
                    <ProjectCard key={p.id} project={p} area={areaOf(p.categoryId)} {...ctx} />
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type Ctx = {
  tasks: Task[];
  links: TaskLink[];
  blocked: Set<number>;
  today: string;
  projects: Project[];
  categories: Category[];
  run: (fn: () => Promise<{ error?: string }>) => void;
  pending: boolean;
};

function ProjectCard({ project, area, ...ctx }: Ctx & { project: Project; area: { id: number | null; name: string; color: string } }) {
  const [openCard, setOpenCard] = useState(project.status !== "done");
  const [editing, setEditing] = useState(false);
  const items = ctx.tasks.filter((t) => t.projectId === project.id);
  const prog = progress(items);
  const due = dueLabel(project.targetDate, ctx.today);
  return (
    <section className="card relative overflow-hidden">
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: toPalette(area.color) }} />
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <button type="button" onClick={() => setOpenCard(!openCard)} className="btn-ghost -ml-2 p-1" aria-label={openCard ? "Collapse" : "Expand"}>
          {openCard ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <button type="button" onClick={() => setEditing(!editing)} className="min-w-0 text-left font-semibold tracking-tight hover:text-accent-soft">{project.name}</button>
        {project.status === "paused" && <Tag>Paused</Tag>}
        {project.status === "done" && <Tag>Done</Tag>}
        <span className="text-xs text-faint tnum">{prog.done}/{prog.total}</span>
        {due && project.status !== "done" && <Tag tone={due.tone}>Target {due.text}</Tag>}
        <div className="ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-well">
          <div className="h-full rounded-full bg-accent" style={{ width: prog.total ? `${(100 * prog.done) / prog.total}%` : 0 }} />
        </div>
      </div>
      {editing && <ProjectForm project={project} categories={ctx.categories} run={ctx.run} pending={ctx.pending} onDone={() => setEditing(false)} />}
      {openCard && (
        <div className="border-t border-line px-5 pb-4">
          {project.notes && <p className="pt-3 text-sm whitespace-pre-wrap text-muted">{project.notes}</p>}
          <TaskList {...ctx} items={items.filter((t) => !isComplete(t.status))} />
          {items.some((t) => isComplete(t.status)) && (
            <details className="mt-1 text-xs text-faint">
              <summary className="cursor-pointer py-1">{items.filter((t) => isComplete(t.status)).length} completed</summary>
              <TaskList {...ctx} items={items.filter((t) => isComplete(t.status))} />
            </details>
          )}
          <QuickAdd kind="task" placeholder="Add a task…" projectId={project.id} categoryId={project.categoryId} run={ctx.run} pending={ctx.pending} />
        </div>
      )}
    </section>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: "overdue" | "soon" | "later" }) {
  const cls = tone === "overdue" ? "bg-danger/10 text-danger" : tone === "soon" ? "bg-warning/15 text-warning" : "bg-hover text-muted";
  return <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

function EmptyState({ mood, text }: { mood: DoriMood; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-2 text-center text-sm text-faint">
      <Dori mood={mood} size={88} />
      <p>{text}</p>
    </div>
  );
}

function TaskList({ items, empty, ...ctx }: Ctx & { items: Task[]; empty?: { mood: DoriMood; text: string } }) {
  const sorted = [...items].sort(compareTasks);
  if (!sorted.length) return empty ? <EmptyState {...empty} /> : <p className="py-3 text-sm text-faint">Nothing here.</p>;
  return (
    <ul className="divide-y divide-line">
      {sorted.map((t) => (
        <TaskRow key={t.id} task={t} {...ctx} />
      ))}
    </ul>
  );
}

function TaskRow({ task, ...ctx }: Ctx & { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const [residue, setResidue] = useState<string | null>(null);
  const done = isComplete(task.status);
  const due = dueLabel(task.dueDate, ctx.today);
  const blocked = ctx.blocked.has(task.id);
  const after = ctx.links.filter((l) => l.kind === "before" && l.toTaskId === task.id).map((l) => ctx.tasks.find((t) => t.id === l.fromTaskId)).filter(Boolean) as Task[];
  const together = ctx.links.filter((l) => l.kind === "together" && (l.fromTaskId === task.id || l.toTaskId === task.id)).length;
  const set = (status: TaskStatus, r?: string) => {
    setMenu(false);
    setResidue(null);
    ctx.run(() => setTaskStatus({ id: task.id, status, residue: r }));
  };

  return (
    <li className="py-1.5">
      <div className="flex items-start gap-3">
        <div className="relative mt-0.5">
          <button
            type="button"
            onClick={() => (done ? set("open") : setMenu(!menu))}
            title={done ? "Reopen" : "Complete"}
            className={`grid h-5 w-5 place-items-center rounded-full border transition ${
              task.status === "done" ? "border-accent bg-accent text-on-accent" : task.status === "good_enough" ? "border-accent bg-accent/20 text-accent-soft" : task.status === "dropped" ? "border-line-strong bg-well text-faint" : "border-line-strong hover:border-accent"
            }`}
          >
            {task.status === "done" && <Check size={12} strokeWidth={3} />}
            {task.status === "good_enough" && <CircleDashed size={12} strokeWidth={2.5} />}
            {task.status === "dropped" && <X size={11} />}
          </button>
          {menu && (
            <div className="absolute top-6 left-0 z-20 w-44 rounded-lg border border-line bg-paper p-1 text-sm shadow-(--shadow-card)">
              <MenuItem onClick={() => set("done")} icon={<Check size={14} />}>Done</MenuItem>
              <MenuItem onClick={() => { setMenu(false); setResidue(""); }} icon={<CircleDashed size={14} />}>Good enough…</MenuItem>
              <MenuItem onClick={() => set("dropped")} icon={<X size={14} />}>Drop it</MenuItem>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => setExpanded(!expanded)} className={`block w-full truncate text-left text-sm ${done ? "text-faint line-through decoration-line-strong" : "text-ink"}`}>
            {task.title}
          </button>
          {residue !== null && (
            <form
              className="mt-1.5 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                set("good_enough", residue);
              }}
            >
              <input autoFocus className="input py-1 text-sm" placeholder="What's the small part left?" value={residue} maxLength={300} onChange={(e) => setResidue(e.target.value)} />
              <button type="submit" className="btn-primary py-1 text-xs" disabled={ctx.pending}>Good enough</button>
              <button type="button" className="btn-ghost py-1 text-xs" onClick={() => setResidue(null)}>Cancel</button>
            </form>
          )}
          {task.status === "good_enough" && task.residue && <p className="text-xs text-accent-soft">Left: {task.residue}</p>}
          {(due || task.estimateMinutes || task.priority === "high" || blocked || after.length > 0 || together > 0 || task.kind === "reminder" || task.people.length > 0 || task.remindAt || task.repeat || task.waitingOn || task.checklist.length > 0) && !done && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint">
              {task.kind === "reminder" && !task.remindAt && <span className="inline-flex items-center gap-1"><Bell size={11} /> reminder</span>}
              {task.remindAt && <span className="inline-flex items-center gap-1 tnum"><Bell size={11} /> {new Date(task.remindAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>}
              {task.repeat && <span>{repeatLabel(task.repeat)}</span>}
              {due && <span className={due.tone === "overdue" ? "text-danger" : due.tone === "soon" ? "text-warning" : ""}>{task.hardDeadline ? "Deadline " : "Due "}{due.text}</span>}
              {task.estimateMinutes ? <span className="tnum">{formatEstimate(task.estimateMinutes)}</span> : null}
              {task.priority === "high" && <span className="text-danger">High</span>}
              {task.priority === "low" && <span>Low</span>}
              {blocked && <span className="inline-flex items-center gap-1 text-warning"><AlertCircle size={11} /> waiting on {after.filter((a) => !isComplete(a.status)).map((a) => a.title).join(", ")}</span>}
              {!blocked && after.length > 0 && <span className="inline-flex items-center gap-1"><Link2 size={11} /> after {after.map((a) => a.title).join(", ")}</span>}
              {together > 0 && <span className="inline-flex items-center gap-1"><Link2 size={11} /> with {together} other{together > 1 ? "s" : ""}</span>}
              {task.people.length > 0 && <span>{task.people.join(", ")}</span>}
              {task.waitingOn && <span className="text-warning">Waiting on {task.waitingOn}</span>}
              {task.checklist.length > 0 && <span className="tnum">{task.checklist.filter((c) => c.done).length}/{task.checklist.length} steps</span>}
            </div>
          )}
        </div>
      </div>
      {expanded && <TaskForm task={task} {...ctx} onDone={() => setExpanded(false)} />}
    </li>
  );
}

function MenuItem({ children, onClick, icon }: { children: React.ReactNode; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted hover:bg-hover hover:text-ink">
      {icon} {children}
    </button>
  );
}

function QuickAdd({ kind, placeholder, projectId, categoryId, run, pending }: { kind: "task" | "reminder"; placeholder: string; projectId: number | null; categoryId: number | null; run: Ctx["run"]; pending: boolean }) {
  const [title, setTitle] = useState("");
  return (
    <form
      className="mt-2 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        run(async () => {
          const r = await saveTask({ title, kind, projectId, categoryId });
          if (!r.error) setTitle("");
          return r;
        });
      }}
    >
      <Plus size={15} className="shrink-0 text-faint" />
      <input className="input border-transparent bg-transparent px-1 py-1 text-sm focus:bg-well" placeholder={placeholder} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} disabled={pending} />
    </form>
  );
}

function NewProject({ categoryId, categories, run, pending }: { categoryId: number | null; categories: Category[]; run: Ctx["run"]; pending: boolean }) {
  const [openForm, setOpenForm] = useState(false);
  if (!openForm) return <button className="btn-primary py-1.5" onClick={() => setOpenForm(true)}><Plus size={16} /> New project</button>;
  return (
    <div className="card w-full p-4">
      <ProjectForm project={null} defaultCategoryId={categoryId} categories={categories} run={run} pending={pending} onDone={() => setOpenForm(false)} />
    </div>
  );
}

function ProjectForm({ project, defaultCategoryId = null, categories, run, pending, onDone }: { project: Project | null; defaultCategoryId?: number | null; categories: Category[]; run: Ctx["run"]; pending: boolean; onDone: () => void }) {
  const [name, setName] = useState(project?.name ?? "");
  const [notes, setNotes] = useState(project?.notes ?? "");
  const [categoryId, setCategoryId] = useState<number | null>(project ? project.categoryId : defaultCategoryId);
  const [targetDate, setTargetDate] = useState(project?.targetDate ?? "");
  const [status, setStatus] = useState(project?.status ?? "active");
  return (
    <form
      className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await saveProject({ id: project?.id, name, notes, categoryId, targetDate: targetDate || null, status });
          if (!r.error) onDone();
          return r;
        });
      }}
    >
      <div className="sm:col-span-2">
        <label className="label">Project</label>
        <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. JIBS revision" autoFocus />
      </div>
      <div>
        <label className="label">Area</label>
        <select className="input" value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">No area</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Target date</label>
        <input type="date" className="input" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
      </div>
      <div className="sm:col-span-2">
        <label className="label">Notes</label>
        <textarea className="input" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {project && (
        <div>
          <label className="label">Status</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as Project["status"])}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="done">Done</option>
          </select>
        </div>
      )}
      <div className="flex items-end justify-end gap-2 sm:col-span-2">
        {project && (
          <button type="button" className="btn-ghost mr-auto text-danger hover:text-danger" disabled={pending} onClick={() => confirm(`Delete "${project.name}" and its tasks?`) && run(() => deleteProject(project.id))}>
            <Trash2 size={15} /> Delete
          </button>
        )}
        <button type="button" className="btn-ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={pending}>{project ? "Save" : "Create"}</button>
      </div>
    </form>
  );
}

function TaskForm({ task, onDone, ...ctx }: Ctx & { task: Task; onDone: () => void }) {
  const [d, setD] = useState<TaskInput>({
    id: task.id, projectId: task.projectId, categoryId: task.categoryId, title: task.title, notes: task.notes, kind: task.kind,
    estimateMinutes: task.estimateMinutes, dueDate: task.dueDate, hardDeadline: task.hardDeadline, priority: task.priority, energy: task.energy, people: task.people, repeat: task.repeat,
    remindTime: task.remindAt ? new Date(task.remindAt).toTimeString().slice(0, 5) : null,
    waitingOn: task.waitingOn, checklist: task.checklist,
  });
  const [step, setStep] = useState("");
  const [linkTo, setLinkTo] = useState("");
  const [linkKind, setLinkKind] = useState<"before" | "together">("before");
  const upd = (patch: Partial<TaskInput>) => setD({ ...d, ...patch });
  const myLinks = ctx.links.filter((l) => l.fromTaskId === task.id || l.toTaskId === task.id);
  const other = (l: TaskLink) => ctx.tasks.find((t) => t.id === (l.fromTaskId === task.id ? l.toTaskId : l.fromTaskId));
  const candidates = ctx.tasks.filter((t) => t.id !== task.id && !isComplete(t.status) && !myLinks.some((l) => l.fromTaskId === t.id || l.toTaskId === t.id));

  return (
    <form
      className="mt-2 mb-2 grid gap-3 rounded-xl border border-line bg-well/60 p-4 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        ctx.run(async () => {
          const r = await saveTask(d);
          if (!r.error) onDone();
          return r;
        });
      }}
    >
      <div className="sm:col-span-3">
        <input className="input" required maxLength={200} value={d.title} onChange={(e) => upd({ title: e.target.value })} aria-label="Title" />
      </div>
      <div className="sm:col-span-3">
        <textarea className="input" rows={2} maxLength={5000} placeholder="Notes" value={d.notes} onChange={(e) => upd({ notes: e.target.value })} />
      </div>
      <div>
        <label className="label">Kind</label>
        <select className="input" value={d.kind} onChange={(e) => upd({ kind: e.target.value as "task" | "reminder" })}>
          <option value="task">Task (can be scheduled)</option>
          <option value="reminder">Reminder (just don&apos;t forget)</option>
        </select>
      </div>
      <div>
        <label className="label">Project</label>
        <select className="input" value={d.projectId ?? ""} onChange={(e) => upd({ projectId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">None</option>
          {ctx.projects.filter((p) => p.status !== "done" || p.id === task.projectId).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Area</label>
        <select className="input" value={d.projectId ? (ctx.projects.find((p) => p.id === d.projectId)?.categoryId ?? "") : (d.categoryId ?? "")} disabled={!!d.projectId} onChange={(e) => upd({ categoryId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">No area</option>
          {ctx.categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {d.projectId && <p className="help">Follows the project.</p>}
      </div>
      <div>
        <label className="label">Due</label>
        <input type="date" className="input" value={d.dueDate ?? ""} onChange={(e) => upd({ dueDate: e.target.value || null })} />
        <label className="mt-1.5 flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={d.hardDeadline} onChange={(e) => upd({ hardDeadline: e.target.checked })} /> Hard deadline
        </label>
      </div>
      <div>
        <label className="label">Alert at</label>
        <input type="time" className="input" value={d.remindTime ?? ""} onChange={(e) => upd({ remindTime: e.target.value || null })} />
        <p className="help">{d.remindTime ? `On the due day${d.dueDate ? "" : " (today)"}` : "No alert"}</p>
      </div>
      {d.kind === "task" && (
        <div>
          <label className="label">Estimate</label>
          <select className="input" value={d.estimateMinutes ?? ""} onChange={(e) => upd({ estimateMinutes: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Not sure</option>
            {[15, 30, 45, 60, 90, 120, 180, 240, 360, 480].map((m) => (
              <option key={m} value={m}>{formatEstimate(m)}</option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label className="label">Priority</label>
        <select className="input" value={d.priority} onChange={(e) => upd({ priority: e.target.value as Priority })}>
          {(["high", "normal", "low"] as Priority[]).map((p) => (
            <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
          ))}
        </select>
      </div>
      {d.kind === "task" && (
        <div>
          <label className="label">Energy</label>
          <select className="input" value={d.energy ?? ""} onChange={(e) => upd({ energy: (e.target.value || null) as "deep" | "light" | null })}>
            <option value="">Either</option>
            <option value="deep">Deep focus</option>
            <option value="light">Light</option>
          </select>
        </div>
      )}
      <div>
        <label className="label">Repeats</label>
        <select className="input" value={d.repeat ?? ""} onChange={(e) => upd({ repeat: (e.target.value || null) as TaskInput["repeat"] })}>
          <option value="">Never</option>
          <option value="daily">Every day</option>
          <option value="weekdays">Every weekday</option>
          <option value="weekly">Every week</option>
          <option value="biweekly">Every 2 weeks</option>
          <option value="monthly">Every month</option>
          <option value="yearly">Every year</option>
          {d.repeat && !SIMPLE_REPEATS.includes(d.repeat) && <option value={d.repeat}>{repeatLabel(d.repeat)}</option>}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label">People involved</label>
        <input className="input" placeholder="Names or emails, comma separated" value={d.people?.join(", ") ?? ""} onChange={(e) => upd({ people: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </div>
      <div>
        <label className="label">Waiting on</label>
        <input className="input" placeholder="Someone or something" maxLength={120} value={d.waitingOn ?? ""} onChange={(e) => upd({ waitingOn: e.target.value || null })} />
        <p className="help">Not planned until this is cleared.</p>
      </div>

      <div className="sm:col-span-3">
        <label className="label">Checklist</label>
        <ul className="space-y-1 text-sm">
          {(d.checklist ?? []).map((item, i) => (
            <li key={i} className="flex items-center gap-2">
              <input type="checkbox" checked={item.done} onChange={(e) => upd({ checklist: d.checklist!.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)) })} aria-label={`Done: ${item.text}`} />
              <span className={item.done ? "text-faint line-through" : ""}>{item.text}</span>
              <button type="button" className="ml-auto text-faint hover:text-danger" aria-label={`Remove ${item.text}`} onClick={() => upd({ checklist: d.checklist!.filter((_, j) => j !== i) })}><X size={14} /></button>
            </li>
          ))}
        </ul>
        <div className="mt-1.5 flex gap-2">
          <input
            className="input py-1 text-sm"
            placeholder="Add a step"
            maxLength={200}
            value={step}
            onChange={(e) => setStep(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && step.trim()) {
                e.preventDefault();
                upd({ checklist: [...(d.checklist ?? []), { text: step.trim(), done: false }] });
                setStep("");
              }
            }}
          />
          <button type="button" className="btn-secondary py-1 text-xs" disabled={!step.trim() || (d.checklist?.length ?? 0) >= 30} onClick={() => { upd({ checklist: [...(d.checklist ?? []), { text: step.trim(), done: false }] }); setStep(""); }}>Add</button>
        </div>
      </div>

      <div className="sm:col-span-3">
        <label className="label">Links</label>
        <ul className="space-y-1 text-sm">
          {myLinks.map((l) => {
            const o = other(l);
            if (!o) return null;
            const text = l.kind === "together" ? `Goes with “${o.title}”` : l.toTaskId === task.id ? `Comes after “${o.title}”` : `Comes before “${o.title}”`;
            return (
              <li key={l.id} className="flex items-center gap-2 text-muted">
                <Link2 size={13} /> <span className="min-w-0 flex-1 truncate">{text}</span>
                <button type="button" className="btn-ghost p-1" title="Remove link" onClick={() => ctx.run(() => deleteTaskLink(l.id))}><X size={13} /></button>
              </li>
            );
          })}
        </ul>
        {candidates.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <select className="input w-auto py-1.5" value={linkKind} onChange={(e) => setLinkKind(e.target.value as "before" | "together")}>
              <option value="before">Comes after</option>
              <option value="together">Goes with</option>
            </select>
            <select className="input min-w-48 flex-1 py-1.5" value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
              <option value="">Choose a task…</option>
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary py-1.5"
              disabled={!linkTo || ctx.pending}
              onClick={() => {
                const otherId = Number(linkTo);
                setLinkTo("");
                ctx.run(() => addTaskLink(linkKind === "before" ? { fromTaskId: otherId, toTaskId: task.id, kind: "before" } : { fromTaskId: task.id, toTaskId: otherId, kind: "together" }));
              }}
            >
              Link
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 sm:col-span-3">
        <button type="button" className="btn-ghost mr-auto text-danger hover:text-danger" disabled={ctx.pending} onClick={() => confirm("Delete this task?") && ctx.run(() => deleteTask(task.id))}>
          <Trash2 size={15} /> Delete
        </button>
        {isComplete(task.status) && (
          <button type="button" className="btn-ghost" disabled={ctx.pending} onClick={() => ctx.run(() => setTaskStatus({ id: task.id, status: "open" }))}><RotateCcw size={15} /> Reopen</button>
        )}
        <button type="button" className="btn-ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={ctx.pending}>Save</button>
      </div>
    </form>
  );
}
