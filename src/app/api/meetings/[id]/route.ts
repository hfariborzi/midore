import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, meetings } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { getMeeting } from "@/lib/meetings";

const bodySchema = z.object({ notes: z.string().max(50_000).optional(), title: z.string().trim().min(1).max(200).optional() });

/** Save the notes typed during the meeting (autosaved every few seconds), or rename it. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const m = await getMeeting(user.id, Number((await params).id));
  if (!m) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  await db.update(meetings).set(parsed.data).where(eq(meetings.id, m.id));
  return NextResponse.json({ ok: true });
}
