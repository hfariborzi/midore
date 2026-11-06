import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, meetings } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { logError } from "@/lib/log";
import { getMeeting, summarize } from "@/lib/meetings";

export const maxDuration = 90;

/** End the meeting and have Dori write its notes (summary, decisions, action items). Also used to redo them. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const m = await getMeeting(user.id, Number((await params).id));
  if (!m) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (m.status === "recording") await db.update(meetings).set({ status: "done", endedAt: new Date() }).where(eq(meetings.id, m.id));
  try {
    const summary = await summarize(user, m);
    // Keep tasks already made from the old action items, matched by their text.
    const made = new Map((m.summary?.actions ?? []).filter((a) => a.taskId).map((a) => [a.text, a.taskId]));
    const merged = summary ? { ...summary, actions: summary.actions.map((a) => ({ ...a, taskId: made.get(a.text) ?? null })) } : null;
    if (merged) await db.update(meetings).set({ summary: merged }).where(eq(meetings.id, m.id));
    return NextResponse.json({ id: m.id, summary: merged });
  } catch (err) {
    logError("meeting summary", err);
    return NextResponse.json({ id: m.id, summary: null, error: "The notes are saved, but Dori couldn't write the summary. Try again from the meeting." }, { status: 200 });
  }
}
