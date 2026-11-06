import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, meetings } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { logError } from "@/lib/log";
import { getMeeting, livePoints } from "@/lib/meetings";
import { rateLimitKey, RateLimitError } from "@/lib/rate-limit";

export const maxDuration = 60;

/**
 * The key points so far of a meeting that is still going, for the recorder's Key points tab. At most one fresh
 * set a minute per meeting; asking sooner returns the last set.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const m = await getMeeting(user.id, Number((await params).id));
  if (!m) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const last = m.summary?.live ? (m.summary.points ?? []) : [];
  if (m.status !== "recording") return NextResponse.json({ points: m.summary?.points ?? [] });
  try {
    await rateLimitKey(`meeting-points:${m.id}`, 1, 55);
  } catch (err) {
    if (err instanceof RateLimitError) return NextResponse.json({ points: last });
    throw err;
  }
  try {
    const points = await livePoints(user, m);
    await db.update(meetings).set({ summary: { summary: points.map((p) => p.text), points, decisions: [], actions: [], live: true } }).where(eq(meetings.id, m.id));
    return NextResponse.json({ points });
  } catch (err) {
    logError("meeting live points", err);
    return NextResponse.json({ points: last });
  }
}
