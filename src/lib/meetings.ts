/**
 * Meeting notes: a transcript built a minute at a time (ElevenLabs Scribe through OpenRouter, zero data retention;
 * the audio is never stored), the user's own notes, and a summary with decisions and action items written by the
 * AI model. Action items can become tasks.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { aiUsage, db, meetings, tasks, type Meeting, type MeetingPoint, type MeetingSummary, type User } from "@/db";
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

const pointSchema = z.object({ text: z.string(), at: z.string().nullable(), turn: z.boolean() });
const pointJson = {
  type: "object",
  additionalProperties: false,
  required: ["text", "at", "turn"],
  properties: { text: { type: "string" }, at: { type: ["string", "null"] }, turn: { type: "boolean" } },
};
const summarySchema = z.object({
  language: z.string(),
  points: z.array(pointSchema).max(12),
  decisions: z.array(z.string()).max(20),
  actions: z.array(z.object({ text: z.string(), who: z.string(), due: z.string().nullable() })).max(30),
});
const summaryJson = {
  type: "object",
  additionalProperties: false,
  required: ["language", "points", "decisions", "actions"],
  properties: {
    language: { type: "string", description: "The language most of the transcript (or the notes) is in, e.g. English" },
    points: { type: "array", items: pointJson },
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
const liveSchema = z.object({ language: z.string(), points: z.array(pointSchema).max(10) });
const liveJson = {
  type: "object",
  additionalProperties: false,
  required: ["language", "points"],
  properties: { language: { type: "string", description: "The language most of the transcript is in, e.g. English" }, points: { type: "array", items: pointJson } },
};
const LANGUAGE_RULE = "language: first name the language most of the transcript is in (or the notes, without a transcript). Write every other field in exactly that language; never translate.";

const POINTS_RULES = [
  "points: only what matters, in the order it happened, 3 to 8 of them (fewer for a short meeting). Each is one short line, at most about 15 words: a fact, a problem raised, a disagreement, a change of plan, a decision reached. No filler (\"the team discussed…\", greetings, logistics).",
  "turn: true for a turning point, where the discussion changed direction (a problem surfaced, someone pushed back, the plan changed, it was settled). Usually one to three per meeting; false for the rest.",
  "at: the [mm:ss] time from the transcript line where it happened, as \"mm:ss\" (or \"h:mm:ss\"); null if it came only from the user's notes.",
].join("\n");

const cleanLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 400);
const cleanPoints = (points: z.infer<typeof pointSchema>[]): MeetingPoint[] =>
  points.map((p) => ({ text: cleanLine(p.text), at: p.at && /^\d{1,2}(:\d{2}){1,2}$/.test(p.at.trim()) ? p.at.trim() : null, turn: !!p.turn })).filter((p) => p.text);

/** Dori's notes for a meeting: the key points (turning points marked), what was decided, and who does what next. */
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
      `You write meeting notes for ${user.name || "the user"}. You get the meeting's title, a transcript in "[mm:ss] text" lines (speakers aren't labelled; it may be only the user's side, or missing), and the user's own notes.`,
      POINTS_RULES,
      "decisions: what was agreed (empty if nothing). actions: follow-ups. who is \"me\" when the user said they'd do it or their notes say so, the person's name when someone else took it on, or \"unclear\".",
      `due: YYYY-MM-DD only when a day was said (the meeting was on ${day.toFormat("cccc yyyy-MM-dd")}), else null.`,
      LANGUAGE_RULE,
      "Plain, short sentences. Never add anything that isn't in the transcript or the notes; with little to go on, write little.",
    ].join("\n"),
    user: `Title: ${m.title}\n\nThe user's notes:\n${notes || "(none)"}\n\nTranscript:\n${forModel(transcript) || "(no recording)"}`,
  });
  await recordDori(user.id, { requests: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  const points = cleanPoints(data.points);
  return {
    summary: points.map((p) => p.text),
    points,
    decisions: data.decisions.map(cleanLine).filter(Boolean),
    actions: data.actions
      .map((a) => ({ text: cleanLine(a.text), who: cleanLine(a.who) || "unclear", due: a.due && /^\d{4}-\d{2}-\d{2}$/.test(a.due) ? a.due : null }))
      .filter((a) => a.text),
  };
}

/** The key points so far, while the meeting is still going (shown in the recorder's Key points tab). */
export async function livePoints(user: User, m: Meeting): Promise<MeetingPoint[]> {
  const transcript = m.transcript.trim();
  if (!transcript && !m.notes.trim()) return [];
  const { data, usage } = await completeJson({
    name: "meeting_points",
    model: doriModel(),
    schema: liveSchema,
    jsonSchema: liveJson,
    maxTokens: 900,
    timeoutMs: 40_000,
    system: [
      "You keep running notes of a meeting that is still going. You get the transcript so far in \"[mm:ss] text\" lines (speakers not labelled) and the user's own notes.",
      POINTS_RULES,
      LANGUAGE_RULE,
      "Never add anything that isn't there.",
    ].join("\n"),
    user: `Title: ${m.title}\n\nThe user's notes:\n${m.notes.trim() || "(none)"}\n\nTranscript so far:\n${forModel(transcript, 60_000) || "(nothing yet)"}`,
  });
  await recordDori(user.id, { requests: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  return cleanPoints(data.points);
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
