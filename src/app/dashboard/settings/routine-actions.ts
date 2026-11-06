"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { automations, db, places, users } from "@/db";
import { requireUser } from "@/lib/auth";
import { MAX_PLACES } from "@/lib/places";

type Result = { error?: string };

const placeSchema = z.object({
  name: z.string().trim().min(1, "Give the place a name").max(40, "Keep the name under 40 characters"),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(100).max(2000),
});

/** Save a place (Home, Work) for alerts on arriving or leaving. */
export async function addPlaceAction(input: z.input<typeof placeSchema>): Promise<Result & { id?: number }> {
  const user = await requireUser();
  const parsed = placeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That place doesn't look right" };
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(places).where(eq(places.userId, user.id));
  if (n >= MAX_PLACES) return { error: `At most ${MAX_PLACES} places` };
  const taken = await db.select({ id: places.id }).from(places).where(and(eq(places.userId, user.id), sql`lower(${places.name}) = lower(${parsed.data.name})`)).limit(1);
  if (taken.length) return { error: "You already have a place with that name" };
  const [row] = await db.insert(places).values({ userId: user.id, ...parsed.data }).returning({ id: places.id });
  revalidatePath("/dashboard/settings");
  return { id: row.id };
}

/** Forget a place; alerts tied to it are removed from their tasks. */
export async function deletePlaceAction(id: number): Promise<Result> {
  const user = await requireUser();
  await db.delete(places).where(and(eq(places.id, id), eq(places.userId, user.id)));
  revalidatePath("/dashboard/settings");
  return {};
}

export async function setAutomationEnabledAction(id: number, enabled: boolean): Promise<Result> {
  const user = await requireUser();
  await db.update(automations).set({ enabled }).where(and(eq(automations.id, id), eq(automations.userId, user.id)));
  return {};
}

export async function deleteAutomationAction(id: number): Promise<Result> {
  const user = await requireUser();
  await db.delete(automations).where(and(eq(automations.id, id), eq(automations.userId, user.id)));
  return {};
}

export async function removeCheckInAction(id: string): Promise<Result> {
  const user = await requireUser();
  const prefs = user.doriPrefs ?? { nickname: "" };
  await db
    .update(users)
    .set({ doriPrefs: { ...prefs, checkIns: (prefs.checkIns ?? []).filter((c) => c.id !== id) } })
    .where(eq(users.id, user.id));
  revalidatePath("/dashboard", "layout");
  return {};
}
