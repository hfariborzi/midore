import { NextResponse } from "next/server";
import { and, eq, gte } from "drizzle-orm";
import { db, meetings } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { eventsForAccounts, listAccounts } from "@/lib/calendar";
import { eventKey } from "@/lib/labels";
import { meetingStartingNow } from "@/lib/meetings-core";

const cache = new Map<number, { at: number; body: unknown }>();

/**
 * A meeting on the calendar starting about now (with other people or a video link), so the dashboard can offer to
 * record it. Cached for two minutes per user to keep calendar calls down.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!user.doriConsentAt) return NextResponse.json({ meeting: null });
  const hit = cache.get(user.id);
  if (hit && Date.now() - hit.at < 120_000) return NextResponse.json(hit.body);
  const now = Date.now();
  let body: { meeting: { key: string; title: string; start: string; end: string; link: string | null } | null } = { meeting: null };
  try {
    const { events } = await eventsForAccounts(user, await listAccounts(user.id), new Date(now - 15 * 60_000), new Date(now + 5 * 60_000));
    const ev = meetingStartingNow(events, now);
    if (ev) {
      const key = `${ev.accountId}:${eventKey(ev)}:${ev.start.slice(0, 10)}`;
      // Already being recorded or noted (this tab or another device): don't offer again.
      const [have] = await db.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.userId, user.id), eq(meetings.eventKey, key), gte(meetings.startedAt, new Date(now - 6 * 3600_000)))).limit(1);
      if (!have) body = { meeting: { key, title: ev.title, start: ev.start, end: ev.end, link: ev.meetLink ?? null } };
    }
  } catch {}
  if (cache.size > 2000) cache.clear();
  cache.set(user.id, { at: now, body });
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
