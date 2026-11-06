"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq, gte } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db, bookings, dayNotes, doriActions, doriMessages, pinnedBlocks, users, type DoriMeta, type User, type WeeklyHours } from "@/db";
import { requireUser } from "@/lib/auth";
import { cancelBooking } from "@/lib/bookings";
import { isConnected, listAccounts, providerFor, resolveWriteTarget } from "@/lib/calendar";
import { randomId } from "@/lib/crypto";
import { applyProposal } from "@/lib/dori/proposal";
import { deleteAreaConfirmed } from "@/lib/dori/tools";
import { undoMessage } from "@/lib/dori/undo";
import { logError } from "@/lib/log";
import { markPlanDirty, replan, todayIn } from "@/lib/planner";
import { getTask } from "@/lib/tasks";
import { markBlockFor, type BlockState } from "@/lib/task-ops";

type Result = { error?: string };

async function planChanged(user: User) {
  await markPlanDirty(user.id);
  after(() => replan(user, { notify: false }).catch((err) => logError("replan", err)));
  revalidatePath("/dashboard", "layout");
}

async function ownMessage(userId: number, id: number) {
  const [m] = await db.select().from(doriMessages).where(and(eq(doriMessages.id, id), eq(doriMessages.userId, userId))).limit(1);
  return m ?? null;
}

async function setMeta(id: number, meta: DoriMeta) {
  await db.update(doriMessages).set({ meta }).where(eq(doriMessages.id, id));
}

/** Turning Dori off deletes the conversation and the day notes she kept. Tasks and the plan stay. */
export async function setDoriEnabled(enabled: boolean): Promise<Result> {
  const user = await requireUser();
  await db.update(users).set({ doriConsentAt: enabled ? new Date() : null }).where(eq(users.id, user.id));
  if (!enabled) {
    await db.delete(doriMessages).where(eq(doriMessages.userId, user.id));
    await db.delete(dayNotes).where(eq(dayNotes.userId, user.id));
  }
  revalidatePath("/dashboard", "layout");
  return {};
}

const prefsSchema = z.object({
  nickname: z.string().trim().max(40).optional(),
  character: z.enum(["puppy", "kitten"]).optional(),
  briefAt: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
});

export async function saveDoriPrefs(input: z.input<typeof prefsSchema>): Promise<Result> {
  const user = await requireUser();
  const parsed = prefsSchema.safeParse(input);
  if (!parsed.success) return { error: "Keep the nickname under 40 characters" };
  const current = user.doriPrefs ?? { nickname: "" };
  const { nickname, character, briefAt } = parsed.data;
  await db
    .update(users)
    .set({ doriPrefs: { ...current, ...(nickname !== undefined ? { nickname } : {}), ...(character ? { character } : {}), ...(briefAt !== undefined ? { briefAt } : {}) } })
    .where(eq(users.id, user.id));
  revalidatePath("/dashboard", "layout");
  return {};
}

const hoursSchema = z.record(z.string().regex(/^[1-7]$/), z.array(z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })).max(4)).nullable();

/** Hours for planned work; null goes back to the booking availability hours. */
export async function saveWorkHours(weekly: WeeklyHours | null): Promise<Result> {
  const user = await requireUser();
  const parsed = hoursSchema.safeParse(weekly);
  if (!parsed.success) return { error: "Those hours don't look right" };
  for (const ranges of Object.values(parsed.data ?? {})) if (ranges.some((r) => r.end <= r.start)) return { error: "Each range must end after it starts" };
  await db.update(users).set({ workHours: parsed.data }).where(eq(users.id, user.id));
  await planChanged(user);
  return {};
}

export async function clearDoriConversation(): Promise<Result> {
  const user = await requireUser();
  await db.delete(doriMessages).where(eq(doriMessages.userId, user.id));
  return {};
}

/** Create what a brain-dump proposal describes, except the tasks the user unticked. */
export async function acceptDoriProposal(messageId: number, skipTaskIndexes: number[]): Promise<Result & { summary?: string }> {
  const user = await requireUser();
  const m = await ownMessage(user.id, messageId);
  const proposal = m?.meta.proposal;
  if (!m || !proposal) return { error: "Nothing to accept" };
  if (proposal.status !== "pending") return { error: "Already handled" };
  // Mark first so a double click can't create everything twice.
  await setMeta(m.id, { ...m.meta, proposal: { ...proposal, status: "accepted" } });
  try {
    const { undo, summary } = await applyProposal(user.id, proposal, new Set(skipTaskIndexes));
    if (undo.length) await db.insert(doriActions).values({ userId: user.id, messageId: m.id, undo });
    const text = summary.length ? `Created ${summary.slice(0, 3).join(", ")}${summary.length > 3 ? ` and ${summary.length - 3} more` : ""}` : "Nothing to create";
    await setMeta(m.id, { ...m.meta, proposal: { ...proposal, status: "accepted" }, actions: [...(m.meta.actions ?? []), text], undoable: undo.length > 0 });
    await planChanged(user);
    return { summary: text };
  } catch (err) {
    logError("accept proposal", err);
    await setMeta(m.id, { ...m.meta, proposal: { ...proposal, status: "pending" } });
    return { error: "Couldn't create everything. Nothing was lost; try again." };
  }
}

