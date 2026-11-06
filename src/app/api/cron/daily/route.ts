import { NextResponse, type NextRequest } from "next/server";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db, projects } from "@/db";
import { ensureWatches, pruneExpiredWatches, usersWithAccounts } from "@/lib/calendar/watch";
import { logError } from "@/lib/log";
import { runDeadlineRules } from "@/lib/automations";
import { markPlanDirty } from "@/lib/planner";

// Renewing channels touches every connected account; give it room.
export const maxDuration = 60;

/**
 * Daily housekeeping (scheduled in vercel.json): renew calendar push channels before they expire and forget
 * ones that already did, pause and resume projects on the days the user set, and run "if not done by" rules. Vercel sends CRON_SECRET as a bearer token; without it set, the job refuses to run.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const started = Date.now();
  let done = 0;
  await pruneExpiredWatches().catch((err) => logError("cron prune", err));
  const today = new Date().toISOString().slice(0, 10);
  // Projects paused "from" a day become paused on that day (the planner already skips their work from then).
  await db
    .update(projects)
    .set({ status: "paused", pausedFrom: null })
    .where(and(eq(projects.status, "active"), isNotNull(projects.pausedFrom), lte(projects.pausedFrom, today)))
    .catch((err) => logError("cron pause projects", err));
  // Projects paused "until" a day become active again on that day (the planner already treats them so).
  await db
    .update(projects)
    .set({ status: "active", pausedUntil: null })
    .where(and(eq(projects.status, "paused"), lte(projects.pausedUntil, today)))
    .catch((err) => logError("cron resume projects", err));
  // "If the review isn't done by Wednesday, drop it."
  const ruled = await runDeadlineRules().catch((err) => {
    logError("cron rules", err);
    return new Set<number>();
  });
  for (const userId of ruled) await markPlanDirty(userId).catch(() => {});
  for (const userId of await usersWithAccounts()) {
    if (Date.now() - started > 50_000) break;
    await ensureWatches(userId).catch((err) => logError("cron watches", err));
    done++;
  }
  return NextResponse.json({ ok: true, users: done });
}
