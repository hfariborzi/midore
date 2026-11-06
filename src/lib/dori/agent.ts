/**
 * One turn with Dori: store the user's message, give the model the user's world and tools, run tool calls
 * until it answers, store the answer with what changed (and how to undo it), and stream progress.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { db, doriActions, doriMessages, plans, type DoriMeta, type DoriMood, type User } from "@/db";
import { aiConfigured, chatWithTools, type ChatMessage, type ContentPart } from "../ai/client";
import { logError } from "../log";
import { freshPlan, listNotes, replan } from "../planner";
import { buildContext, type EventRefs } from "./context";
import { DAY_PLAN_PROMPT, doriSystem, WEEK_PLAN_PROMPT } from "./prompt";
import { runTool, TOOL_DEFS, TOOL_STATUS, type ToolContext } from "./tools";
import { doriRoomLeft, recordDori } from "./usage";

const MAX_ROUNDS = 6;
const HISTORY = 10;
// Tools whose results Dori needs to read before answering. For the others, a reply written alongside the
// calls can be used as is when every call succeeds, which saves a whole model round.
const READ_TOOLS = new Set([
  "get_plan", "find_meeting_times", "check_capacity", "list_meetings", "propose_plan", "draft_emails", "propose_calendar_event",
  "propose_event_change", "respond_to_invite", "find_tasks", "habit_stats", "list_booking_pages", "list_bookings", "cancel_booking", "read_calendar_feed", "time_report",
]);

export type DoriEvent =
  | { type: "status"; mood: DoriMood; text: string }
  | { type: "reply"; id: number; text: string; meta: DoriMeta }
  | { type: "error"; text: string };

export type Attachment = { kind: "image" | "pdf"; name: string; dataUrl: string };
export type TurnInput = { text: string; mode?: "chat" | "day" | "week"; attachments?: Attachment[] };

const LANG_TAG = /\[\[lang:([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)\]\]\s*$/;

export function splitLang(text: string): { text: string; lang?: string } {
  const m = text.trim().match(LANG_TAG);
  return m ? { text: text.trim().replace(LANG_TAG, "").trim(), lang: m[1] } : { text: text.trim() };
}

export async function runTurn(user: User, input: TurnInput, emit: (e: DoriEvent) => void): Promise<void> {
  const t0 = Date.now();
  const lap = (label: string) => process.env.DORI_DEBUG && console.log(`[dori] ${label} +${Date.now() - t0}ms`);
  if (!aiConfigured()) return emit({ type: "error", text: "Dori isn't available on this Midore instance." });
  if (!user.doriConsentAt) return emit({ type: "error", text: "Turn Dori on first." });
  if (!(await doriRoomLeft(user.id))) return emit({ type: "error", text: "Dori has answered a lot today. She'll be back tomorrow." });

  const attachments = input.mode === "day" || input.mode === "week" ? [] : (input.attachments ?? []);
  const userText = input.mode === "day" ? DAY_PLAN_PROMPT : input.mode === "week" ? WEEK_PLAN_PROMPT : input.text.trim().slice(0, 8000);
  if (!userText && !attachments.length) return emit({ type: "error", text: "Say something to Dori." });
  // Only the names of attachments are kept in the conversation; the files themselves are sent once and dropped.
  const attachedNote = attachments.length ? `(attached: ${attachments.map((a) => a.name || (a.kind === "pdf" ? "a PDF" : "a photo")).join(", ")})` : "";
  const stored = [userText, attachedNote].filter(Boolean).join("\n");

  const [userMsg] = await db.insert(doriMessages).values({ userId: user.id, role: "user", content: stored }).returning({ id: doriMessages.id });
  const history = (await db.select().from(doriMessages).where(and(eq(doriMessages.userId, user.id), lt(doriMessages.id, userMsg.id))).orderBy(desc(doriMessages.id)).limit(HISTORY)).reverse();

  emit({ type: "status", mood: "thinking", text: "Thinking" });
  lap("start");
  const plan = await freshPlan(user);
  lap("plan");
  const refs: EventRefs = new Map();
  const notes = await listNotes(user);
  const context = await buildContext(user, plan, refs, notes);
  lap(`context ${context.text.length} chars`);

  const messages: ChatMessage[] = [
    { role: "system", content: doriSystem(user.doriPrefs?.character ?? "puppy", { language: user.doriPrefs?.language, style: user.doriPrefs?.style }) },
    { role: "user", content: `My data (JSON):\n${context.text}` },
    { role: "assistant", content: "Got it." },
    ...history.map<ChatMessage>((m) => (m.role === "user" ? { role: "user", content: m.content.slice(0, 1500) } : { role: "assistant", content: m.content.slice(0, 700) })),
    {
      role: "user",
      content: attachments.length
        ? [
            { type: "text", text: userText || "Here's what I attached." },
            ...attachments.map<ContentPart>((a) => (a.kind === "image" ? { type: "image_url", image_url: { url: a.dataUrl } } : { type: "file", file: { filename: a.name || "document.pdf", file_data: a.dataUrl } })),
          ]
        : userText,
    },
  ];

  const ctx: ToolContext = { user, refs, undo: [], actions: [], cards: [], changed: false, celebrated: false, concerned: false };
  let answer = "";
  let usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await chatWithTools({ messages, tools: TOOL_DEFS, maxTokens: 4000, timeoutMs: 60_000 });
      lap(`model round ${round} in=${res.usage.inputTokens} out=${res.usage.outputTokens} calls=${res.message.tool_calls?.map((c) => c.function.name).join(",") ?? "-"}`);
      usage = { inputTokens: usage.inputTokens + res.usage.inputTokens, outputTokens: usage.outputTokens + res.usage.outputTokens, requests: usage.requests + 1 };
      const calls = res.message.tool_calls ?? [];
      if (!calls.length) {
        answer = res.message.content ?? "";
        break;
      }
      messages.push({ role: "assistant", content: res.message.content, tool_calls: calls });
      let failed = false;
      for (const call of calls) {
        emit({ type: "status", mood: "busy", text: TOOL_STATUS[call.function.name] ?? "Working" });
        const result = await runTool(ctx, call.function.name, call.function.arguments).catch((err) => {
          logError(`dori tool ${call.function.name}`, err);
          return "Error: that didn't work. Tell the user briefly.";
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 6000) });
        if (result.startsWith("Error")) failed = true;
        lap(`tool ${call.function.name}`);
      }
      const written = res.message.content?.trim();
      if (written && !failed && calls.every((c) => !READ_TOOLS.has(c.function.name))) {
        answer = written;
        break;
      }
    }
    if (!answer) answer = ctx.actions.length ? "Done." : "Sorry, I got tangled up there. Could you say that again?";
  } catch (err) {
    logError("dori turn", err);
    answer = ctx.actions.length ? "I made those changes, but lost my words for a moment." : "I couldn't reach my brain just now. Please try again in a moment.";
  }

  if (ctx.changed) await replan(ctx.user, { notify: false }).catch((err) => logError("dori replan", err));
  lap("replan");
  if (context.unseenNotices) await db.update(plans).set({ noticesSeenAt: new Date() }).where(eq(plans.userId, user.id));

  const { text, lang } = splitLang(answer);
  const mood: DoriMood = ctx.celebrated ? "celebrating" : ctx.concerned || ((input.mode === "day" || input.mode === "week") && plan.atRisk.length > 0) ? "concerned" : "happy";
  const meta: DoriMeta = {
    lang,
    mood,
    ...(ctx.actions.length ? { actions: ctx.actions, undoable: ctx.undo.length > 0 } : {}),
    ...(ctx.proposal ? { proposal: ctx.proposal } : {}),
    ...(ctx.cards.length ? { cards: ctx.cards } : {}),
  };
  const [reply] = await db.insert(doriMessages).values({ userId: user.id, role: "assistant", content: text, meta }).returning({ id: doriMessages.id });
  if (ctx.undo.length) await db.insert(doriActions).values({ userId: user.id, messageId: reply.id, undo: ctx.undo });
  await recordDori(user.id, { turns: 1, requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  emit({ type: "reply", id: reply.id, text, meta });
}