export async function discardDoriProposal(messageId: number): Promise<Result> {
  const user = await requireUser();
  const m = await ownMessage(user.id, messageId);
  if (!m?.meta.proposal || m.meta.proposal.status !== "pending") return {};
  await setMeta(m.id, { ...m.meta, proposal: { ...m.meta.proposal, status: "discarded" } });
  return {};
}

export async function undoDoriMessage(messageId: number): Promise<Result> {
  const user = await requireUser();
  const m = await ownMessage(user.id, messageId);
  if (!m) return { error: "Nothing to undo" };
  await undoMessage(user.id, m.id);
  await setMeta(m.id, { ...m.meta, undone: true, undoable: false });
  await planChanged(user);
  return {};
}

/** Add the event Dori proposed to the user's default calendar. */
export async function confirmDoriEvent(messageId: number, cardIndex: number): Promise<Result> {
  const user = await requireUser();
  const m = await ownMessage(user.id, messageId);
  const card = m?.meta.cards?.[cardIndex];
  if (!m || !card || card.kind !== "event" || card.status !== "pending") return { error: "Nothing to add" };
  const cards = [...(m.meta.cards ?? [])];
  cards[cardIndex] = { ...card, status: "added" };
  await setMeta(m.id, { ...m.meta, cards });
  try {
    const accounts = await listAccounts(user.id);
    const chosen = accounts.find((a) => a.id === card.accountId && isConnected(a));
    const target = chosen ? { account: chosen, calendarId: card.calendarId ?? "primary" } : resolveWriteTarget(user, accounts);
    await providerFor(target.account).createEvent(target.account, target.calendarId, {
      requestId: randomId(),
      summary: card.title,
      description: card.description,
      location: card.location,
      start: new Date(card.start),
      end: new Date(card.end),
      timeZone: user.timezone,
      attendees: card.attendees.map((email) => ({ email })),
      onlineMeeting: !!card.onlineMeeting && target.account.onlineMeetings,
      recurrence: card.recurrence,
    });
  } catch (err) {
    logError("dori event", err);
    cards[cardIndex] = card;
    await setMeta(m.id, { ...m.meta, cards });
    return { error: "Couldn't add it to your calendar. Check that your calendar is connected." };
  }
  await planChanged(user);
  return {};
}

export async function dismissDoriEvent(messageId: number, cardIndex: number): Promise<Result> {
  const user = await requireUser();
  const m = await ownMessage(user.id, messageId);
  const card = m?.meta.cards?.[cardIndex];
  if (!m || !card || (card.kind !== "event" && card.kind !== "event_change" && card.kind !== "booking_cancel" && card.kind !== "rsvp" && card.kind !== "delete_area")) return {};
  const cards = [...(m.meta.cards ?? [])];
  cards[cardIndex] = { ...card, status: "dismissed" } as typeof card;
  await setMeta(m.id, { ...m.meta, cards });
  return {};
}

/** Move or delete one of the user's own events, as Dori proposed. */
export async function confirmDoriEventChange(messageId: number, cardIndex: number): Promise<Result> {
  const user = await requireUser();
  const m = await ownMessage(user.id, messageId);
  const card = m?.meta.cards?.[cardIndex];
  if (!m || !card || card.kind !== "event_change" || card.status !== "pending") return { error: "Nothing to change" };
  const account = (await listAccounts(user.id)).find((a) => a.id === card.accountId);
  if (!account || !isConnected(account)) return { error: "That calendar needs to be reconnected in Settings." };
  try {
    const provider = providerFor(account);
    if (card.action === "delete") await provider.deleteEvent(account, card.calendarId, card.eventId);
    else if (card.newStart && card.newEnd) await provider.moveEvent(account, card.calendarId, card.eventId, new Date(card.newStart), new Date(card.newEnd), user.timezone);
  } catch (err) {
    logError("dori event change", err);
    return { error: card.action === "delete" ? "Couldn't delete it. Try again from your calendar app." : "Couldn't move it. Try again from your calendar app." };
  }
  const cards = [...(m.meta.cards ?? [])];
  cards[cardIndex] = { ...card, status: "done" };
  await setMeta(m.id, { ...m.meta, cards });
  await planChanged(user);
  return {};
}

/** Delete the area Dori offered to delete; Undo on the message brings it back (event labels stay cleared). */
export async function confirmDoriDeleteArea(messageId: number, cardIndex: number): Promise<Result> {
  const user = await requireUser();
  const m = await ownMessage(user.id, messageId);
  const card = m?.meta.cards?.[cardIndex];
  if (!m || !card || card.kind !== "delete_area" || card.status !== "pending") return { error: "Nothing to delete" };
  const undo = await deleteAreaConfirmed(user.id, card.id);
  const cards = [...(m.meta.cards ?? [])];
  cards[cardIndex] = { ...card, status: "done" };
  if (undo) await db.insert(doriActions).values({ userId: user.id, messageId: m.id, undo: [undo] });
  await setMeta(m.id, { ...m.meta, cards, ...(undo ? { actions: [...(m.meta.actions ?? []), `Deleted area "${card.name}"`], undoable: true, undone: false } : {}) });
  await planChanged(user);
  return {};
}

