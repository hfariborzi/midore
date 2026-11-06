/**
 * Reading a calendar link the user pastes (Canvas, D2L, Moodle, Outlook "publish", any .ics): Dori turns the
 * upcoming items into tasks. Only public https addresses are fetched, with a size and time limit, so a link
 * can't be used to reach anything private. The parser is pure and unit tested.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DateTime } from "luxon";

export type FeedItem = { title: string; day: string; time?: string; allDay: boolean };

const MAX_BYTES = 2_000_000;

/** RFC 5545 lines can be folded: a line starting with a space or tab continues the previous one. */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

const unescape = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

/** DTSTART/DUE value with its parameters → local day and time in `tz`. */
function parseWhen(params: string, value: string, tz: string): { day: string; time?: string; allDay: boolean } | null {
  if (/VALUE=DATE(?!-)/i.test(params) || /^\d{8}$/.test(value)) {
    const d = DateTime.fromFormat(value.slice(0, 8), "yyyyLLdd", { zone: tz });
    return d.isValid ? { day: d.toISODate()!, allDay: true } : null;
  }
  const zone = /TZID=([^;:]+)/i.exec(params)?.[1];
  const utc = value.endsWith("Z");
  const d = DateTime.fromFormat(value.replace(/Z$/, ""), "yyyyLLdd'T'HHmmss", { zone: utc ? "utc" : zone || tz });
  if (!d.isValid) return null;
  const local = d.setZone(tz);
  return { day: local.toISODate()!, time: local.toFormat("HH:mm"), allDay: false };
}

/** Upcoming events and to-dos from an iCalendar file, from `fromDay` for `days` days, soonest first. */
export function parseIcs(text: string, tz: string, fromDay: string, days = 120, limit = 100): FeedItem[] {
  const until = DateTime.fromISO(fromDay, { zone: tz }).plus({ days }).toISODate()!;
  const out: FeedItem[] = [];
  let cur: { title?: string; when?: ReturnType<typeof parseWhen>; status?: string } | null = null;
  for (const line of unfold(text)) {
    if (/^BEGIN:(VEVENT|VTODO)/i.test(line)) cur = {};
    else if (/^END:(VEVENT|VTODO)/i.test(line)) {
      if (cur?.title && cur.when && cur.status !== "CANCELLED" && cur.when.day >= fromDay && cur.when.day < until) out.push({ title: cur.title, ...cur.when });
      cur = null;
    } else if (cur) {
      const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/i.exec(line);
      if (!m) continue;
      const [, name, params, value] = m;
      const key = name.toUpperCase();
      if (key === "SUMMARY") cur.title = unescape(value).slice(0, 200);
      else if (key === "STATUS") cur.status = value.trim().toUpperCase();
      // A to-do's due date is what matters; an event's start is its date.
      else if (key === "DUE" || (key === "DTSTART" && !cur.when)) cur.when = parseWhen(params, value.trim(), tz);
    }
  }
  return out.sort((a, b) => (a.day + (a.time ?? "")).localeCompare(b.day + (b.time ?? ""))).slice(0, limit);
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** The address as a public https URL, or an error message. */
export async function checkFeedUrl(raw: string): Promise<URL | string> {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/^webcals?:\/\//i, "https://"));
  } catch {
    return "That isn't a web address.";
  }
  if (url.protocol !== "https:") return "Only https:// calendar links can be read.";
  if (url.username || url.password) return "Links with a user name or password can't be read.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return "That address isn't public.";
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => (typeof a === "string" ? a : a.address));
  if (!addresses.length) return "That address can't be found.";
  if (addresses.some(privateAddress)) return "That address isn't public.";
  return url;
}

/** Fetch a calendar link (following at most three redirects, each checked), up to 2 MB, in 10 seconds. */
export async function fetchFeed(raw: string): Promise<{ text: string } | { error: string }> {
  let target: URL | string = await checkFeedUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    if (typeof target === "string") return { error: target };
    const res = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.1", "User-Agent": "Midore calendar reader" } }).catch(() => null);
    if (!res) return { error: "The calendar link didn't answer." };
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      target = await checkFeedUrl(new URL(res.headers.get("location")!, target).toString());
      continue;
    }
    if (!res.ok || !res.body) return { error: `The calendar link answered with an error (${res.status}).` };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return { error: "That calendar is too big to read (over 2 MB)." };
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    if (!/BEGIN:VCALENDAR/i.test(text)) return { error: "That link isn't a calendar (.ics) file." };
    return { text };
  }
  return { error: "That calendar link redirects too many times." };
}
