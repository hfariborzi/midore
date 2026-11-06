"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock, CalendarPlus, CalendarX, Check, CircleDashed, FileText, Image as ImageIcon, Loader2, Mail, Mic, Paperclip, Send, Square, Trash2, Undo2, Video, Volume2, VolumeX, X } from "lucide-react";
import type { DoriCard, DoriMeta, DoriMood, DoriProposal } from "@/db/schema";
import { Dori } from "@/components/Dori";
import { acceptDoriProposal, clearDoriConversation, confirmDoriBookingCancel, confirmDoriDeleteArea, confirmDoriRsvp, confirmDoriEvent, confirmDoriEventChange, discardDoriProposal, dismissDoriEvent, setDoriEnabled, undoDoriMessage } from "./dori-actions";

type Msg = { id: number; role: "user" | "assistant"; content: string; meta: DoriMeta };
type CheckInTime = { id: string; at: string; weekdays: number[] };
type State = { available: boolean; enabled: boolean; name: string; voice: boolean; news: number; briefAt: string | null; checkIns?: CheckInTime[]; messages: Msg[] };
const BRIEF_KEY = "midore:dori-brief"; // the last day the morning brief opened Dori here
const CHECKIN_KEY = "midore:dori-checkin"; // the last check-in (id and day) that opened Dori here

/** Other parts of the dashboard open Dori with this event, optionally with text to send or to prefill. */
export const OPEN_DORI = "doorcal:open-dori";
/** Fired after Dori changed tasks or the plan, so the calendar and task views reload. */
export const DORI_CHANGED = "doorcal:dori-changed";
export type OpenDoriDetail = { send?: string; prefill?: string; mode?: "day" | "week" };
/** Fired after the user changed a task, so Dori checks for anything a rule had her say ("tell me what's next"). */
export const TASKS_CHANGED = "midore:tasks-changed";
/** The top bar's Dori button sends this to open or close the panel. */
export const TOGGLE_DORI = "midore:toggle-dori";
/** The panel reports whether it is open and whether Dori has news, so the top bar can show it. */
export const DORI_STATUS = "midore:dori-status";
export type DoriStatusDetail = { open: boolean; news: boolean };
const OPEN_KEY = "dori-open";

const SPEAK_KEY = "dori-speak";

function readSpeak() {
  try {
    return localStorage.getItem(SPEAK_KEY) === "1";
  } catch {
    return false;
  }
}

let playing: HTMLAudioElement | null = null;

function stopSpeaking() {
  playing?.pause();
  playing = null;
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
}

/** Read a reply aloud with Dori's voice (ElevenLabs through the server), or the browser's voice as a fallback. */
async function speak(text: string, lang: string | undefined, natural: boolean) {
  stopSpeaking();
  if (natural) {
    try {
      const res = await fetch("/api/dori/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 2500), lang }) });
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        playing = audio;
        await audio.play();
        return;
      }
    } catch {
      // fall back to the browser's voice
    }
  }
  browserSpeak(text, lang);
}

function browserSpeak(text: string, lang?: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text.replace(/•/g, ""));
  if (lang) {
    u.lang = lang;
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)));
    if (voice) u.voice = voice;
  }
  window.speechSynthesis.speak(u);
}

type SpeechRecognitionLike = { lang: string; interimResults: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
function browserRecognizer(): SpeechRecognitionLike | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return C ? new C() : null;
}

