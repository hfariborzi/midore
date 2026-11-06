// Dori tool-choice eval: send each prompt to the model with Dori's real system prompt, tools and a made-up user,
// and record the first round's tool calls and reply. Nothing is executed and no real data is sent.
//
//   DORI_MODEL=… npx tsx --env-file=.env.local --tsconfig tsconfig.json scripts/dori-eval.mts <prompts.md> <out.json> [1,2,3]
//
// <prompts.md> has table rows "| 12 | the prompt | ✅ |" (the owner's list lives in docs/private/dori-prompts.md).
import { readFileSync, writeFileSync } from "node:fs";
import { chatWithTools } from "@/lib/ai/client";
import { doriSystem } from "@/lib/dori/prompt";
import { TOOL_DEFS } from "@/lib/dori/tools";

const file = process.argv[2];
const out = process.argv[3];
const only = process.argv[4] ? new Set(process.argv[4].split(",").map(Number)) : null;
const md = readFileSync(file, "utf8");
const prompts = [...md.matchAll(/^\| (\d+) \| (.+?) \| (✅|🟡|❌) \|/gm)].map((m) => ({ n: Number(m[1]), text: m[2].replace(/\s*\(.*?\)\s*$/, "").trim() })).filter((p) => !only || only.has(p.n));

const context = {
  now: "Thu 2026-11-05 14:30 (America/Edmonton)",
  user: { name: "Sam", greet_as: "Sam" },
  work_hours: "Mon 09:00-17:00; Tue 09:00-17:00; Wed 09:00-17:00; Thu 09:00-17:00; Fri 09:00-16:00; Sat off; Sun off",
  areas: [{ id: 1, name: "Research" }, { id: 2, name: "Teaching" }, { id: 3, name: "Home" }, { id: 4, name: "Health" }, { id: 5, name: "Admin" }, { id: 6, name: "Side Hustle" }],
  projects: [
    { id: 11, name: "Grant application", area: 1, target: "2026-11-20", tasks_open: 1, tasks_done: 3 }, { id: 12, name: "Thesis", area: 1, tasks_open: 4, tasks_done: 6 }, { id: 13, name: "Conference", area: 1, target: "2026-12-03", tasks_open: 2, tasks_done: 1 },
    { id: 14, name: "Marketing", area: 6, tasks_open: 1, tasks_done: 2 }, { id: 15, name: "Podcast", area: 6, tasks_open: 0, tasks_done: 4 }, { id: 16, name: "Grant budget", area: 1, tasks_open: 1, tasks_done: 1 }, { id: 17, name: "Moving", area: 3, tasks_open: 0, tasks_done: 0 },
  ],
  open_tasks: [
    { id: 101, title: "Lit review", project: 12, area: 1, est: 180, due: "2026-11-06", energy: "deep" },
    { id: 102, title: "Grant intro", project: 11, area: 1, est: 120, due: "2026-11-20", hard: true, priority: "high" },
    { id: 103, title: "Prep slides for Tuesday", project: 13, area: 1, est: 90, due: "2026-11-10" },
    { id: 104, title: "Stats analysis", project: 12, area: 1, est: 240, energy: "deep", pushed: 3 },
    { id: 105, title: "Data cleaning", project: 12, area: 1, est: 120 },
    { id: 106, title: "Grade midterms", area: 2, est: 180, due: "2026-11-09" },
    { id: 107, title: "Reply to the dean", area: 2, est: 15 },
    { id: 108, title: "Blog post", project: 14, area: 6, est: 90 },
    { id: 109, title: "Review Ali's draft", area: 1, est: 60, people: ["Ali"] },
    { id: 110, title: "Buy milk", reminder: true, area: 3 },
    { id: 111, title: "Renew passport", reminder: true, area: 5, priority: "low" },
    { id: 112, title: "Run", reminder: true, area: 4, repeat: "weekly", due: "2026-11-06" },
    { id: 113, title: "Meditate", reminder: true, area: 4, repeat: "daily", due: "2026-11-05" },
    { id: 114, title: "Gym", reminder: true, area: 4, repeat: "days:2,4", due: "2026-11-10" },
    { id: 115, title: "Pay rent", reminder: true, area: 3, repeat: "monthly", due: "2026-12-01" },
    { id: 116, title: "Draft thesis chapter 3", project: 12, area: 1, est: 600, due: "2026-11-30" },
    { id: 117, title: "Budget table", project: 16, area: 1, est: 60 },
    { id: 118, title: "Slides final chart", project: 13, area: 1, est: 30 },
    { id: 119, title: "Expense report", area: 5, est: 30, due: "2026-11-27" },
    { id: 120, title: "Journal", reminder: true, area: 4, repeat: "daily", due: "2026-11-05" },
    { id: 121, title: "Spanish practice", area: 4, est: 30, repeat: "weekdays", due: "2026-11-05" },
    { id: 122, title: "Data analysis for chapter 4", project: 12, area: 1, est: 180, waiting_on: "Ali (data)" },
    { id: 123, title: "Pack for NYC", area: 3, reminder: true, due: "2026-11-11", checklist: ["[ ] passport", "[ ] charger", "[x] slides", "[ ] adapter"] },
  ],
  loose_ends: [{ task: 90, title: "Methods section", left: "fix two citations", since: "2026-11-02" }],
  done_this_week: [{ id: 95, title: "Budget draft", status: "done", on: "2026-11-03" }, { id: 96, title: "Run", status: "done", on: "2026-11-03" }, { id: 97, title: "Meditate", status: "done", on: "2026-11-04" }],
  calendar_next_7_days: [
    { ref: "e1", day: "Thu 2026-11-05", start: "15:00", end: "16:00", title: "Lab meeting", calendar: "Work", attendees: 6 },
    { ref: "e2", day: "Fri 2026-11-06", start: "08:00", end: "08:30", title: "Standup", calendar: "Work", attendees: 4, you: "accepted" },
    { ref: "e3", day: "Fri 2026-11-06", start: "10:00", end: "11:00", title: "Dentist", calendar: "Personal", attendees: 0 },
    { ref: "e4", day: "Fri 2026-11-06", start: "14:00", end: "15:00", title: "1:1 with Priya", calendar: "Work", attendees: 2 },
    { ref: "e5", day: "Mon 2026-11-09", start: "10:00", end: "11:30", title: "Teaching: ECON 201", calendar: "Work", attendees: 40 },
    { ref: "e6", day: "Tue 2026-11-10", start: "13:00", end: "14:00", title: "Committee meeting", calendar: "Work", attendees: 5, you: "not answered" },
    { ref: "e7", day: "Wed 2026-11-11", start: "09:00", end: "10:00", title: "Yoga class", calendar: "Personal", attendees: 0 },
    { ref: "e8", day: "Thu 2026-11-12", allDay: true, title: "Flight to Toronto", calendar: "Personal" },
  ],
  planned_yesterday: [{ task: 101, title: "Lit review", start: "09:00", status: "open" }, { task: 107, title: "Reply to the dean", start: "13:00", status: "open" }, { task: 95, title: "Budget draft", start: "14:00", status: "done" }],
  planned_work_next_7_days: [
    { task: 101, day: "Thu 2026-11-05", start: "16:00", end: "17:00" }, { task: 101, day: "Fri 2026-11-06", start: "08:30", end: "10:00" },
    { task: 106, day: "Fri 2026-11-06", start: "11:00", end: "13:00" }, { task: 103, day: "Mon 2026-11-09", start: "09:00", end: "10:00" },
    { task: 102, day: "Mon 2026-11-09", start: "11:30", end: "13:30" }, { task: 104, day: "Tue 2026-11-10", start: "09:00", end: "11:00" },
  ],
  at_risk: [{ task: 101, title: "Lit review", reason: "late", finishes: "Fri 2026-11-06" }],
  notes: [{ id: 31, day: "always", text: "No meetings before 9" }],
  booking_hours: "Mon 09:00-17:00; Tue 09:00-17:00; Wed 09:00-17:00; Thu 09:00-17:00; Fri 09:00-16:00; Sat off; Sun off",
  booking_pages: [{ id: 41, title: "Office hours", minutes: [15] }, { id: 42, title: "30-minute chat", minutes: [30] }],
  automations: [{ id: 51, rule: "When a task with \"chapter\" in Thesis is finished, add \"Review {task} with supervisor\"" }],
  check_ins: [{ id: "k7a2", what: "Week review, Sun at 18:00" }],
  morning_brief: "07:30",
  places: ["Home", "Work"],
  changes_since_last_time: [],
};

const results: unknown[] = [];
let i = 0;
async function worker() {
  while (i < prompts.length) {
    const p = prompts[i++];
    try {
      const res = await chatWithTools({
        messages: [
          { role: "system", content: doriSystem("puppy") },
          { role: "user", content: `My data (JSON):\n${JSON.stringify(context)}` },
          { role: "assistant", content: "Got it." },
          { role: "user", content: p.text },
        ],
        tools: TOOL_DEFS,
        maxTokens: 3000,
        timeoutMs: 90_000,
      });
      results.push({ n: p.n, prompt: p.text, calls: (res.message.tool_calls ?? []).map((c) => ({ name: c.function.name, args: c.function.arguments })), reply: res.message.content ?? "" });
    } catch (err) {
      results.push({ n: p.n, prompt: p.text, error: String(err) });
    }
    process.stderr.write(".");
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
results.sort((a, b) => (a as { n: number }).n - (b as { n: number }).n);
writeFileSync(out, JSON.stringify(results, null, 1));
console.error(`\n${results.length} done`);
