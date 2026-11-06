/**
 * Dori's tools for meeting notes the user recorded or wrote in Midore: find a meeting, and read its summary,
 * decisions, action items, notes and transcript. Read-only; recording itself happens in the browser.
 */
import { and, desc, eq, gte, ilike, lte, or } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db, meetings } from "@/db";
import type { ToolDef } from "../ai/client";
import type { ToolContext } from "./tools";

const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToUndefined, s.optional());
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const S = {
  str: (description?: string) => ({ type: "string", ...(description ? { description } : {}) }),
  int: (description?: string) => ({ type: "integer", ...(description ? { description } : {}) }),
  obj: (properties: Record<string, object>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false }),
};

export const MEETING_TOOL_DEFS: ToolDef[] = [
  { type: "function", function: { name: "find_meetings", description: "Meetings the user recorded or took notes in with Midore, newest first: id, title, when, the first points of the summary. Search words look in titles, notes and transcripts.", parameters: S.obj({ query: S.str("Words to look for"), from_day: S.str("YYYY-MM-DD"), to_day: S.str("YYYY-MM-DD") }) } },
  { type: "function", function: { name: "meeting_notes", description: "One meeting's notes: summary, decisions, action items (who, by when, whether already a task), the user's own notes and the transcript (speakers not labelled).", parameters: S.obj({ id: S.int() }, ["id"]) } },
];

export const MEETING_TOOL_STATUS: Record<string, string> = {
  find_meetings: "Looking through your meetings",
  meeting_notes: "Reading the meeting notes",
};

type Exec = (ctx: ToolContext, args: unknown) => Promise<string>;

export const meetingExecutors: Record<string, Exec> = {
  async find_meetings(ctx, raw) {
    const a = z.object({ query: opt(z.string().trim().max(120)), from_day: opt(day), to_day: opt(day) }).parse(raw);
    const tz = ctx.user.timezone;
    const conds = [eq(meetings.userId, ctx.user.id)];
    if (a.from_day) conds.push(gte(meetings.startedAt, DateTime.fromISO(a.from_day, { zone: tz }).startOf("day").toJSDate()));
    if (a.to_day) conds.push(lte(meetings.startedAt, DateTime.fromISO(a.to_day, { zone: tz }).endOf("day").toJSDate()));
    if (a.query) {
      const q = `%${a.query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      conds.push(or(ilike(meetings.title, q), ilike(meetings.notes, q), ilike(meetings.transcript, q))!);
    }
    const rows = await db.select().from(meetings).where(and(...conds)).orderBy(desc(meetings.startedAt)).limit(15);
    if (!rows.length) return a.query ? `No meetings mention "${a.query}".` : "No meetings recorded or noted yet. They can record one from Meetings in the top bar.";
    return JSON.stringify(rows.map((m) => ({
      id: m.id,
      title: m.title,
      when: DateTime.fromJSDate(m.startedAt).setZone(tz).toFormat("ccc yyyy-MM-dd HH:mm"),
      ...(m.status === "recording" ? { in_progress: true } : {}),
      ...(m.summary ? { summary: m.summary.summary.slice(0, 2), action_items: m.summary.actions.length } : { has_notes: !!m.notes.trim() }),
    })));
  },

  async meeting_notes(ctx, raw) {
    const a = z.object({ id: z.number().int() }).parse(raw);
    const [m] = await db.select().from(meetings).where(and(eq(meetings.id, a.id), eq(meetings.userId, ctx.user.id))).limit(1);
    if (!m) return "Error: no such meeting; use find_meetings.";
    const transcript = m.transcript.length > 24_000 ? `${m.transcript.slice(0, 12_000)}\n[…]\n${m.transcript.slice(-12_000)}` : m.transcript;
    return JSON.stringify({
      title: m.title,
      when: DateTime.fromJSDate(m.startedAt).setZone(ctx.user.timezone).toFormat("ccc yyyy-MM-dd HH:mm"),
      ...(m.summary
        ? { summary: m.summary.summary, decisions: m.summary.decisions, action_items: m.summary.actions.map((x) => ({ text: x.text, who: x.who, ...(x.due ? { due: x.due } : {}), ...(x.taskId ? { task_id: x.taskId } : {}) })) }
        : { summary: "none yet" }),
      notes: m.notes.slice(0, 6000) || "(none)",
      transcript: m.recorded ? transcript || "(nothing transcribed)" : "(notes only, not recorded)",
    });
  },
};