/** Send the reply to an invitation that Dori prepared. */
export async function confirmDoriRsvp(messageId: number, cardIndex: number): Promise<Result> {
  const user = await requireUser();
  const m = await ownMessage(user.id, messageId);
  const card = m?.meta.cards?.[cardIndex];
  if (!m || !card || card.kind !== "rsvp" || card.status !== "pending") return { error: "Nothing to send" };
  const account = (await listAccounts(user.id)).find((a) => a.id === card.accountId);
  if (!account || !isConnected(account)) return { error: "That calendar needs to be reconnected in Settings." };
  try {
    await providerFor(account).respond(account, card.calendarId, card.eventId, card.response, card.comment || undefined);
  } catch (err) {
    logError("dori rsvp", err);
    return { error: "Couldn't send the reply. You may be the organizer, or it may need answering from your calendar app." };
  }
  const cards = [...(m.meta.cards ?? [])];
  cards[cardIndex] = { ...card, status: "done" };
  await setMeta(m.id, { ...m.meta, cards });
  await planChanged(user);
  return {};
}

/** Cancel a booking Dori proposed to cancel; the person is told, as when the host cancels from Bookings. */
export async function confirmDoriBookingCancel(messageId: number, cardIndex: number): Promise<Result> {
  const user = await requireUser();
  const m = await ownMessage(user.id, messageId);
  const card = m?.meta.cards?.[cardIndex];
  if (!m || !card || card.kind !== "booking_cancel" || card.status !== "pending") return { error: "Nothing to cancel" };
  const [b] = await db.select({ userId: bookings.userId }).from(bookings).where(eq(bookings.uid, card.uid)).limit(1);
  if (!b || b.userId !== user.id) return { error: "Booking not found" };
  try {
    await cancelBooking(card.uid, "host", card.reason);
  } catch (err) {
    logError("dori booking cancel", err);
    return { error: "Couldn't cancel it. Try again from Bookings." };
  }
  const cards = [...(m.meta.cards ?? [])];
  cards[cardIndex] = { ...card, status: "done" };
  await setMeta(m.id, { ...m.meta, cards });
  await planChanged(user);
  revalidatePath("/dashboard/bookings");
  return {};
}

// --- From the calendar: planned work --------------------------------------------------------------------

/** Keep a planned block where it is: the planner stops moving it. */
export async function pinBlock(taskId: number, start: string, end: string): Promise<Result> {
  const user = await requireUser();
  if (!(await getTask(user.id, taskId))) return { error: "Task not found" };
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return { error: "Invalid time" };
  await db.insert(pinnedBlocks).values({ userId: user.id, taskId, start: s, end: e });
  await planChanged(user);
  return {};
}

export type { BlockState } from "@/lib/task-ops";

/** Mark how a block went (see markBlockFor). */
export async function markBlock(taskId: number, start: string, end: string, state: BlockState): Promise<Result> {
  const user = await requireUser();
  const r = await markBlockFor(user, taskId, start, end, state);
  if (r.error) return r;
  revalidatePath("/dashboard", "layout");
  return {};
}

/** Drag on the calendar: the block moves to a new time and is pinned there. A pin at the old time is replaced. */
export async function moveBlock(taskId: number, fromStart: string, start: string, end: string): Promise<Result> {
  const user = await requireUser();
  if (!(await getTask(user.id, taskId))) return { error: "Task not found" };
  const from = new Date(fromStart);
  const s = new Date(start);
  const e = new Date(end);
  if ([from, s, e].some((d) => Number.isNaN(d.getTime())) || e <= s) return { error: "Invalid time" };
  await db.delete(pinnedBlocks).where(and(eq(pinnedBlocks.userId, user.id), eq(pinnedBlocks.taskId, taskId), eq(pinnedBlocks.start, from)));
  await db.insert(pinnedBlocks).values({ userId: user.id, taskId, start: s, end: e });
  await planChanged(user);
  return {};
}

export async function unpinTask(taskId: number): Promise<Result> {
  const user = await requireUser();
  await db.delete(pinnedBlocks).where(and(eq(pinnedBlocks.userId, user.id), eq(pinnedBlocks.taskId, taskId), gte(pinnedBlocks.end, new Date())));
  await planChanged(user);
  return {};
}

/** Not today: the planner moves this task to another day. */
export async function skipTaskOn(taskId: number, day: string | null): Promise<Result> {
  const user = await requireUser();
  const task = await getTask(user.id, taskId);
  if (!task) return { error: "Task not found" };
  const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : todayIn(user.timezone);
  await db.insert(dayNotes).values({ userId: user.id, day: d, text: `Not "${task.title}" on ${DateTime.fromISO(d).toFormat("ccc d LLL")}`, skipTaskIds: [taskId] });
  await planChanged(user);
  return {};
}
