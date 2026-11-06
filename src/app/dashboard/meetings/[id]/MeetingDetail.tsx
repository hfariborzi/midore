"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import type { MeetingStatus, MeetingSummary } from "@/db/schema";
import { OPEN_DORI, type OpenDoriDetail } from "../../DoriPanel";
import { addMeetingTasksAction, deleteMeetingAction, saveMeetingAction } from "../actions";

type M = { id: number; title: string; status: MeetingStatus; recorded: boolean; transcript: string; notes: string; summary: MeetingSummary | null };

const mine = (who: string) => /^(me|i|myself)$/i.test(who.trim());
const dueLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

export function MeetingDetail({ meeting: m, when }: { meeting: M; when: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(m.title);
  const [notes, setNotes] = useState(m.notes);
  const [error, setError] = useState<string | null>(null);
  const [redoing, setRedoing] = useState(false);
  const actions = m.summary?.actions ?? [];
  const [picked, setPicked] = useState<Set<number>>(() => new Set(actions.map((a, i) => (mine(a.who) && !a.taskId ? i : -1)).filter((i) => i >= 0)));

  const redo = async () => {
    setRedoing(true);
    setError(null);
    const res = await fetch(`/api/meetings/${m.id}/finish`, { method: "POST" }).catch(() => null);
    const d = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    if (!res?.ok || d?.error) setError(d?.error ?? "Couldn't write the notes. Try again.");
    setRedoing(false);
    router.refresh();
  };

  const toggle = (i: number) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/dashboard/meetings" scroll={false} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft size={14} /> Meetings
        </Link>
        <label className="sr-only" htmlFor="meeting-title">Title</label>
        <input
          id="meeting-title"
          className="mt-2 w-full border-0 bg-transparent p-0 text-xl font-semibold text-ink outline-none focus:ring-0"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== m.title && start(async () => void (await saveMeetingAction(m.id, { title })))}
        />
        <p className="mt-1 text-sm text-faint">{when}{m.recorded ? "" : " · Notes only"}</p>
      </div>

      {m.status === "recording" ? (
        <p className="card p-4 text-sm text-muted">This meeting is still going. Stop it from the bar at the bottom of the screen and Dori will write the notes.</p>
      ) : m.summary ? (
        <section className="card space-y-5 p-5">
          <div>
            <h2 className="eyebrow">Summary</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
              {m.summary.summary.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
          {m.summary.decisions.length > 0 && (
            <div>
              <h2 className="eyebrow">Decided</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
                {m.summary.decisions.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {actions.length > 0 && (
            <div>
              <h2 className="eyebrow">Next steps</h2>
              <ul className="mt-2 space-y-1.5">
                {actions.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    {a.taskId ? (
                      <Check size={16} className="mt-0.5 shrink-0 text-success" aria-label="In your tasks" />
                    ) : (
                      <input type="checkbox" className="mt-1" checked={picked.has(i)} onChange={() => toggle(i)} aria-label={`Add "${a.text}" to tasks`} />
                    )}
                    <span className="min-w-0 flex-1 text-ink">
                      {a.text}
                      <span className="text-faint"> · {mine(a.who) ? "you" : a.who}{a.due ? ` · by ${dueLabel(a.due)}` : ""}{a.taskId ? " · in your tasks" : ""}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {actions.some((a) => !a.taskId) && (
                <button
                  type="button"
                  className="btn-primary mt-3 text-sm"
                  disabled={pending || picked.size === 0}
                  onClick={() =>
                    start(async () => {
                      const r = await addMeetingTasksAction(m.id, [...picked]);
                      if (r.error) setError(r.error);
                      setPicked(new Set());
                      router.refresh();
                    })
                  }
                >
                  Add {picked.size || ""} to my tasks
                </button>
              )}
            </div>
          )}
        </section>
      ) : (
        <p className="card p-4 text-sm text-muted">
          {m.transcript.trim() || m.notes.trim() ? "No summary yet." : "Nothing was recorded or written in this meeting."}
        </p>
      )}

      {error && <p className="text-sm text-danger" role="alert">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {m.status !== "recording" && (m.transcript.trim() || notes.trim()) && (
          <button type="button" className="btn-ghost text-sm" disabled={redoing} onClick={redo}>
            {redoing ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />} {m.summary ? "Write the notes again" : "Write the notes"}
          </button>
        )}
        <button
          type="button"
          className="btn-ghost text-sm"
          onClick={() => window.dispatchEvent(new CustomEvent<OpenDoriDetail>(OPEN_DORI, { detail: { prefill: `About the meeting "${m.title}": ` } }))}
        >
          <Sparkles size={15} /> Ask Dori about it
        </button>
        <button
          type="button"
          className="btn-ghost ml-auto text-sm text-danger"
          disabled={pending}
          onClick={() => {
            if (!confirm("Delete this meeting, its transcript and notes?")) return;
            start(async () => {
              await deleteMeetingAction(m.id);
              router.push("/dashboard/meetings", { scroll: false });
            });
          }}
        >
          <Trash2 size={15} /> Delete
        </button>
      </div>

      <section>
        <h2 className="eyebrow">Your notes</h2>
        <label className="sr-only" htmlFor="meeting-notes-edit">Your notes</label>
        <textarea
          id="meeting-notes-edit"
          className="input mt-2 min-h-28 w-full resize-y text-sm"
          value={notes}
          placeholder="Nothing written."
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== m.notes && start(async () => void (await saveMeetingAction(m.id, { notes })))}
        />
      </section>

      {m.recorded && (
        <details className="group">
          <summary className="eyebrow cursor-pointer select-none">Transcript</summary>
          <div className="mt-2 max-h-[60vh] overflow-y-auto rounded-lg border border-line bg-surface p-4 text-sm leading-relaxed whitespace-pre-wrap text-muted">
            {m.transcript.trim() || "Nothing was transcribed."}
          </div>
          <p className="mt-1 text-xs text-faint">Speakers aren&apos;t labelled. Times are from the start of the recording.</p>
        </details>
      )}
    </div>
  );
}
