"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db, users, schedules, eventTypes, bookings, calendarAccounts, categories, labelRules, eventLabels, projects, tasks, taskLinks, loginIdentities, type CalendarPrefs, type Priority } from "@/db";
import { appleRevoke } from "@/lib/apple";
import { aiConfigured, proposeCategories, toSample } from "@/lib/ai";
import { eventsForAccounts } from "@/lib/calendar";
import { CATEGORY_PALETTE, MAX_CATEGORIES, MAX_RULES, eventKey, labelKey, listCategories, listRules, storeLabels, titleHash } from "@/lib/labels";
import { requireUser } from "@/lib/auth";
import { cancelBooking } from "@/lib/bookings";
import { getAccount, isConnected, listAccounts, providerFor } from "@/lib/calendar";
import { RESERVED_USERNAMES } from "@/lib/config";
import { decrypt } from "@/lib/crypto";
import { logError } from "@/lib/log";
import { SESSION_COOKIE } from "@/lib/session";
import { MAX_LINKS_PER_TASK, MAX_PROJECTS, MAX_TASKS, deferred, getProject, getTask, listLinks, listProjects, listTasks, ownedTasks, wouldCycle } from "@/lib/tasks";
import { isRepeat } from "@/lib/tasks/repeat";
import { markPlanDirty, replan } from "@/lib/planner";
import { setStatusFor } from "@/lib/task-ops";
import { revokeDevice } from "@/lib/native";
import type { User } from "@/db";

/** Tasks changed: mark the plan stale and recompute it after the response, without telling Dori (the user did it). */
async function planChanged(user: User) {
  await markPlanDirty(user.id);
  after(() => replan(user, { notify: false }).catch((err) => logError("replan", err)));
}

export type ActionResult = { error?: string; id?: number };

function firstIssue(err: z.ZodError) {
  const i = err.issues[0];
  return i ? `${i.path.join(".") ? i.path.join(".") + ": " : ""}${i.message}` : "Invalid input";
}

const tzSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown time zone");

const timeRange = z
  .object({ start: z.string().regex(/^\d\d:\d\d$/), end: z.string().regex(/^\d\d:\d\d$/) })
  .refine((r) => r.start < r.end || r.end === "24:00", "End time must be after start time");

const locationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("online") }),
  z.object({ type: z.literal("in_person"), address: z.string().trim().min(1, "Enter an address") }),
  z.object({ type: z.literal("phone_host_calls") }),
  z.object({ type: z.literal("phone_invitee_calls"), phone: z.string().trim().min(3, "Enter your phone number") }),
  z.object({
    type: z.literal("custom_link"),
    url: z.string().trim().url("Enter a valid meeting URL"),
    label: z.string().trim().max(60).optional(),
  }),
]);

const eventTypeSchema = z.object({
  id: z.number().int().optional(),
  title: z.string().trim().min(1, "Title is required").max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,59}$/, "URL may only contain lowercase letters, numbers and dashes"),
  description: z.string().max(5000),
  durations: z.array(z.number().int().min(5).max(720)).min(1, "Add at least one duration").max(6),
  locations: z.array(locationSchema).min(1, "Add at least one location").max(6),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  scheduleId: z.number().int().nullable(),
  // "<accountId>:<calendarId>" or null for the user's default calendar.
  writeTarget: z.string().regex(/^\d{1,10}:.{1,300}$/).nullable(),
  preferences: z
    .object({
      locationIndex: z.number().int().min(0).max(5).nullable(),
      weekly: z.record(z.string().regex(/^[1-7]$/), z.array(timeRange).max(10)).nullable(),
      note: z.string().trim().max(200),
    })
    .nullable()
    .default(null),
  bufferBefore: z.number().int().min(0).max(240),
  bufferAfter: z.number().int().min(0).max(240),
  minNotice: z.number().int().min(0).max(60 * 24 * 60),
  maxDaysAhead: z.number().int().min(1).max(730),
  slotInterval: z.number().int().min(5).max(720).nullable(),
  dailyLimit: z.number().int().min(1).max(100).nullable(),
  seats: z.number().int().min(1).max(500),
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        label: z.string().trim().min(1, "Question text is required").max(300),
        type: z.enum(["text", "textarea", "phone", "select"]),
        required: z.boolean(),
        options: z.array(z.string().trim().min(1)).max(50).optional(),
      }),
    )
    .max(20),
  hidden: z.boolean(),
  active: z.boolean(),
});

