import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFeedUrl, parseIcs } from "./feeds.ts";

const TZ = "America/Edmonton";
const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "SUMMARY:Assignment 3 \\, part B",
  "DTSTART;VALUE=DATE:20261112",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Quiz 4 (ECON 201)",
  "DTSTART:20261110T063000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Old thing",
  "DTSTART;VALUE=DATE:20261001",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Cancelled lecture",
  "STATUS:CANCELLED",
  "DTSTART;TZID=America/Toronto:20261111T100000",
  "END:VEVENT",
  "BEGIN:VTODO",
  "SUMMARY:Final paper with a very long title that is fol",
  " ded onto the next line",
  "DTSTART;TZID=America/Toronto:20261101T090000",
  "DUE;TZID=America/Toronto:20261204T235900",
  "END:VTODO",
  "END:VCALENDAR",
].join("\r\n");

test("reads upcoming events and to-dos from a calendar file", () => {
  assert.deepEqual(parseIcs(ICS, TZ, "2026-11-05"), [
    { title: "Quiz 4 (ECON 201)", day: "2026-11-09", time: "23:30", allDay: false },
    { title: "Assignment 3 , part B", day: "2026-11-12", allDay: true },
    { title: "Final paper with a very long title that is folded onto the next line", day: "2026-12-04", time: "21:59", allDay: false },
  ]);
});

test("only public https links are fetched", async () => {
  assert.equal(await checkFeedUrl("http://example.com/cal.ics"), "Only https:// calendar links can be read.");
  assert.equal(await checkFeedUrl("https://127.0.0.1/cal.ics"), "That address isn't public.");
  assert.equal(await checkFeedUrl("https://10.1.2.3/cal.ics"), "That address isn't public.");
  assert.equal(await checkFeedUrl("https://[::1]/cal.ics"), "That address isn't public.");
  assert.equal(await checkFeedUrl("https://169.254.169.254/latest"), "That address isn't public.");
  assert.equal(await checkFeedUrl("https://localhost/x"), "That address isn't public.");
  assert.equal(await checkFeedUrl("https://user:pw@example.com/x"), "Links with a user name or password can't be read.");
  assert.ok((await checkFeedUrl("webcal://8.8.8.8/x.ics")) instanceof URL);
});
