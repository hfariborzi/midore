"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, meetings } from "@/db";
import { requireUser } from "@/lib/auth";
import { actionsToTasks, getMeeting } from "@/lib/meetings";
import { markPlanDirty } from "@/lib/planner";

type Result = { error?: string; added?: number };

export async function addMeetingTasksAction(id: number, indexes: number[]): Promise<Result> {
  const user = await requireUser();
  const m = await getMeeting(user.id, id);
  if (!m) return { error: "Meeting not found" };
  const added = await actionsToTasks(user, m, z.array(z.number().int().min(0).max(100)).max(30).parse(indexes));
  if (added) await markPlanDirty(user.id);
  revalidatePath(`/dashboard/meetings/${id}`);
  return { added };
}

export async function saveMeetingAction(id: number, input: { title?: string; notes?: string }): Promise<Result> {
  const user = await requireUser();
  const parsed = z.object({ title: z.string().trim().min(1).max(200).optional(), notes: z.string().max(50_000).optional() }).safeParse(input);
  if (!parsed.success) return { error: "That doesn't look right" };
  await db.update(meetings).set(parsed.data).where(and(eq(meetings.id, id), eq(meetings.userId, user.id)));
  revalidatePath(`/dashboard/meetings/${id}`);
  return {};
}

export async function deleteMeetingAction(id: number): Promise<Result> {
  const user = await requireUser();
  await db.delete(meetings).where(and(eq(meetings.id, id), eq(meetings.userId, user.id)));
  revalidatePath("/dashboard/meetings");
  return {};
}
