import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, meetings } from "@/db";
import { speechAvailable } from "@/lib/ai/audio";
import { getCurrentUser } from "@/lib/auth";
import { meetingRoomLeft } from "@/lib/meetings";
import { rateLimitKey, RateLimitError } from "@/lib/rate-limit";

const bodySchema = z.object({
  title: z.string().trim().max(200).optional(),
  eventKey: z.string().max(300).optional(),
  record: z.boolean().default(true), // false = notes only
});

/** Start a meeting: recording (with transcription) or notes only. A meeting still recording is ended first. */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!user.doriConsentAt) return NextResponse.json({ error: "Meeting notes use Dori. Turn Dori on in Settings first." }, { status: 403 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  if (parsed.data.record) {
    if (!speechAvailable()) return NextResponse.json({ error: "Recording isn't set up here; notes only works." }, { status: 501 });
    if (!(await meetingRoomLeft(user.id))) return NextResponse.json({ error: "That's all the recording for today. Notes only still works." }, { status: 429 });
  }
  try {
    await rateLimitKey(`meeting-start:${user.id}`, 20, 3600);
  } catch (err) {
    if (err instanceof RateLimitError) return NextResponse.json({ error: "Too many meetings started. Try again later." }, { status: 429 });
    throw err;
  }
  await db.update(meetings).set({ status: "done", endedAt: new Date() }).where(and(eq(meetings.userId, user.id), eq(meetings.status, "recording")));
  const title = parsed.data.title || `Meeting, ${new Date().toLocaleDateString("en-CA", { timeZone: user.timezone, month: "short", day: "numeric" })}`;
  const [row] = await db
    .insert(meetings)
    .values({ userId: user.id, title, eventKey: parsed.data.eventKey ?? null, recorded: parsed.data.record })
    .returning({ id: meetings.id, title: meetings.title });
  return NextResponse.json(row);
}
