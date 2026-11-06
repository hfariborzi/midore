import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, meetings } from "@/db";
import { audioFormat, speechAvailable, transcribe } from "@/lib/ai/audio";
import { getCurrentUser } from "@/lib/auth";
import { logError } from "@/lib/log";
import { appendLine } from "@/lib/meetings-core";
import { CHUNK_MAX_BYTES, getMeeting, MAX_MEETING_HOURS, meetingRoomLeft, recordMeetingSeconds } from "@/lib/meetings";
import { rateLimitKey, RateLimitError } from "@/lib/rate-limit";

export const maxDuration = 60;

/**
 * One piece of a meeting's audio (about a minute): transcribed through OpenRouter (ElevenLabs Scribe, zero data
 * retention) and added to the transcript. The audio itself is never stored.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const m = await getMeeting(user.id, Number((await params).id));
  if (!m) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (m.status !== "recording" || !m.recorded) return NextResponse.json({ error: "This meeting isn't recording." }, { status: 409 });
  if (Date.now() - m.startedAt.getTime() > MAX_MEETING_HOURS * 3600_000) return NextResponse.json({ error: `Recordings stop after ${MAX_MEETING_HOURS} hours.` }, { status: 409 });
  if (!speechAvailable()) return NextResponse.json({ error: "Recording isn't set up here." }, { status: 501 });
  try {
    await rateLimitKey(`meeting-audio:${user.id}`, 40, 600);
  } catch (err) {
    if (err instanceof RateLimitError) return NextResponse.json({ error: "Too many pieces at once." }, { status: 429 });
    throw err;
  }
  if (!(await meetingRoomLeft(user.id))) return NextResponse.json({ error: "That's all the recording for today; your notes still save." }, { status: 429 });

  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  const offset = Math.max(0, Number(form?.get("offset")) || 0);
  if (!(audio instanceof Blob) || audio.size === 0) return NextResponse.json({ text: "" });
  if (audio.size > CHUNK_MAX_BYTES) return NextResponse.json({ error: "That piece is too large." }, { status: 413 });
  const format = audioFormat(audio.type || "audio/webm");
  if (!format) return NextResponse.json({ error: "This browser records in a format that can't be transcribed." }, { status: 415 });
  try {
    const { text, seconds } = await transcribe(await audio.arrayBuffer(), format);
    await recordMeetingSeconds(user.id, seconds || 60);
    // Re-read so pieces finishing close together don't overwrite each other's lines.
    const fresh = (await getMeeting(user.id, m.id))!;
    await db.update(meetings).set({ transcript: appendLine(fresh.transcript, offset, text), seconds: fresh.seconds + Math.round(seconds || 0) }).where(eq(meetings.id, m.id));
    return NextResponse.json({ text });
  } catch (err) {
    logError("meeting transcribe", err);
    return NextResponse.json({ error: "Couldn't transcribe that minute." }, { status: 502 });
  }
}