export type EventTypeInput = z.input<typeof eventTypeSchema>;

export async function saveEventType(input: EventTypeInput): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = eventTypeSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, writeTarget, ...rest } = parsed.data;
  const data = { ...rest, writeAccountId: null as number | null, writeCalendarId: null as string | null };
  data.durations = [...new Set(data.durations)].sort((a, b) => a - b);

  if (writeTarget) {
    const sep = writeTarget.indexOf(":");
    const accountId = writeTarget.slice(0, sep);
    const calendarId = writeTarget.slice(sep + 1);
    if (!(await getAccount(user.id, Number(accountId)))) return { error: "That calendar account is not connected" };
    data.writeAccountId = Number(accountId);
    data.writeCalendarId = calendarId;
  }

  if (data.scheduleId) {
    const [s] = await db
      .select({ id: schedules.id })
      .from(schedules)
      .where(and(eq(schedules.id, data.scheduleId), eq(schedules.userId, user.id)));
    if (!s) return { error: "Schedule not found" };
  }

  const clash = await db
    .select({ id: eventTypes.id })
    .from(eventTypes)
    .where(
      and(eq(eventTypes.userId, user.id), eq(eventTypes.slug, data.slug), id ? ne(eventTypes.id, id) : undefined),
    );
  if (clash.length) return { error: "You already have an event type with that URL" };

  let savedId = id;
  if (id) {
    await db.update(eventTypes).set(data).where(and(eq(eventTypes.id, id), eq(eventTypes.userId, user.id)));
  } else {
    const count = (await db.select({ id: eventTypes.id }).from(eventTypes).where(eq(eventTypes.userId, user.id))).length;
    const [row] = await db
      .insert(eventTypes)
      .values({ ...data, userId: user.id, position: count })
      .returning({ id: eventTypes.id });
    savedId = row.id;
  }
  revalidatePath("/dashboard", "layout");
  return { id: savedId };
}

export async function toggleEventType(id: number, active: boolean) {
  const user = await requireUser();
  await db.update(eventTypes).set({ active }).where(and(eq(eventTypes.id, id), eq(eventTypes.userId, user.id)));
  revalidatePath("/dashboard/event-types");
}

export async function deleteEventType(id: number) {
  const user = await requireUser();
  await db.delete(eventTypes).where(and(eq(eventTypes.id, id), eq(eventTypes.userId, user.id)));
  revalidatePath("/dashboard/event-types");
}

export async function duplicateEventType(id: number) {
  const user = await requireUser();
  const [et] = await db.select().from(eventTypes).where(and(eq(eventTypes.id, id), eq(eventTypes.userId, user.id)));
  if (!et) return;
  const { id: _omit, createdAt: _c, ...rest } = et;
  void _omit;
  void _c;
  let slug = `${et.slug}-copy`;
  for (let i = 2; ; i++) {
    const [taken] = await db
      .select({ id: eventTypes.id })
      .from(eventTypes)
      .where(and(eq(eventTypes.userId, user.id), eq(eventTypes.slug, slug)));
    if (!taken) break;
    slug = `${et.slug}-copy-${i}`;
  }
  await db.insert(eventTypes).values({ ...rest, slug, title: `${et.title} (copy)`, active: false });
  revalidatePath("/dashboard/event-types");
}

const scheduleSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().trim().min(1, "Name is required").max(80),
  timezone: tzSchema,
  weekly: z.record(z.string().regex(/^[1-7]$/, "Invalid weekday"), z.array(timeRange).max(10)),
  overrides: z
    .array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ranges: z.array(timeRange).max(10) }))
    .max(366),
});

export type ScheduleInput = z.input<typeof scheduleSchema>;

