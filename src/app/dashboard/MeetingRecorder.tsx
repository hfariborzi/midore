"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, Loader2, Mic, NotebookPen, Pause, Play, Square, X } from "lucide-react";

/** Start a meeting from anywhere (the Meetings page, a calendar event). */
export const START_MEETING = "midore:start-meeting";
export type StartMeetingDetail = { title?: string; eventKey?: string; record?: boolean };

type Session = { id: number; title: string; recorded: boolean };
type Detected = { key: string; title: string; start: string; end: string; link: string | null };

const CHUNK_MS = 60_000; // each minute is transcribed on its own
const POLL_MS = 120_000;
const DISMISSED_KEY = "midore:meeting-dismissed";

function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

const canShareTab = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad/i.test(navigator.userAgent);
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/**
 * Meeting notes: offers to record when a meeting on the calendar starts, records the microphone (and, in Chrome or
 * Edge, the sound of a meeting tab) a minute at a time for transcription, and keeps a notes box open alongside.
 * Stopping has Dori write the summary and opens the meeting.
 */
export function MeetingRecorder() {
  const router = useRouter();
  const [detected, setDetected] = useState<Detected | null>(null);
  const [asking, setAsking] = useState<StartMeetingDetail | null>(null);
  const [withTab, setWithTab] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [open, setOpen] = useState(true);
  const [phase, setPhase] = useState<"idle" | "starting" | "live" | "finishing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [audioOn, setAudioOn] = useState(false); // the microphone is being recorded (not notes only, not stopped)

  // The recording machinery lives in refs: it must survive re-renders and be torn down exactly once.
  const rig = useRef<{
    streams: MediaStream[];
    ctx: AudioContext | null;
    dest: MediaStreamAudioDestinationNode | null;
    rec: MediaRecorder | null;
    timer: number | null;
    chunkAt: number; // elapsed ms when the current piece started
    activeMs: number; // recorded time before the current stretch
    since: number | null; // when the current stretch started (null while paused)
    queue: Promise<void>;
    lastStop: Promise<void>; // settles once the last stopped piece has been handed to the upload queue
    stopped: boolean;
  }>({ streams: [], ctx: null, dest: null, rec: null, timer: null, chunkAt: 0, activeMs: 0, since: null, queue: Promise.resolve(), lastStop: Promise.resolve(), stopped: true });
  const sessionRef = useRef<Session | null>(null);
  const mime = useRef("");

  const now = () => rig.current.activeMs + (rig.current.since ? Date.now() - rig.current.since : 0);

  // --- Noticing a meeting that is starting ---------------------------------------------------------------
  useEffect(() => {
    let stop = false;
    const check = async () => {
      if (stop || sessionRef.current || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/meetings/now");
        if (!res.ok) return;
        const d: { meeting: Detected | null } = await res.json();
        if (!d.meeting || readDismissed().includes(d.meeting.key)) return setDetected(null);
        setDetected(d.meeting);
      } catch {}
    };
    const first = window.setTimeout(check, 4000);
    const every = window.setInterval(check, POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      stop = true;
      window.clearTimeout(first);
      window.clearInterval(every);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  const dismiss = (key: string) => {
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([key, ...readDismissed()].slice(0, 30)));
    } catch {}
    setDetected(null);
  };

  // Started from elsewhere in the dashboard.
  useEffect(() => {
    const onStart = (e: Event) => {
      if (sessionRef.current) return;
      setError(null);
      setAsking((e as CustomEvent<StartMeetingDetail>).detail ?? {});
    };
    window.addEventListener(START_MEETING, onStart);
    return () => window.removeEventListener(START_MEETING, onStart);
  }, []);

  // --- Uploading pieces --------------------------------------------------------------------------------------
  const upload = useCallback((blob: Blob, offsetSec: number) => {
    const s = sessionRef.current;
    if (!s || blob.size < 2000) return; // a fraction of a second: nothing worth sending
    rig.current.queue = rig.current.queue.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const form = new FormData();
        form.append("audio", blob, `piece.${blob.type.includes("mp4") ? "m4a" : "webm"}`);
        form.append("offset", String(Math.round(offsetSec)));
        try {
          const res = await fetch(`/api/meetings/${s.id}/audio`, { method: "POST", body: form });
          const d = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
          if (res.ok) {
            if (d.text) setLines((l) => [...l.slice(-200), d.text!]);
            return;
          }
          if (res.status === 409 || res.status === 429) {
            setWarning(d.error ?? "Recording stopped. Your notes still save.");
            stopAudio();
            return;
          }
          if (attempt === 1) setWarning(d.error ?? "A minute couldn't be transcribed.");
        } catch {
          if (attempt === 1) setWarning("A minute couldn't be sent. Check the connection.");
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    });
    // stopAudio is stable (refs only); listing it would reorder the declarations for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPiece = useCallback(() => {
    const r = rig.current;
    if (!r.dest || r.stopped) return;
    const rec = new MediaRecorder(r.dest.stream, mime.current ? { mimeType: mime.current, audioBitsPerSecond: 32_000 } : undefined);
    const parts: Blob[] = [];
    const offset = now() / 1000;
    r.chunkAt = now();
    let handed = () => {};
    const stopped = new Promise<void>((resolve) => (handed = resolve));
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = () => {
      upload(new Blob(parts, { type: rec.mimeType || mime.current || "audio/webm" }), offset);
      handed();
    };
    rec.start();
    r.rec = rec;
    r.lastStop = stopped;
    // Each piece is its own file (a recorder's later slices can't be read alone), so restart every minute.
    r.timer = window.setTimeout(() => {
      if (r.rec === rec && rec.state === "recording") {
        rec.stop();
        startPiece();
      }
    }, CHUNK_MS);
  }, [upload]);

  const endPiece = () => {
    const r = rig.current;
    if (r.timer) window.clearTimeout(r.timer);
    r.timer = null;
    if (r.rec && r.rec.state !== "inactive") r.rec.stop();
    r.rec = null;
  };

  function stopAudio() {
    const r = rig.current;
    r.stopped = true;
    setAudioOn(false);
    endPiece();
    if (r.since) r.activeMs += Date.now() - r.since;
    r.since = null;
    r.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    r.streams = [];
    void r.ctx?.close().catch(() => {});
    r.ctx = null;
    r.dest = null;
  }

  // --- Starting ----------------------------------------------------------------------------------------------
  const begin = async (record: boolean) => {
    const req = asking ?? {};
    setPhase("starting");
    setError(null);
    setWarning(null);
    const r = rig.current;
    try {
      if (record) {
        mime.current = pickMime();
        if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't record. Use notes only, or try Chrome, Edge or Safari.");
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).catch(() => {
          throw new Error("Midore can't use the microphone. Allow it in the browser's site settings, or use notes only.");
        });
        r.streams = [mic];
        if (withTab && canShareTab()) {
          // Chrome and Edge share a tab's sound only together with its picture; the picture is dropped at once.
          const tab = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).catch(() => null);
          if (tab) {
            tab.getVideoTracks().forEach((t) => t.stop());
            if (tab.getAudioTracks().length) r.streams.push(tab);
            else setWarning("No meeting sound was shared (tick \"Share tab audio\" next time). Recording your microphone only.");
          }
        }
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        for (const s of r.streams) if (s.getAudioTracks().length) ctx.createMediaStreamSource(s).connect(dest);
        r.ctx = ctx;
        r.dest = dest;
      }
      const res = await fetch("/api/meetings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: req.title, eventKey: req.eventKey, record }) });
      const d = (await res.json().catch(() => ({}))) as { id?: number; title?: string; error?: string };
      if (!res.ok || !d.id) throw new Error(d.error ?? "Couldn't start the meeting.");
      const s = { id: d.id, title: d.title ?? req.title ?? "Meeting", recorded: record };
      sessionRef.current = s;
      setSession(s);
      setLines([]);
      setNotes("");
      setElapsed(0);
      setPaused(false);
      setOpen(true);
      r.activeMs = 0;
      r.since = Date.now();
      r.queue = Promise.resolve();
      r.stopped = !record;
      setAudioOn(record);
      if (record) startPiece();
      if (req.eventKey) dismiss(req.eventKey);
      setAsking(null);
      setPhase("live");
    } catch (e) {
      stopAudio();
      setError((e as Error).message);
      setPhase("idle");
    }
  };

  // The clock.
  useEffect(() => {
    if (!session) return;
    const t = window.setInterval(() => setElapsed(now()), 1000);
    return () => window.clearInterval(t);
  }, [session]);

  // Notes save a couple of seconds after typing stops.
  const savedNotes = useRef("");
  useEffect(() => {
    if (!session || notes === savedNotes.current) return;
    const t = window.setTimeout(() => {
      savedNotes.current = notes;
      void fetch(`/api/meetings/${session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }) }).catch(() => {});
    }, 2000);
    return () => window.clearTimeout(t);
  }, [notes, session]);

  // Leaving the page would lose the minute in progress.
  useEffect(() => {
    if (!session) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [session]);

  const pause = () => {
    const r = rig.current;
    if (!session?.recorded || r.stopped) return;
    if (!paused) {
      endPiece();
      if (r.since) r.activeMs += Date.now() - r.since;
      r.since = null;
      setPaused(true);
    } else {
      r.since = Date.now();
      startPiece();
      setPaused(false);
    }
  };

  const finish = async () => {
    const s = sessionRef.current;
    if (!s) return;
    setPhase("finishing");
    stopAudio();
    // The recorder hands over its last piece asynchronously; wait for that, then for every upload to finish.
    await Promise.race([rig.current.lastStop, new Promise((r) => setTimeout(r, 3000))]);
    await rig.current.queue;
    await fetch(`/api/meetings/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }) }).catch(() => {});
    const res = await fetch(`/api/meetings/${s.id}/finish`, { method: "POST" }).catch(() => null);
    const d = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    sessionRef.current = null;
    setSession(null);
    setPhase("idle");
    setWarning(null);
    if (d?.error) setError(d.error);
    router.push(`/dashboard/meetings/${s.id}`, { scroll: false });
    router.refresh();
  };

  // --- What shows ------------------------------------------------------------------------------------------
  const startDialog = asking && (
    <div className="pointer-events-auto w-full max-w-sm rounded-xl border border-line bg-modal p-4 shadow-(--shadow-modal)" role="dialog" aria-label="Start meeting notes">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{asking.title ? `Notes for ${asking.title}` : "Meeting notes"}</p>
          <p className="mt-1 text-xs text-muted">
            Recording transcribes what&apos;s said a minute at a time; the audio itself isn&apos;t kept. Let everyone know you&apos;re recording.
          </p>
        </div>
        <button type="button" className="btn-ghost -mt-1 -mr-1 p-1.5" onClick={() => setAsking(null)} aria-label="Cancel">
          <X size={16} />
        </button>
      </div>
      {canShareTab() && (
        <label className="mt-3 flex items-start gap-2 text-xs text-muted">
          <input type="checkbox" className="mt-0.5" checked={withTab} onChange={(e) => setWithTab(e.target.checked)} />
          <span>
            Also record the meeting&apos;s sound from a browser tab (Meet, Zoom or Teams on the web). Pick the tab and tick &ldquo;Share tab audio&rdquo;.
          </span>
        </label>
      )}
      {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary text-sm" disabled={phase === "starting"} onClick={() => begin(true)}>
          {phase === "starting" ? <Loader2 size={15} className="animate-spin" /> : <Mic size={15} />} Record
        </button>
        <button type="button" className="btn-ghost text-sm" disabled={phase === "starting"} onClick={() => begin(false)}>
          <NotebookPen size={15} /> Notes only
        </button>
      </div>
    </div>
  );

  return (
    <div className="pointer-events-none fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-4 z-40 flex w-[min(24rem,calc(100vw-7rem))] flex-col gap-2 sm:left-6">
      {!session && !asking && detected && (
        <div className="pointer-events-auto rounded-xl border border-line bg-modal p-3 shadow-(--shadow-modal)" role="status">
          <p className="text-sm text-ink">
            <strong>{detected.title}</strong> is starting.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary py-1.5 text-sm" onClick={() => setAsking({ title: detected.title, eventKey: detected.key })}>
              <Mic size={14} /> Take notes
            </button>
            {detected.link && (
              <a href={detected.link} target="_blank" rel="noreferrer" className="btn-ghost py-1.5 text-sm">
                Join
              </a>
            )}
            <button type="button" className="btn-ghost ml-auto py-1.5 text-sm" onClick={() => dismiss(detected.key)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {!session && startDialog}
      {!session && !asking && error && (
        <div className="pointer-events-auto flex items-start gap-2 rounded-xl border border-line bg-modal p-3 text-sm text-danger shadow-(--shadow-modal)" role="alert">
          <span className="flex-1">{error}</span>
          <button type="button" className="btn-ghost p-1" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
      {session && (
        <section className="pointer-events-auto overflow-hidden rounded-xl border border-line bg-modal shadow-(--shadow-modal)" aria-label="Meeting in progress">
          <div className="flex items-center gap-2 px-3 py-2">
            {audioOn ? (
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${paused ? "bg-faint" : "bg-vermilion motion-safe:animate-pulse"}`} aria-hidden />
            ) : (
              <NotebookPen size={14} className="shrink-0 text-muted" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={session.title}>
              {session.title}
            </span>
            <span className="text-xs text-muted tabular-nums" aria-label="Time">{clock(elapsed)}</span>
            {audioOn && (
              <button type="button" className="btn-ghost p-1.5" onClick={pause} disabled={phase === "finishing"} aria-label={paused ? "Resume recording" : "Pause recording"} title={paused ? "Resume" : "Pause"}>
                {paused ? <Play size={15} /> : <Pause size={15} />}
              </button>
            )}
            <button type="button" className="btn-ghost p-1.5" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Hide notes" : "Show notes"}>
              {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
            </button>
            <button type="button" className="btn-primary px-2.5 py-1.5 text-xs" onClick={finish} disabled={phase === "finishing"}>
              {phase === "finishing" ? <Loader2 size={14} className="animate-spin" /> : <Square size={12} />} {phase === "finishing" ? "Writing notes…" : "Stop"}
            </button>
          </div>
          {open && (
            <div className="border-t border-line px-3 py-2">
              {session.recorded && (
                <div className="mb-2 max-h-32 overflow-y-auto text-xs leading-relaxed text-muted">
                  {lines.length ? lines.slice(-6).map((l, i) => <p key={i}>{l}</p>) : <p className="text-faint">The transcript appears here a minute at a time.</p>}
                </div>
              )}
              <label className="sr-only" htmlFor="meeting-notes">Your notes</label>
              <textarea
                id="meeting-notes"
                className="input min-h-24 w-full resize-y text-sm"
                placeholder="Your notes: decisions, who does what…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              {warning && <p className="mt-1 text-xs text-warning" role="status">{warning}</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
