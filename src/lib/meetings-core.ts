/**
 * The pure part of meeting notes: transcript lines, which calendar event is a meeting starting now, and what goes
 * to the model for the summary. Unit tested; the database side is in meetings.ts.
 */

/** 75 → "01:15"; 3725 → "1:02:05". */
export function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Add one transcribed piece, starting `offset` seconds into the meeting. Empty pieces (silence) add nothing. */
export function appendLine(transcript: string, offset: number, text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return transcript;
  return `${transcript}${transcript ? "\n" : ""}[${stamp(offset)}] ${t}`;
}

type Ev = { id: string; seriesId?: string; accountId: number; title: string; start: string; end: string; allDay: boolean; meetLink?: string; attendees: unknown[]; myResponse?: string };

/**
 * The meeting starting about now, to offer recording: a timed event with other people or a video link, that the
 * user hasn't declined, from two minutes before its start to ten minutes after. The latest start wins.
 */
export function meetingStartingNow<T extends Ev>(events: T[], now: number): T | null {
  const fits = events.filter((e) => {
    if (e.allDay || e.myResponse === "declined") return false;
    if (!e.meetLink && e.attendees.length < 2) return false;
    const start = Date.parse(e.start);
    return now >= start - 2 * 60_000 && now <= start + 10 * 60_000 && now < Date.parse(e.end);
  });
  return fits.sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0] ?? null;
}

/** A long transcript keeps its start and end for the summary; the middle is cut with a marker. */
export function forModel(transcript: string, max = 120_000): string {
  if (transcript.length <= max) return transcript;
  const half = Math.floor(max / 2);
  return `${transcript.slice(0, half)}\n[… ${Math.round((transcript.length - max) / 1000)}k characters of the middle left out …]\n${transcript.slice(-half)}`;
}