export async function saveSchedule(input: ScheduleInput): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = scheduleSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, ...data } = parsed.data;
  let savedId = id;
  if (id) {
    await db.update(schedules).set(data).where(and(eq(schedules.id, id), eq(schedules.userId, user.id)));
  } else {
    const existing = await db.select({ id: schedules.id }).from(schedules).where(eq(schedules.userId, user.id));
    const [row] = await db
      .insert(schedules)
      .values({ ...data, userId: user.id, isDefault: existing.length === 0 })
      .returning({ id: schedules.id });
    savedId = row.id;
  }
  revalidatePath("/dashboard", "layout");
  return { id: savedId };
}

export async function setDefaultSchedule(id: number) {
  const user = await requireUser();
  await db.update(schedules).set({ isDefault: false }).where(eq(schedules.userId, user.id));
  await db.update(schedules).set({ isDefault: true }).where(and(eq(schedules.id, id), eq(schedules.userId, user.id)));
  revalidatePath("/dashboard/availability");
}

export async function deleteSchedule(id: number): Promise<ActionResult> {
  const user = await requireUser();
  const all = await db.select().from(schedules).where(eq(schedules.userId, user.id));
  const target = all.find((s) => s.id === id);
  if (!target) return { error: "Not found" };
  if (target.isDefault) return { error: "Make another schedule the default before deleting this one." };
  await db.delete(schedules).where(and(eq(schedules.id, id), eq(schedules.userId, user.id)));
  revalidatePath("/dashboard/availability");
  return {};
}

const profileSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "Username must be 2–40 lowercase letters, numbers or dashes")
    .refine((u) => !RESERVED_USERNAMES.has(u), "That username is reserved"),
  headline: z.string().trim().max(160),
  welcome: z.string().trim().max(2000),
  timezone: tzSchema,
});

export async function saveProfile(input: z.input<typeof profileSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, parsed.data.username), ne(users.id, user.id)));
  if (taken) return { error: "That username is already taken" };
  await db.update(users).set(parsed.data).where(eq(users.id, user.id));
  revalidatePath("/dashboard", "layout");
  return {};
}

const calendarSettingsSchema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.number().int(),
        conflictCalendarIds: z.array(z.string().min(1).max(300)).max(50),
        visibleCalendarIds: z.array(z.string().min(1).max(300)).max(100),
      }),
    )
    .max(20),
  writeAccountId: z.number().int(),
  writeCalendarId: z.string().min(1).max(300),
});

export async function saveCalendarSettings(input: z.input<typeof calendarSettingsSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = calendarSettingsSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const owned = new Set((await listAccounts(user.id)).map((a) => a.id));
  for (const a of parsed.data.accounts) if (!owned.has(a.id)) return { error: "Unknown calendar account" };
  if (!owned.has(parsed.data.writeAccountId)) return { error: "Unknown calendar account" };

  for (const a of parsed.data.accounts) {
    await db
      .update(calendarAccounts)
      .set({ conflictCalendarIds: [...new Set(a.conflictCalendarIds)] })
      .where(and(eq(calendarAccounts.id, a.id), eq(calendarAccounts.userId, user.id)));
  }
  // Which calendars the Calendar page shows, per account (display only).
  const current = user.calendarPrefs ?? DEFAULT_PREFS;
  const calendars = { ...(current.calendars ?? {}) };
  for (const a of parsed.data.accounts) calendars[String(a.id)] = [...new Set(a.visibleCalendarIds)];
  await db
    .update(users)
    .set({ writeAccountId: parsed.data.writeAccountId, writeCalendarId: parsed.data.writeCalendarId, calendarPrefs: { ...current, calendars } })
    .where(eq(users.id, user.id));
  revalidatePath("/dashboard", "layout");
  return {};
}

async function revokeAccess(account: { provider: "google" | "microsoft"; refreshToken: string | null }) {
  if (!account.refreshToken) return;
  try {
    await providerFor(account).revoke(decrypt(account.refreshToken));
  } catch (err) {
    logError("revoke", err); // the token may already be invalid; nothing else to do
  }
}

