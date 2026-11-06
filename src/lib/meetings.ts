/**
 * Meeting notes: a transcript built a minute at a time (ElevenLabs Scribe through OpenRouter, zero data retention;
 * the audio is never stored), the user's own notes, and a summary with decisions and action items written by the
 * AI model. Action items can become tasks.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { aiUsage, db, meetings, tasks, type Meeting, type MeetingSummary, type User } from "@/db";
import { completeJson, doriModel } from "./ai/client";
import { recordDori } from "./dori/usage";
import { forModel } from "./meetings-core";
import { MAX_TASKS } from "./tasks";

const USER_SECONDS = Number(process.env.MEETING_MAX_SECONDS_PER_USER_PER_DAY) || 4 * 3600;
const INSTANCE_SECONDS = Number(process.env.MEETING_MAX_SECONDS_PER_DAY) || 200 * 3600;
export const CHUNK_MAX_BYTES = 4 * 1024 * 1024; // under the 4.5 MB request limit; a minute is ~250 KB
export const MAX_MEETING_HOURS = 6;

const today = () => new Date().toISOString().slice(0, 10);

/** Room left today for more meeting audio, for this user and for the whole instance. */
export async function meetingRoomLeft(userId: number): Promise<boolean> {
  const day = today();
  const [mine] = await db.select({ s: aiUsage.meetingSeconds }).from(aiUsage).where(and(eq(aiUsage.userId, userId), eq(aiUsage.day, day)));
  const [all] = await db.select({ s: sql<number>`coalesce(sum(${aiUsage.meetingSeconds}), 0)` }).from(aiUsage).where(eq(aiUsage.day, day));
  return (mine?.s ?? 0) < USER_SECONDS && Number(all?.s ?? 0) < INSTANCE_SECONDS;
}

export async function recordMeetingSeconds(userId: number, seconds: number) {
  const s = Math.round(seconds);
  await db
    .insert(aiUsage)
    .values({ userId, day: today(), meetingSeconds: s })
    .onConflictDoUpdate({ target: [aiUsage.userId, aiUsage.day], set: { meetingSeconds: sql`${aiUsage.meetingSeconds} + ${s}` } });
}

export async function getMeeting(userId: number, id: number): Promise<Meeting | null> {
  const [m] = await db.select().from(meetings).where(and(eq(meetings.id, id), eq(meetings.userId, userId))).limit(1);
  return m ?? null;
}

export async function listMeetings(userId: number, limit = 100): Promise<Meeting[]> {
  return db.select().from(meetings).where(eq(meetings.userId, userId)).orderBy(desc(meetings.startedAt)).limit(limit);
}

const summarySchema = z.object({
  summary: z.array(z.string()).max(12),
  decisions: z.array(z.string()).max(20),
  actions: z.array(z.object({ text: z.string(), who: z.string(), due: z.string().nullable() })).max(30),
});
const summaryJson = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "decisions", "actions"],
  properties: {
    summary: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "who", "due"],
        properties: { text: { type: "string" }, who: { type: "string" }, due: { type: ["string", "null"] } },
      },
    },
  },
};

/** Dori's notes for a meeting: a short summary, what was decided, and who does what next. */
export async function summarize(user: User, m: Meeting): Promise<MeetingSummary | null> {
  const transcript = m.transcript.trim();
  const notes = m.notes.trim();
  if (!transcript && !notes) return null;
  const day = DateTime.fromJSDate(m.startedAt).setZone(user.timezone);
  const { data, usage } = await completeJson({
    name: "meeting_notes",
    model: doriModel(),
    schema: summarySchema,
    jsonSchema: summaryJson,
    maxTokens: 2500,
    timeoutMs: 60_000,
    system: [
      `You write meeting notes for ${user.name || "the user"}. You get the meeting's title, a transcript (speakers aren't labelled; it may be only the user's side, or missing), and the user's own notes.`,
      "summary: 3 to 6 short points, the substance only. decisions: what was agreed (empty if nothing). actions: follow-ups. who is \"me\" when the user said they'd do it or their notes say so, the person's name when someone else took it on, or \"unclear\".",
      `due: YYYY-MM-DD only when a day was said (the meeting was on ${day.toFormat("cccc yyyy-MM-dd")}), else null.`,
      "Write in the language the meeting was held in. Short, plain sentences. Never add anything that isn't in the transcript or the notes; with little to go on, write little.",
    ].join("\n"),
    user: `Title: ${m.title}\n\nThe user's notes:\n${notes || "(none)"}\n\nTranscript:\n${forModel(transcript) || "(no recording)"}`,
  });
  await recordDori(user.id, { requests: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 400);
  return {
    summary: data.summary.map(clean).filter(Boolean),
    decisions: data.decisions.map(clean).filter(Boolean),
    actions: data.actions
      .map((a) => ({ text: clean(a.text), who: clean(a.who) || "unclear", due: a.due && /^\d{4}-\d{2}-\d{2}$/.test(a.due) ? a.due : null }))
      .filter((a) => a.text),
  };
}

/** Turn chosen action items into tasks, noting the meeting; items already added are skipped. */
export async function actionsToTasks(user: User, m: Meeting, indexes: number[]): Promise<number> {
  if (!m.summary) return 0;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.userId, user.id));
  const actions = m.summary.actions.map((a) => ({ ...a }));
  let added = 0;
  for (const i of [...new Set(indexes)]) {
    const a = actions[i];
    if (!a || a.taskId || n + added >= MAX_TASKS) continue;
    const [row] = await db
      .insert(tasks)
      .values({ userId: user.id, title: a.text.slice(0, 300), notes: `From the meeting "${m.title}" on ${DateTime.fromJSDate(m.startedAt).setZone(user.timezone).toFormat("d LLL yyyy")}.`, dueDate: a.due ?? null, position: n + added })
      .returning({ id: tasks.id });
    a.taskId = row.id;
    added++;
  }
  if (added) await db.update(meetings).set({ summary: { ...m.summary, actions } }).where(eq(meetings.id, m.id));
  return added;
}
