import { test } from "node:test";
import assert from "node:assert/strict";
import { appendLine, forModel, meetingStartingNow, stamp } from "./meetings-core.ts";

test("timestamps and transcript lines", () => {
  assert.equal(stamp(75), "01:15");
  assert.equal(stamp(3725), "1:02:05");
  assert.equal(appendLine("", 0, "  Hello   everyone "), "[00:00] Hello everyone");
  assert.equal(appendLine("[00:00] Hi", 60, "Next item"), "[00:00] Hi\n[01:00] Next item");
  assert.equal(appendLine("[00:00] Hi", 60, "   "), "[00:00] Hi");
});

test("the meeting starting now", () => {
  const now = Date.parse("2026-11-06T15:00:00Z");
  const ev = (id: string, start: string, end: string, extra: object = {}) => ({ id, accountId: 1, title: id, start, end, allDay: false, attendees: [{}, {}], ...extra });
  const events = [
    ev("solo", "2026-11-06T15:00:00Z", "2026-11-06T16:00:00Z", { attendees: [] }), // no one else, no link
    ev("declined", "2026-11-06T15:00:00Z", "2026-11-06T16:00:00Z", { myResponse: "declined" }),
    ev("earlier", "2026-11-06T14:52:00Z", "2026-11-06T15:30:00Z"),
    ev("call", "2026-11-06T14:59:00Z", "2026-11-06T15:30:00Z", { attendees: [], meetLink: "https://meet.example/x" }),
    ev("old", "2026-11-06T14:30:00Z", "2026-11-06T15:30:00Z"), // started 30 min ago
    ev("soon", "2026-11-06T15:05:00Z", "2026-11-06T15:30:00Z"), // 5 min away
  ];
  assert.equal(meetingStartingNow(events, now)?.id, "call");
  assert.equal(meetingStartingNow(events.filter((e) => e.id !== "call"), now)?.id, "earlier");
  assert.equal(meetingStartingNow([events[5]], now), null);
});

test("long transcripts keep their start and end", () => {
  const t = "a".repeat(100) + "b".repeat(100);
  const cut = forModel(t, 100);
  assert.ok(cut.startsWith("a".repeat(50)) && cut.endsWith("b".repeat(50)) && cut.includes("left out"));
  assert.equal(forModel("short", 100), "short");
});