/** Disconnect one calendar account. The last one can't go: it's how the user signs in. */
export async function removeCalendarAccount(id: number): Promise<ActionResult> {
  const user = await requireUser();
  const accounts = await listAccounts(user.id);
  const target = accounts.find((a) => a.id === id);
  if (!target) return { error: "Unknown calendar account" };
  if (accounts.length === 1) return { error: "You can't remove your only account. Connect another one first, or delete your Midore account." };

  await revokeAccess(target);
  // Bookings and event types that pointed here fall back automatically (foreign keys set null).
  await db.delete(calendarAccounts).where(and(eq(calendarAccounts.id, id), eq(calendarAccounts.userId, user.id)));
  if (user.writeAccountId === id) {
    const next = accounts.find((a) => a.id !== id && isConnected(a)) ?? accounts.find((a) => a.id !== id);
    await db.update(users).set({ writeAccountId: next?.id ?? null, writeCalendarId: "primary" }).where(eq(users.id, user.id));
  }
  revalidatePath("/dashboard", "layout");
  return {};
}

export async function hostCancelBooking(uid: string, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  const [b] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.uid, uid), eq(bookings.userId, user.id)));
  if (!b) return { error: "Booking not found" };
  try {
    await cancelBooking(uid, "host", reason);
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidatePath("/dashboard/bookings");
  return {};
}

export async function deleteAccount() {
  const user = await requireUser();
  for (const account of await listAccounts(user.id)) await revokeAccess(account);
  // Apple asks apps to revoke Sign in with Apple tokens when an account is deleted.
  for (const id of await db.select().from(loginIdentities).where(eq(loginIdentities.userId, user.id))) {
    if (id.provider === "apple" && id.refreshToken) await appleRevoke(decrypt(id.refreshToken));
  }
  await db.delete(users).where(eq(users.id, user.id)); // cascades to accounts, schedules, event types, bookings
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/");
}

// --- Categories, rules and labels ---------------------------------------------------------------------

const prioritySchema = z.enum(["high", "normal", "low"]);

const categorySchema = z.object({
  id: z.number().int().optional(),
  name: z.string().trim().min(1, "Name is required").max(30),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  defaultPriority: prioritySchema,
  description: z.string().trim().max(200).optional(),
});

export async function saveCategory(input: z.input<typeof categorySchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, ...data } = parsed.data;
  const existing = await listCategories(user.id);
  if (existing.some((c) => c.id !== id && c.name.toLowerCase() === data.name.toLowerCase())) return { error: "You already have a category with that name" };
  if (id) {
    await db.update(categories).set(data).where(and(eq(categories.id, id), eq(categories.userId, user.id)));
  } else {
    if (existing.length >= MAX_CATEGORIES) return { error: `You can have up to ${MAX_CATEGORIES} categories` };
    const [row] = await db.insert(categories).values({ ...data, userId: user.id, position: existing.length }).returning({ id: categories.id });
    revalidatePath("/dashboard", "layout");
    return { id: row.id };
  }
  revalidatePath("/dashboard", "layout");
  return { id };
}

export async function deleteCategory(id: number): Promise<ActionResult> {
  const user = await requireUser();
  // Labels pointing here become "Other" (foreign key set null); rules for it are removed (cascade).
  await db.delete(categories).where(and(eq(categories.id, id), eq(categories.userId, user.id)));
  revalidatePath("/dashboard", "layout");
  return {};
}

const ruleSchema = z.object({
  id: z.number().int().optional(),
  pattern: z.string().trim().min(2, "Pattern must be at least 2 characters").max(120),
  categoryId: z.number().int().nullable(),
  priority: prioritySchema.nullable(),
});

export async function saveRule(input: z.input<typeof ruleSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, ...data } = parsed.data;
  if (data.categoryId !== null && !(await listCategories(user.id)).some((c) => c.id === data.categoryId)) return { error: "Unknown category" };
  if (id) {
    await db.update(labelRules).set(data).where(and(eq(labelRules.id, id), eq(labelRules.userId, user.id)));
  } else {
    const count = (await listRules(user.id)).length;
    if (count >= MAX_RULES) return { error: `You can have up to ${MAX_RULES} rules` };
    await db.insert(labelRules).values({ ...data, userId: user.id, position: count });
  }
  // Rule-made labels are recomputed on the next calendar load; drop them so the new rule applies.
  await db.delete(eventLabels).where(and(eq(eventLabels.userId, user.id), eq(eventLabels.source, "rule")));
  revalidatePath("/dashboard", "layout");
  return {};
}