export function DoriPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<{ mood: DoriMood; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The header with this toggle only renders after the panel is opened, so reading storage here is safe.
  const [speakOn, setSpeakOn] = useState(() => typeof window !== "undefined" && readSpeak());
  const [recording, setRecording] = useState<"idle" | "recording" | "transcribing">("idle");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<{ stop: () => void } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Attached[]>([]);
  const addFiles = useCallback(async (list: File[]) => {
    setError(null);
    for (const f of list) {
      try {
        const item = await readAttachment(f);
        setFiles((cur) => (cur.length >= MAX_FILES ? cur : [...cur, item]));
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }, []);
  const voiceRef = useRef(false); // natural voice (OpenRouter) available
  const restored = useRef(false); // the remembered open state has been read

  const load = useCallback(async () => {
    const res = await fetch("/api/dori/messages");
    if (res.ok) setState(await res.json());
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dori/messages")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: State | null) => {
        if (cancelled || !d) return;
        voiceRef.current = d.voice;
        setState(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Messages a rule posted (after a task is finished, or from a phone): fetched when a task changes here and
  // when the tab comes back. On wide screens Dori opens with them; otherwise her badge shows.
  const [ruleNews, setRuleNews] = useState(false);
  const stateRef = useRef(state);
  const busyRef = useRef(false);
  const openRef = useRef(open);
  useEffect(() => {
    stateRef.current = state;
    busyRef.current = !!busy;
    openRef.current = open;
  }, [state, busy, open]);
  useEffect(() => {
    let running = false;
    const check = async () => {
      const cur = stateRef.current;
      if (running || busyRef.current || !cur?.enabled) return;
      const last = Math.max(0, ...cur.messages.map((m) => m.id));
      running = true;
      try {
        const res = await fetch(`/api/dori/messages?after=${last}`);
        if (!res.ok) return;
        const d: { messages: Msg[] } = await res.json();
        if (!d.messages.length || busyRef.current) return;
        setState((s) => (s ? { ...s, messages: [...s.messages, ...d.messages.filter((m) => !s.messages.some((x) => x.id === m.id))] } : s));
        if (d.messages.some((m) => m.meta.fromRule) && !openRef.current) {
          if (window.innerWidth >= 768) setOpen(true);
          else setRuleNews(true);
        }
      } catch {
      } finally {
        running = false;
      }
    };
    const soon = () => window.setTimeout(check, 400);
    const onVisible = () => document.visibilityState === "visible" && check();
    window.addEventListener(TASKS_CHANGED, soon);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(TASKS_CHANGED, soon);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [state?.messages.length, busy, open]);

  const send = useCallback(
    async (text: string, mode: "chat" | "day" | "week" | "checkin" = "chat", attachments: Attached[] = []) => {
      if (busy || (!text.trim() && !attachments.length && mode === "chat")) return;
      setError(null);
      setInput("");
      setFiles([]);
      if (inputRef.current) inputRef.current.style.height = "";
      const note = attachments.length ? `(attached: ${attachments.map((a) => a.name).join(", ")})` : "";
      const optimistic: Msg = { id: -Date.now(), role: "user", content: mode === "day" ? "Day plan" : mode === "week" ? "Week plan" : mode === "checkin" ? "Check-in" : [text.trim(), note].filter(Boolean).join("\n"), meta: {} };
      setState((s) => (s ? { ...s, messages: [...s.messages, optimistic] } : s));
      setBusy({ mood: "thinking", text: "Thinking" });
      try {
        const res = await fetch("/api/dori/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, mode, attachments }) });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Dori couldn't answer just now.");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const ev = JSON.parse(line) as { type: string; mood?: DoriMood; text?: string; id?: number; meta?: DoriMeta };
            if (ev.type === "status") setBusy({ mood: ev.mood ?? "thinking", text: ev.text ?? "" });
            else if (ev.type === "error") setError(ev.text ?? "Something went wrong.");
            else if (ev.type === "reply") {
              const reply: Msg = { id: ev.id!, role: "assistant", content: ev.text ?? "", meta: ev.meta ?? {} };
              setState((s) => (s ? { ...s, news: 0, messages: [...s.messages, reply] } : s));
              if (readSpeak()) void speak(reply.content, reply.meta.lang, !!voiceRef.current);
              if (reply.meta.actions?.length) {
                window.dispatchEvent(new Event(DORI_CHANGED));
                router.refresh();
              }
            }
          }
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [busy, router],
  );

  // The morning brief: the first time Midore is open after the brief time, Dori opens with the day plan.
  useEffect(() => {
    if (!state?.enabled || !state.briefAt || busy) return;
    const now = new Date();
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const [h, m] = state.briefAt.split(":").map(Number);
    const since = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
    if (since < 0 || since > 7 * 60) return; // only in the hours after the brief time
    try {
      if (localStorage.getItem(BRIEF_KEY) === today) return;
      localStorage.setItem(BRIEF_KEY, today);
    } catch {
      return; // without storage it would repeat on every visit
    }
    const id = requestAnimationFrame(() => {
      setOpen(true);
      void send("", "day");
    });
    return () => cancelAnimationFrame(id);
  }, [state?.enabled, state?.briefAt, busy, send]);

  // Check-ins (a Sunday review, an end-of-day wrap-up): the first time Midore is open in the 3 hours after one,
  // Dori opens with it. The morning brief takes the morning; a check-in never runs twice.
  useEffect(() => {
    if (!state?.enabled || !state.checkIns?.length || busy) return;
    const now = new Date();
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const weekday = ((now.getDay() + 6) % 7) + 1;
    const mins = now.getHours() * 60 + now.getMinutes();
    const due = state.checkIns.find((c) => {
      const [h, m] = c.at.split(":").map(Number);
      const since = mins - (h * 60 + m);
      return (!c.weekdays.length || c.weekdays.includes(weekday)) && since >= 0 && since <= 3 * 60;
    });
    if (!due) return;
    try {
      if (localStorage.getItem(CHECKIN_KEY) === `${due.id}:${today}`) return;
      localStorage.setItem(CHECKIN_KEY, `${due.id}:${today}`);
    } catch {
      return;
    }
    const id = requestAnimationFrame(() => {
      setOpen(true);
      void send(due.id, "checkin");
    });
    return () => cancelAnimationFrame(id);
  }, [state?.enabled, state?.checkIns, busy, send]);

  // The panel stays docked across visits on wide screens if it was open last time.
  useEffect(() => {
    const reopen = requestAnimationFrame(() => {
      try {
        if (localStorage.getItem(OPEN_KEY) === "1" && window.innerWidth >= 768) setOpen(true);
      } catch {}
      restored.current = true;
    });
    const onToggle = () => {
      setRuleNews(false);
      setOpen((o) => !o);
    };
    window.addEventListener(TOGGLE_DORI, onToggle);
    return () => {
      cancelAnimationFrame(reopen);
      window.removeEventListener(TOGGLE_DORI, onToggle);
    };
  }, []);
  useEffect(() => {
    try {
      if (restored.current) localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {}
    window.dispatchEvent(new CustomEvent<DoriStatusDetail>(DORI_STATUS, { detail: { open, news: !!state?.news || ruleNews } }));
  }, [open, state?.news, ruleNews]);

  // Open from anywhere: buttons elsewhere dispatch OPEN_DORI.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<OpenDoriDetail>).detail ?? {};
      setOpen(true);
      if (d.prefill) {
        setInput(d.prefill);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      if (d.mode) void send("", d.mode);
      else if (d.send) void send(d.send);
    };
    window.addEventListener(OPEN_DORI, onOpen);
    return () => window.removeEventListener(OPEN_DORI, onOpen);
  }, [send]);

  async function startVoice() {
    setError(null);
    if (state?.voice && typeof MediaRecorder !== "undefined") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        const started = Date.now();
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          setRecording("transcribing");
          const form = new FormData();
          form.append("audio", new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
          form.append("seconds", String(Math.round((Date.now() - started) / 1000)));
          const res = await fetch("/api/dori/transcribe", { method: "POST", body: form });
          const data = await res.json().catch(() => ({}));
          setRecording("idle");
          if (!res.ok) return setError(data.error || "Couldn't hear that.");
          if (data.text) void send(data.text);
        };
        rec.start();
        recorderRef.current = { stop: () => rec.state !== "inactive" && rec.stop() };
        setRecording("recording");
        setTimeout(() => recorderRef.current?.stop(), 120_000);
      } catch {
        setError("Allow microphone access to talk to Dori.");
      }
      return;
    }
    const r = browserRecognizer();
    if (!r) return setError("Voice isn't supported in this browser. Typing works everywhere.");
    const lastLang = [...(state?.messages ?? [])].reverse().find((m) => m.meta.lang)?.meta.lang;
    r.lang = lastLang ?? navigator.language;
    r.interimResults = false;
    r.onresult = (e) => {
      const text = Array.from(e.results).map((x) => x[0].transcript).join(" ");
      if (text.trim()) void send(text);
    };
    r.onend = () => setRecording("idle");
    r.onerror = () => setRecording("idle");
    r.start();
    recorderRef.current = { stop: () => r.stop() };
    setRecording("recording");
  }

  const lastMood = [...(state?.messages ?? [])].reverse().find((m) => m.role === "assistant")?.meta.mood;
  const hour = new Date().getHours();
  const mood: DoriMood = busy?.mood ?? (hour < 6 || hour >= 22 ? "sleeping" : (lastMood ?? "happy"));
  const canVoice = typeof window !== "undefined" && (state?.voice || !!browserRecognizer());

  return (
    <>
      {/* Dori is always on screen, bottom right, playing her idle loop. She sits beside the docked panel on wide
          screens; on phones the open panel covers the screen, so she steps aside. */}
      <button
        type="button"
        onClick={() => {
          setRuleNews(false);
          setOpen(!open);
        }}
        className={`fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 grid h-[72px] w-[72px] place-items-center rounded-full border border-line bg-surface shadow-(--shadow-modal) transition hover:-translate-y-0.5 ${
          open ? "right-4 hidden md:right-[416px] md:grid" : "right-4 sm:right-6 sm:bottom-6"
        }`}
        aria-label={open ? "Close Dori" : "Open Dori, your assistant"}
        aria-expanded={open}
        title="Dori"
      >
        <Dori mood="happy" size={60} live />
        {(!!state?.news || ruleNews) && !open && <span className="absolute top-1 right-1 h-3 w-3 rounded-full border-2 border-surface bg-amber" aria-label="News from Dori" />}
      </button>

      {open && (
        <aside className="fixed inset-0 z-50 flex flex-col border-line bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:static md:pt-0 md:pb-0 md:z-auto md:w-[400px] md:shrink-0 md:border-l" aria-label="Dori">
          <header className="flex items-center gap-3 border-b border-line px-4 py-3">
            <Dori mood={mood} size={44} live />
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-ink">Dori</div>
              <div className="truncate text-xs text-faint">{busy ? `${busy.text}…` : state?.enabled ? "Your assistant" : "Your assistant, off"}</div>
            </div>
            {state?.enabled && (
              <>
                <button
                  type="button"
                  className="btn-ghost p-2"
                  title={speakOn ? "Stop reading answers aloud" : "Read answers aloud"}
                  aria-label={speakOn ? "Stop reading answers aloud" : "Read answers aloud"}
                  onClick={() => {
                    const next = !speakOn;
                    setSpeakOn(next);
                    try {
                      localStorage.setItem(SPEAK_KEY, next ? "1" : "0");
                    } catch {}
                    if (!next) stopSpeaking();
                  }}
                >
                  {speakOn ? <Volume2 size={17} /> : <VolumeX size={17} />}
                </button>
                <button
                  type="button"
                  className="btn-ghost p-2"
                  title="Clear the conversation"
                  aria-label="Clear the conversation"
                  onClick={async () => {
                    if (!confirm("Clear the conversation with Dori? Your tasks stay as they are.")) return;
                    await clearDoriConversation();
                    await load();
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </>
            )}
            <button type="button" className="btn-ghost p-2" onClick={() => setOpen(false)} aria-label="Close Dori">
              <X size={18} />
            </button>
          </header>

          {!state ? (
            <div className="grid flex-1 place-items-center text-faint"><Loader2 className="animate-spin" /></div>
          ) : !state.available ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted">
              <Dori mood="sleeping" size={110} />
              Dori needs an AI provider, which this Midore instance hasn&apos;t set up. Tasks and planning still work.
            </div>
          ) : !state.enabled ? (
            <Consent onEnabled={load} />
          ) : (
            <>
              <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
                {state.messages.length === 0 && (
                  <div className="flex flex-col items-center gap-3 py-6 text-center">
                    <Dori mood="happy" size={110} live />
                    <p className="max-w-xs text-sm leading-relaxed text-muted">
                      Hi {state.name}! Tell me everything on your plate, in any order and any language. I&apos;ll sort it into
                      areas, projects and tasks, and keep your week realistic from then on.
                    </p>
                  </div>
                )}
                {state.messages.map((m) => (
                  <Message key={m.id} m={m} onListen={() => void speak(m.content, m.meta.lang, state.voice)} onChanged={async () => { await load(); window.dispatchEvent(new Event(DORI_CHANGED)); router.refresh(); }} />
                ))}
                {busy && (
                  <div className="flex items-center gap-2 text-sm text-faint"><Loader2 size={14} className="animate-spin" /> {busy.text}…</div>
                )}
                {error && <p className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
              </div>

              <div className="border-t border-line px-3 pt-2.5 pb-3">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <Quick onClick={() => send("", "day")} disabled={!!busy}>Day plan</Quick>
                  <Quick onClick={() => send("", "week")} disabled={!!busy}>Week plan</Quick>
                  <Quick onClick={() => { setInput("Here's everything on my plate: "); inputRef.current?.focus(); }} disabled={!!busy}>Brain dump</Quick>
                </div>
                {files.length > 0 && (
                  <ul className="mb-2 flex flex-wrap gap-1.5">
                    {files.map((f, i) => (
                      <li key={i} className="flex max-w-full items-center gap-1.5 rounded-md border border-line bg-paper px-2 py-1 text-xs text-muted">
                        {f.kind === "pdf" ? <FileText size={13} /> : <ImageIcon size={13} />}
                        <span className="max-w-40 truncate">{f.name}</span>
                        <button type="button" aria-label={`Remove ${f.name}`} className="text-faint hover:text-ink" onClick={() => setFiles((list) => list.filter((_, j) => j !== i))}><X size={12} /></button>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send(input, "chat", files);
                  }}
                >
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*,application/pdf"
                    multiple
                    hidden
                    onChange={(e) => {
                      void addFiles([...(e.target.files ?? [])]);
                      e.target.value = "";
                    }}
                  />
                  <button type="button" className="btn-ghost h-10 w-8 shrink-0 p-0" onClick={() => fileRef.current?.click()} disabled={!!busy || files.length >= MAX_FILES} aria-label="Attach a photo or PDF" title="Attach a photo or PDF">
                    <Paperclip size={17} />
                  </button>
                  <textarea
                    ref={inputRef}
                    rows={1}
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send(input, "chat", files);
                      }
                    }}
                    onPaste={(e) => {
                      const pasted = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/") || f.type === "application/pdf");
                      if (pasted.length) {
                        e.preventDefault();
                        void addFiles(pasted);
                      }
                    }}
                    placeholder="Tell Dori anything…"
                    dir="auto"
                    className="input max-h-40 min-h-10 resize-none py-2.5"
                    maxLength={8000}
                    disabled={!!busy}
                  />
                  {canVoice && (
                    <button
                      type="button"
                      className={`btn h-10 w-10 shrink-0 p-0 ${recording === "recording" ? "bg-danger text-white" : "btn-secondary"}`}
                      onClick={() => (recording === "recording" ? recorderRef.current?.stop() : startVoice())}
                      disabled={!!busy || recording === "transcribing"}
                      aria-label={recording === "recording" ? "Stop recording" : "Talk to Dori"}
                      title={recording === "recording" ? "Stop" : "Talk"}
                    >
                      {recording === "transcribing" ? <Loader2 size={16} className="animate-spin" /> : recording === "recording" ? <Square size={14} /> : <Mic size={17} />}
                    </button>
                  )}
                  <button type="submit" className="btn-primary h-10 w-10 shrink-0 p-0" disabled={!!busy || (!input.trim() && !files.length)} aria-label="Send">
                    <Send size={16} />
                  </button>
                </form>
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}

type Attached = { kind: "image" | "pdf"; name: string; dataUrl: string };
const MAX_FILES = 3;
const MAX_PDF_BYTES = 2_500_000;
const MAX_IMAGE_SIDE = 1600;

/** A photo is shrunk to at most 1600 px and sent as JPEG; a PDF is sent as is, up to 2.5 MB. */
async function readAttachment(file: File): Promise<Attached> {
  const name = file.name || (file.type === "application/pdf" ? "document.pdf" : "photo");
  if (file.type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) throw new Error("That PDF is too big. Try one under 2.5 MB, or a photo of the page.");
    return { kind: "pdf", name, dataUrl: await new Promise<string>((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => fail(new Error("Couldn't read that file."));
      r.readAsDataURL(file);
    }) };
  }
  if (!file.type.startsWith("image/")) throw new Error("Dori can read photos and PDFs.");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Couldn't open that image.");
  });
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { kind: "image", name, dataUrl: canvas.toDataURL("image/jpeg", 0.85) };
}

function Quick({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded-md border border-line bg-surface px-3 py-1 text-xs font-medium text-muted hover:border-ink/40 hover:text-ink disabled:opacity-50">
      {children}
    </button>
  );
}

function Consent({ onEnabled }: { onEnabled: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-8 text-center">
      <Dori mood="happy" size={120} live />
      <h2 className="mt-3 text-lg font-semibold">Meet Dori</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Dori sorts everything you tell her into areas, projects and tasks, plans them around your calendar, and
        answers questions like &ldquo;when can I meet Sam next week?&rdquo;
      </p>
      <div className="mt-5 rounded-xl border border-line bg-paper p-4 text-left text-xs leading-relaxed text-muted">
        <p className="font-medium text-ink">What turning her on means</p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>Your messages, your areas, projects and tasks, and the titles and times of your events for the coming week go to an AI model through OpenRouter, to OpenAI or Microsoft Azure OpenAI only, with zero data retention and no training on your data.</li>
          <li>Attendee names and emails, event descriptions and locations are never sent.</li>
          <li>If you talk to Dori or have her read answers aloud, your recording and her reply go through OpenRouter to ElevenLabs, on zero-data-retention endpoints only: not stored and not used for training.</li>
          <li>Turning Dori off deletes the conversation and the notes she kept.</li>
        </ul>
        <p className="mt-2">Details in the <Link href="/privacy" className="link">privacy policy</Link>.</p>
      </div>
      <button
        type="button"
        className="btn-primary mt-5"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          await setDoriEnabled(true);
          onEnabled();
        }}
      >
        {pending ? <Loader2 size={16} className="animate-spin" /> : null} Turn on Dori
      </button>
    </div>
  );
}

function Message({ m, onChanged, onListen }: { m: Msg; onChanged: () => Promise<void>; onListen: () => void }) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<{ error?: string }>) => {
    setPending(true);
    setErr(null);
    const r = await fn();
    if (r.error) setErr(r.error);
    await onChanged();
    setPending(false);
  };

  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div dir="auto" className="max-w-[85%] rounded-lg bg-raised px-3.5 py-2.5 text-sm whitespace-pre-wrap text-ink">{m.content}</div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div dir="auto" className="max-w-[92%] rounded-lg bg-amber-subtle px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-ink shadow-[inset_3px_0_0_var(--color-amber)]" lang={m.meta.lang}>
        {m.content}
      </div>
      <button type="button" onClick={onListen} className="ml-1 inline-flex items-center gap-1 text-xs text-faint hover:text-ink" aria-label="Listen to this answer">
        <Volume2 size={12} /> Listen
      </button>
      {m.meta.actions?.length ? (
        <div className={`ml-1 space-y-0.5 text-xs ${m.meta.undone ? "text-faint line-through" : "text-muted"}`}>
          {m.meta.actions.slice(0, 12).map((a, i) => (
            <div key={i} className="flex items-start gap-1.5"><Check size={12} className="mt-0.5 shrink-0 text-accent-soft" /> {a}</div>
          ))}
          {m.meta.actions.length > 12 && <div className="pl-4">and {m.meta.actions.length - 12} more</div>}
          {m.meta.undoable && !m.meta.undone && (
            <button type="button" className="mt-1 inline-flex items-center gap-1 text-faint hover:text-ink" disabled={pending} onClick={() => act(() => undoDoriMessage(m.id))}>
              <Undo2 size={12} /> Undo
            </button>
          )}
          {m.meta.undone && <div className="no-underline">Undone</div>}
        </div>
      ) : null}
      {m.meta.proposal && <ProposalCard messageId={m.id} p={m.meta.proposal} onChanged={onChanged} />}
      {m.meta.cards?.map((c, i) => <Card key={i} card={c} index={i} messageId={m.id} act={act} pending={pending} />)}
      {err && <p className="text-xs text-danger">{err}</p>}
    </div>
  );
}

function Card({ card, index, messageId, act, pending }: { card: DoriCard; index: number; messageId: number; act: (fn: () => Promise<{ error?: string }>) => Promise<void>; pending: boolean }) {
  const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (card.kind === "emails")
    return (
      <div className="space-y-1.5 rounded-xl border border-line bg-paper p-3">
        <p className="text-xs text-faint">Opens your mail app. Nothing is sent until you send it.</p>
        {card.items.map((it, i) => (
          <a key={i} href={it.href} className="btn-secondary w-full justify-start py-1.5 text-xs">
            <Mail size={14} /> <span className="truncate">Email {it.count} {it.count === 1 ? "person" : "people"}: {it.label}</span>
          </a>
        ))}
      </div>
    );
  if (card.kind === "event")
    return (
      <div className="rounded-xl border border-line bg-paper p-3 text-sm">
        <div className="font-medium text-ink">{card.title}</div>
        <div className="text-xs text-muted">{fmt(card.start)} – {time(card.end)}{card.attendees.length ? ` · ${card.attendees.length} invited` : ""}</div>
        {(card.repeatLabel || card.onlineMeeting || card.calendarLabel || card.location) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-faint">
            {card.repeatLabel && <span>{card.repeatLabel}</span>}
            {card.onlineMeeting && <span className="inline-flex items-center gap-1"><Video size={12} /> Video link</span>}
            {card.location && <span className="truncate">{card.location}</span>}
            {card.calendarLabel && <span className="truncate">{card.calendarLabel}</span>}
          </div>
        )}
        {card.status === "pending" ? (
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary py-1 text-xs" disabled={pending} onClick={() => act(() => confirmDoriEvent(messageId, index))}><CalendarPlus size={14} /> Add to calendar</button>
            <button type="button" className="btn-ghost py-1 text-xs" disabled={pending} onClick={() => act(() => dismissDoriEvent(messageId, index))}>No thanks</button>
          </div>
        ) : (
          <div className="mt-1 text-xs text-faint">{card.status === "added" ? "Added to your calendar" : "Dismissed"}</div>
        )}
      </div>
    );
  if (card.kind === "event_change")
    return (
      <div className="rounded-xl border border-line bg-paper p-3 text-sm">
        <div className="font-medium text-ink">{card.title}</div>
        <div className="text-xs text-muted">
          {card.action === "move" && card.newStart && card.newEnd ? (
            <><span className="line-through">{fmt(card.start)}</span> → {fmt(card.newStart)} – {time(card.newEnd)}</>
          ) : (
            <>{fmt(card.start)} – {time(card.end)}</>
          )}
        </div>
        {card.status === "pending" ? (
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary py-1 text-xs" disabled={pending} onClick={() => act(() => confirmDoriEventChange(messageId, index))}>
              {card.action === "move" ? <><CalendarClock size={14} /> Move it</> : <><CalendarX size={14} /> Delete it</>}
            </button>
            <button type="button" className="btn-ghost py-1 text-xs" disabled={pending} onClick={() => act(() => dismissDoriEvent(messageId, index))}>Keep as is</button>
          </div>
        ) : (
          <div className="mt-1 text-xs text-faint">{card.status === "done" ? (card.action === "move" ? "Moved" : "Deleted") : "Left as it was"}</div>
        )}
      </div>
    );
  if (card.kind === "delete_area")
    return (
      <div className="rounded-xl border border-line bg-paper p-3 text-sm">
        <div className="font-medium text-ink">Delete the area &ldquo;{card.name}&rdquo;?</div>
        {card.status === "pending" ? (
          <>
            <p className="mt-1 text-xs text-faint">Its projects and tasks stay, with no area. Events labelled with it lose the label.</p>
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn-danger py-1 text-xs" disabled={pending} onClick={() => act(() => confirmDoriDeleteArea(messageId, index))}><Trash2 size={14} /> Delete area</button>
              <button type="button" className="btn-ghost py-1 text-xs" disabled={pending} onClick={() => act(() => dismissDoriEvent(messageId, index))}>Keep it</button>
            </div>
          </>
        ) : (
          <div className="mt-1 text-xs text-faint">{card.status === "done" ? "Deleted" : "Kept"}</div>
        )}
      </div>
    );
  if (card.kind === "rsvp") {
    const word = { accepted: "Accept", declined: "Decline", tentative: "Maybe" }[card.response];
    return (
      <div className="rounded-xl border border-line bg-paper p-3 text-sm">
        <div className="font-medium text-ink">{card.title}</div>
        <div className="text-xs text-muted">{fmt(card.start)} – {time(card.end)}</div>
        {card.comment && <p className="mt-1 text-xs text-faint">&ldquo;{card.comment}&rdquo;</p>}
        {card.status === "pending" ? (
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary py-1 text-xs" disabled={pending} onClick={() => act(() => confirmDoriRsvp(messageId, index))}>{word}</button>
            <button type="button" className="btn-ghost py-1 text-xs" disabled={pending} onClick={() => act(() => dismissDoriEvent(messageId, index))}>Not now</button>
          </div>
        ) : (
          <div className="mt-1 text-xs text-faint">{card.status === "done" ? `Sent: ${word.toLowerCase()}` : "Not sent"}</div>
        )}
      </div>
    );
  }
  if (card.kind === "booking_cancel")
    return (
      <div className="rounded-xl border border-line bg-paper p-3 text-sm">
        <div className="font-medium text-ink">{card.title} with {card.who}</div>
        <div className="text-xs text-muted">{fmt(card.start)} – {time(card.end)}</div>
        {card.status === "pending" ? (
          <>
            <p className="mt-1 text-xs text-faint">{card.who} gets a cancellation{card.reason ? `: "${card.reason}"` : "."}</p>
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn-primary py-1 text-xs" disabled={pending} onClick={() => act(() => confirmDoriBookingCancel(messageId, index))}><CalendarX size={14} /> Cancel booking</button>
              <button type="button" className="btn-ghost py-1 text-xs" disabled={pending} onClick={() => act(() => dismissDoriEvent(messageId, index))}>Keep it</button>
            </div>
          </>
        ) : (
          <div className="mt-1 text-xs text-faint">{card.status === "done" ? "Cancelled" : "Kept"}</div>
        )}
      </div>
    );
  if (card.kind === "slots" && card.items.length)
    return (
      <div className="space-y-1 rounded-xl border border-line bg-paper p-3 text-xs">
        {card.items.map((s, i) => (
          <div key={i} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-ink">{fmt(s.start)}</span>
            <span className="text-faint">{s.shifts.length ? `moves ${s.shifts.join(", ")}` : "free"}</span>
          </div>
        ))}
      </div>
    );
  return null;
}

function ProposalCard({ messageId, p, onChanged }: { messageId: number; p: DoriProposal; onChanged: () => Promise<void> }) {
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = (i: number) => setSkip((s) => {
    const n = new Set(s);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  });
  const done = p.status !== "pending";
  const groups: { title: string; items: number[] }[] = [];
  for (const pr of p.projects) groups.push({ title: pr.area ? `${pr.name} · ${pr.area}` : pr.name, items: p.tasks.map((t, i) => (t.project === pr.ref || t.project === pr.name ? i : -1)).filter((i) => i >= 0) });
  const claimed = new Set(groups.flatMap((g) => g.items));
  const loose = p.tasks.map((_, i) => i).filter((i) => !claimed.has(i));
  const byExisting = new Map<string, number[]>();
  const other: number[] = [];
  for (const i of loose) {
    const key = p.tasks[i].project || (p.tasks[i].area ? `${p.tasks[i].area}` : "");
    if (key) byExisting.set(key, [...(byExisting.get(key) ?? []), i]);
    else other.push(i);
  }
  for (const [k, items] of byExisting) groups.push({ title: k, items });
  if (other.length) groups.push({ title: "Other", items: other });
  const count = p.tasks.length - skip.size;

  return (
    <div className={`rounded-xl border border-line bg-paper p-3 text-sm ${done ? "opacity-70" : ""}`}>
      {p.areas.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-faint">New areas:</span>
          {p.areas.map((a) => <span key={a.name} className="rounded-full bg-hover px-2 py-0.5 text-muted">{a.name}</span>)}
        </div>
      )}
      <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
        {groups.filter((g) => g.items.length).map((g) => (
          <div key={g.title}>
            <div className="mb-1 text-xs font-semibold text-ink">{g.title}</div>
            {g.items.map((i) => {
              const t = p.tasks[i];
              return (
                <label key={i} className="flex items-start gap-2 py-0.5 text-xs text-muted">
                  <input type="checkbox" className="mt-0.5" checked={!skip.has(i)} disabled={done} onChange={() => toggle(i)} />
                  <span className={skip.has(i) ? "line-through" : ""}>
                    {t.title}
                    <span className="text-faint">
                      {t.kind === "reminder" ? " · reminder" : t.estimateMinutes ? ` · ${t.estimateMinutes >= 60 ? `${Math.round(t.estimateMinutes / 6) / 10} h` : `${t.estimateMinutes} min`}` : ""}
                      {t.dueDate ? ` · due ${t.dueDate}` : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        ))}
      </div>
      {done ? (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-faint">{p.status === "accepted" ? <><Check size={12} /> Created</> : <><CircleDashed size={12} /> Discarded</>}</div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className="btn-primary py-1.5 text-xs"
            disabled={pending || count === 0}
            onClick={async () => {
              setPending(true);
              setErr(null);
              const r = await acceptDoriProposal(messageId, [...skip]);
              if (r.error) setErr(r.error);
              await onChanged();
              setPending(false);
            }}
          >
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Create {count} task{count === 1 ? "" : "s"}
          </button>
          <button type="button" className="btn-ghost py-1.5 text-xs" disabled={pending} onClick={async () => { await discardDoriProposal(messageId); await onChanged(); }}>
            Discard
          </button>
        </div>
      )}
      {err && <p className="mt-1 text-xs text-danger">{err}</p>}
    </div>
  );
}
