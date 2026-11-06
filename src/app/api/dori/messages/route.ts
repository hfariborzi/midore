import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, lt } from "drizzle-orm";
import { db, doriMessages, plans } from "@/db";
import { aiConfigured } from "@/lib/ai";
import { speechAvailable } from "@/lib/ai/audio";
import { getCurrentUser } from "@/lib/auth";
import { greetingName } from "@/lib/dori/context";

/** Dori's recent conversation (newest last), whether she is on, and whether there is news since last time. */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const before = Number(req.nextUrl.searchParams.get("before")) || 0;
  const rows = await db
    .select()
    .from(doriMessages)
    .where(before ? and(eq(doriMessages.userId, user.id), lt(doriMessages.id, before)) : eq(doriMessages.userId, user.id))
    .orderBy(desc(doriMessages.id))
    .limit(40);
  const [plan] = await db.select({ notices: plans.notices, seen: plans.noticesSeenAt }).from(plans).where(eq(plans.userId, user.id)).limit(1);
  const news = (plan?.notices ?? []).filter((n) => !plan?.seen || Date.parse(n.at) > plan.seen.getTime()).length;
  return NextResponse.json(
    {
      available: aiConfigured(),
      enabled: !!user.doriConsentAt,
      name: greetingName(user),
      voice: speechAvailable(),
      news,
      briefAt: user.doriPrefs?.briefAt ?? null,
      messages: rows.reverse().map((m) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta, at: m.createdAt })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