export async function deleteRule(id: number): Promise<ActionResult> {
  const user = await requireUser();
  await db.delete(labelRules).where(and(eq(labelRules.id, id), eq(labelRules.userId, user.id)));
  await db.delete(eventLabels).where(and(eq(eventLabels.userId, user.id), eq(eventLabels.source, "rule")));
  revalidatePath("/dashboard", "layout");
  return {};
}

const labelSchema = z.object({
  accountId: z.number().int(),
  eventKey: z.string().min(1).max(300),
  title: z.string().max(500),
  categoryId: z.number().int().nullable(),
  priority: prioritySchema.nullable(),
  applyToTitle: z.boolean(), // also make a rule so every event with this title gets the same label
});

/** Label one event (or its whole series) by hand; optionally turn the choice into a rule. */
export async function labelEvent(input: z.input<typeof labelSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = labelSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const d = parsed.data;
  if (!(await getAccount(user.id, d.accountId))) return { error: "Unknown calendar account" };
  if (d.categoryId !== null && !(await listCategories(user.id)).some((c) => c.id === d.categoryId)) return { error: "Unknown category" };
  await storeLabels([{ userId: user.id, accountId: d.accountId, eventKey: d.eventKey, titleHash: titleHash(d.title), categoryId: d.categoryId, priority: d.priority, source: "user" }]);
  if (d.applyToTitle && d.title.trim().length >= 2) {
    const rules = await listRules(user.id);
    const pattern = d.title.trim().slice(0, 120);
    const same = rules.find((r) => r.pattern.toLowerCase() === pattern.toLowerCase());
    if (same) await db.update(labelRules).set({ categoryId: d.categoryId, priority: d.priority }).where(eq(labelRules.id, same.id));
    else if (rules.length < MAX_RULES) await db.insert(labelRules).values({ userId: user.id, pattern, categoryId: d.categoryId, priority: d.priority, position: rules.length });
    await db.delete(eventLabels).where(and(eq(eventLabels.userId, user.id), eq(eventLabels.source, "rule")));
  }
  return {};
}

const prefsSchema = z.object({
  colorBy: z.enum(["kind", "calendar", "type", "priority"]),
  v: z.number().int().optional(),
  hidden: z.object({
    categories: z.array(z.number().int()).max(50),
    other: z.boolean(),
    locations: z.array(z.enum(["video", "in_person", "unspecified"])).max(3),
    priorities: z.array(prioritySchema).max(3),
  }),
});

export async function saveCalendarPrefs(input: z.input<typeof prefsSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = prefsSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  // Keep the sidebar's calendar choice; the calendar view only owns colour-by and the filter chips.
  await db.update(users).set({ calendarPrefs: { ...parsed.data, calendars: user.calendarPrefs?.calendars } }).where(eq(users.id, user.id));
  return {};
}

const DEFAULT_PREFS: CalendarPrefs = { colorBy: "kind", v: 2, hidden: { categories: [], other: false, locations: [], priorities: [] } };

/** Sidebar: which of an account's calendars are shown in the dashboard. */
// --- Projects and tasks -------------------------------------------------------------------------------

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date").nullable();

const projectSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().trim().min(1, "Name is required").max(120),
  notes: z.string().trim().max(2000).default(""),
  categoryId: z.number().int().nullable(),
  targetDate: dateSchema.default(null),
  status: z.enum(["active", "paused", "done"]).default("active"),
});

export async function saveProject(input: z.input<typeof projectSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = projectSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, ...data } = parsed.data;
  if (data.categoryId !== null && !(await listCategories(user.id)).some((c) => c.id === data.categoryId)) return { error: "Unknown area" };
  if (id) {
    const current = await getProject(user.id, id);
    if (!current) return { error: "Project not found" };
    const completedAt = data.status === "done" ? (current.completedAt ?? new Date()) : null;
    await db.update(projects).set({ ...data, completedAt }).where(and(eq(projects.id, id), eq(projects.userId, user.id)));
    // Tasks follow their project's area.
    if (current.categoryId !== data.categoryId) await db.update(tasks).set({ categoryId: data.categoryId }).where(and(eq(tasks.projectId, id), eq(tasks.userId, user.id)));
    revalidatePath("/dashboard/tasks");
    return { id };
  }
  const count = (await listProjects(user.id)).length;
  if (count >= MAX_PROJECTS) return { error: `You can have up to ${MAX_PROJECTS} projects` };
  const [row] = await db.insert(projects).values({ ...data, userId: user.id, position: count }).returning({ id: projects.id });
  revalidatePath("/dashboard/tasks");
  return { id: row.id };
}

/** Deletes the project and its tasks. */
export async function deleteProject(id: number): Promise<ActionResult> {
  const user = await requireUser();
  await db.delete(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id)));
  await planChanged(user);
  revalidatePath("/dashboard/tasks");
  return {};
}

const taskSchema = z.object({
  id: z.number().int().optional(),
  projectId: z.number().int().nullable().default(null),
  categoryId: z.number().int().nullable().default(null), // ignored when projectId is set
  title: z.string().trim().min(1, "Title is required").max(200),
  notes: z.string().trim().max(5000).default(""),
  kind: z.enum(["task", "reminder"]).default("task"),
  estimateMinutes: z.number().int().min(5).max(24 * 60).nullable().default(null),
  dueDate: dateSchema.default(null),
  hardDeadline: z.boolean().default(false),
  priority: prioritySchema.default("normal"),
  energy: z.enum(["deep", "light"]).nullable().default(null),
  people: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  repeat: z.string().refine(isRepeat, "Unknown repeat").nullable().default(null),
  remindTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(), // HH:mm on the due day (today when none); null = no alert
  waitingOn: z.string().trim().max(120).nullable().optional().transform((v) => (v === "" ? null : v)),
  checklist: z.array(z.object({ text: z.string().trim().min(1).max(200), done: z.boolean() })).max(30).optional(),
});

export type TaskInput = z.input<typeof taskSchema>;

export async function saveTask(input: TaskInput): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = taskSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, remindTime, ...fields } = parsed.data;
  const data: typeof fields & { remindAt?: Date | null } = fields;
  if (remindTime !== undefined) {
    if (remindTime === null) data.remindAt = null;
    else {
      const today = DateTime.now().setZone(user.timezone).toISODate()!;
      const day = data.dueDate ?? today;
      if (!data.dueDate) data.dueDate = today;
      data.remindAt = DateTime.fromISO(`${day}T${remindTime}`, { zone: user.timezone }).toJSDate();
    }
  }
  if (data.projectId !== null) {
    const project = await getProject(user.id, data.projectId);
    if (!project) return { error: "Unknown project" };
    data.categoryId = project.categoryId;
  } else if (data.categoryId !== null && !(await listCategories(user.id)).some((c) => c.id === data.categoryId)) {
    return { error: "Unknown area" };
  }
  if (data.kind === "reminder") data.estimateMinutes = null;
  if (id) {
    const current = await getTask(user.id, id);
    if (!current) return { error: "Task not found" };
    const deferCount = current.deferCount + (deferred(current.dueDate, data.dueDate) ? 1 : 0);
    await db.update(tasks).set({ ...data, deferCount, updatedAt: new Date() }).where(and(eq(tasks.id, id), eq(tasks.userId, user.id)));
    await planChanged(user);
    revalidatePath("/dashboard/tasks");
    return { id };
  }
  const count = (await listTasks(user.id)).length;
  if (count >= MAX_TASKS) return { error: `You can have up to ${MAX_TASKS} tasks` };
  const [row] = await db.insert(tasks).values({ ...data, userId: user.id, position: count }).returning({ id: tasks.id });
  await planChanged(user);
  revalidatePath("/dashboard/tasks");
  return { id: row.id };
}

const statusSchema = z.object({
  id: z.number().int(),
  status: z.enum(["open", "good_enough", "done", "dropped"]),
  residue: z.string().max(300).optional(),
});

/** Open, good enough (with what is left), done or dropped. */
export async function setTaskStatus(input: z.input<typeof statusSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const task = await getTask(user.id, parsed.data.id);
  if (!task) return { error: "Task not found" };
  const r = await setStatusFor(user, task.id, parsed.data.status, parsed.data.residue);
  if (r.error) return { error: r.error };
  revalidatePath("/dashboard/tasks");
  return {};
}

/** Turn a good-enough task's residue into its own open task, and mark the original fully done. */
export async function promoteResidue(id: number): Promise<ActionResult> {
  const user = await requireUser();
  const task = await getTask(user.id, id);
  if (!task) return { error: "Task not found" };
  if (task.status !== "good_enough" || !task.residue) return { error: "Nothing left on this task" };
  const count = (await listTasks(user.id)).length;
  if (count >= MAX_TASKS) return { error: `You can have up to ${MAX_TASKS} tasks` };
  const [row] = await db
    .insert(tasks)
    .values({ userId: user.id, projectId: task.projectId, categoryId: task.categoryId, title: task.residue, kind: task.kind, priority: task.priority, people: task.people, position: count })
    .returning({ id: tasks.id });
  await db.update(tasks).set({ status: "done", residue: "", updatedAt: new Date() }).where(eq(tasks.id, task.id));
  await planChanged(user);
  revalidatePath("/dashboard/tasks");
  return { id: row.id };
}

export async function deleteTask(id: number): Promise<ActionResult> {
  const user = await requireUser();
  await db.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, user.id)));
  await planChanged(user);
  revalidatePath("/dashboard/tasks");
  return {};
}

const linkSchema = z.object({ fromTaskId: z.number().int(), toTaskId: z.number().int(), kind: z.enum(["before", "together"]) });

/** "from" before "to", or the two go together. Refuses loops. */
export async function addTaskLink(input: z.input<typeof linkSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { fromTaskId, toTaskId, kind } = parsed.data;
  if (fromTaskId === toTaskId) return { error: "A task can't come after itself" };
  if ((await ownedTasks(user.id, [fromTaskId, toTaskId])).length !== 2) return { error: "Task not found" };
  const links = await listLinks(user.id);
  if (links.filter((l) => l.fromTaskId === toTaskId || l.toTaskId === toTaskId).length >= MAX_LINKS_PER_TASK) return { error: "Too many links on that task" };
  if (links.some((l) => (l.fromTaskId === fromTaskId && l.toTaskId === toTaskId) || (l.fromTaskId === toTaskId && l.toTaskId === fromTaskId))) return { error: "Those two are already linked" };
  if (kind === "before" && wouldCycle(links, fromTaskId, toTaskId)) return { error: "That would make a loop: the other task already comes after this one" };
  await db.insert(taskLinks).values({ userId: user.id, fromTaskId, toTaskId, kind });
  await planChanged(user);
  revalidatePath("/dashboard/tasks");
  return {};
}

export async function deleteTaskLink(id: number): Promise<ActionResult> {
  const user = await requireUser();
  await db.delete(taskLinks).where(and(eq(taskLinks.id, id), eq(taskLinks.userId, user.id)));
  await planChanged(user);
  revalidatePath("/dashboard/tasks");
  return {};
}

// --- AI (opt-in) --------------------------------------------------------------------------------------

export async function setAiConsent(enabled: boolean): Promise<ActionResult> {
  const user = await requireUser();
  if (enabled && !aiConfigured()) return { error: "AI categorisation is not available on this instance" };
  await db.update(users).set({ aiConsentAt: enabled ? new Date() : null }).where(eq(users.id, user.id));
  if (!enabled) await db.delete(eventLabels).where(and(eq(eventLabels.userId, user.id), eq(eventLabels.source, "ai")));
  revalidatePath("/dashboard", "layout");
  return {};
}

export type ProposedCategory = {
  name: string;
  color: string;
  defaultPriority: Priority;
  sampleTitles: string[]; // a few examples to show the user
  events: { accountId: number; eventKey: string; titleHash: string }[]; // labelled on apply
};

const SAMPLE_WEEKS = 8;
const SAMPLE_MAX = 300;

/** Ask the AI for a category list based on the last weeks of events. Nothing is saved until applied. */
export async function proposeCategoriesAction(): Promise<{ error?: string; proposal?: ProposedCategory[]; sampled?: number }> {
  const user = await requireUser();
  if (!aiConfigured()) return { error: "AI categorisation is not available on this instance" };
  if (!user.aiConsentAt) return { error: "Turn on AI categorisation first" };
  const accounts = await listAccounts(user.id);
  const end = new Date();
  const start = new Date(end.getTime() - SAMPLE_WEEKS * 7 * 86_400_000);
  const { events } = await eventsForAccounts(user, accounts, start, end);
  // One per series, newest first, capped.
  const seen = new Set<string>();
  const unique = events
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .filter((e) => !seen.has(labelKey(e)) && seen.add(labelKey(e)))
    .slice(0, SAMPLE_MAX);
  if (unique.length < 5) return { error: "Not enough events in the last eight weeks to suggest categories" };
  try {
    const proposal = await proposeCategories(user.id, unique.map(toSample));
    if (!proposal.length) return { error: "The AI did not return a usable list. Please try again." };
    return {
      sampled: unique.length,
      proposal: proposal.map((c, i) => ({
        name: c.name,
        color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
        defaultPriority: c.defaultPriority,
        sampleTitles: c.sampleIndexes.slice(0, 4).map((j) => unique[j].title),
        events: c.sampleIndexes.map((j) => ({ accountId: unique[j].accountId, eventKey: eventKey(unique[j]), titleHash: titleHash(unique[j].title) })),
      })),
    };
  } catch (err) {
    logError("ai propose", err);
    return { error: (err as Error).message.startsWith("Daily AI limit") ? (err as Error).message : "The AI request failed. Please try again later." };
  }
}

const applySchema = z.object({
  mode: z.enum(["replace", "add"]),
  categories: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(30),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        defaultPriority: prioritySchema,
        events: z.array(z.object({ accountId: z.number().int(), eventKey: z.string().min(1).max(300), titleHash: z.string().min(1).max(64) })).max(500),
      }),
    )
    .min(1)
    .max(MAX_CATEGORIES),
});

/** Create the approved categories and label the sampled events with them. */
export async function applyProposal(input: z.input<typeof applySchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = applySchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const owned = new Set((await listAccounts(user.id)).map((a) => a.id));
  if (parsed.data.mode === "replace") await db.delete(categories).where(eq(categories.userId, user.id));
  const existing = await listCategories(user.id);
  if (existing.length + parsed.data.categories.length > MAX_CATEGORIES) return { error: `That would exceed ${MAX_CATEGORIES} categories; remove some first` };
  const labels: (typeof eventLabels.$inferInsert)[] = [];
  let position = existing.length;
  for (const c of parsed.data.categories) {
    let cat = existing.find((e) => e.name.toLowerCase() === c.name.toLowerCase());
    if (!cat) {
      [cat] = await db.insert(categories).values({ userId: user.id, name: c.name, color: c.color, defaultPriority: c.defaultPriority, position: position++ }).returning();
    }
    for (const e of c.events) {
      if (!owned.has(e.accountId)) continue;
      labels.push({ userId: user.id, accountId: e.accountId, eventKey: e.eventKey, titleHash: e.titleHash, categoryId: cat.id, priority: null, source: "ai" });
    }
  }
  if (labels.length) await storeLabels(labels);
  revalidatePath("/dashboard", "layout");
  return {};
}

/** Settings: sign a desktop or phone app out. */
export async function revokeDeviceAction(id: number): Promise<ActionResult> {
  const user = await requireUser();
  await revokeDevice(user.id, id);
  return {};
}

/** Stop signing in with Apple. Only when another way in remains (a Google or Microsoft account). */
export async function unlinkAppleAction(): Promise<ActionResult> {
  const user = await requireUser();
  if ((await listAccounts(user.id)).length === 0) return { error: "Connect a Google or Microsoft account first, or you'd have no way to sign in." };
  const rows = await db.select().from(loginIdentities).where(and(eq(loginIdentities.userId, user.id), eq(loginIdentities.provider, "apple")));
  for (const row of rows) if (row.refreshToken) await appleRevoke(decrypt(row.refreshToken));
  await db.delete(loginIdentities).where(and(eq(loginIdentities.userId, user.id), eq(loginIdentities.provider, "apple")));
  revalidatePath("/dashboard/settings");
  return {};
}
