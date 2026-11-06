/**
 * Pure helpers for Microsoft Graph: request shapes and response mapping, with no I/O so they can be unit
 * tested. The provider in microsoft.ts does the fetching.
 */
import { DateTime } from "luxon";
import type { Attendee, Interval } from "./types";
export { toGraphRecurrence } from "./recurrence.ts";

/** Tenant id Microsoft uses for personal (outlook.com, hotmail, live) accounts. */
export const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

export const MICROSOFT_SCOPES = ["openid", "email", "profile", "offline_access", "User.Read", "Calendars.ReadWrite"];

/** Microsoft returns granted scopes space-separated, sometimes with the full resource prefix. */
export function hasMicrosoftCalendarScopes(granted: string) {
  return granted.split(/\s+/).some((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//, "") === "Calendars.ReadWrite");
}

export type GraphDateTime = { dateTime: string; timeZone: string };

/** Graph returns "2026-10-06T15:00:00.0000000" in the zone we asked for (we always ask for UTC). */
export function parseGraphUtc(d: GraphDateTime | undefined): number {
  if (!d?.dateTime) return NaN;
  const iso = d.dateTime.replace(/(\.\d{3})\d*$/, "$1");
  return Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
}

/**
 * Date of an all-day event. Graph reports all-day events as midnight in the event's own zone, converted to
 * UTC, so rounding to the nearest day from +12h recovers the intended date anywhere in the world.
 */
export function allDayDate(d: GraphDateTime | undefined): string {
  const ms = parseGraphUtc(d);
  return DateTime.fromMillis(ms + 12 * 3_600_000, { zone: "utc" }).toISODate() ?? "";
}

export type GraphEventLite = {
  start?: GraphDateTime;
  end?: GraphDateTime;
  showAs?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
};

/**
 * Busy intervals from calendarView items. Events shown as "free" don't block (all-day events default to
 * free in Outlook). All-day busy events block the whole local day in the host's time zone.
 */
export function busyFromEvents(items: GraphEventLite[], tz: string): Interval[] {
  const out: Interval[] = [];
  for (const e of items) {
    if (e.isCancelled || e.showAs === "free") continue;
    if (e.isAllDay) {
      const startDay = DateTime.fromISO(allDayDate(e.start), { zone: tz });
      const endDay = DateTime.fromISO(allDayDate(e.end), { zone: tz });
      if (startDay.isValid && endDay.isValid) out.push({ start: startDay.toMillis(), end: endDay.toMillis() });
      continue;
    }
    const start = parseGraphUtc(e.start);
    const end = parseGraphUtc(e.end);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) out.push({ start, end });
  }
  return out;
}

export type GraphAttendee = { emailAddress?: { address?: string; name?: string }; status?: { response?: string } };

export function mapAttendees(list: GraphAttendee[] | undefined): Attendee[] {
  return (list ?? [])
    .filter((a) => a.emailAddress?.address)
    .map((a) => ({
      email: a.emailAddress!.address!,
      name: a.emailAddress?.name || undefined,
      status: a.status?.response && a.status.response !== "none" ? a.status.response : undefined,
    }));
}

export function toGraphAttendees(list: { email: string; name?: string }[]) {
  return list.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: "required" }));
}

/** Graph wants wall-clock time plus an IANA zone, not an instant. */
export function toGraphDateTime(d: Date, timeZone: string): GraphDateTime {
  return { dateTime: DateTime.fromJSDate(d).setZone(timeZone).toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone };
}

/** Outlook calendar colours ("lightBlue" etc.) when hexColor isn't set. */
const COLOR_NAMES: Record<string, string> = {
  lightBlue: "#4a9ae6",
  lightGreen: "#5dbf5d",
  lightOrange: "#f3a04b",
  lightGray: "#9aa0a6",
  lightYellow: "#e6c94a",
  lightTeal: "#3fb1b1",
  lightPink: "#e67fb4",
  lightBrown: "#b58a62",
  lightRed: "#e05d5d",
  maxColor: "#7c3aed",
  auto: "#7c3aed",
};

export function calendarColor(c: { hexColor?: string | null; color?: string | null }) {
  if (c.hexColor && /^#[0-9a-fA-F]{6}$/.test(c.hexColor)) return c.hexColor;
  return COLOR_NAMES[c.color ?? "auto"] ?? "#7c3aed";
}

/** Path for a calendar id; "primary" is the account's default calendar. */
export function calendarPath(calendarId: string) {
  return calendarId === "primary" ? "/me/calendar" : `/me/calendars/${encodeURIComponent(calendarId)}`;
}

/** Whether a token-endpoint error means the grant is dead and the user must reconnect. */
export function isDeadGrant(body: { error?: string; error_codes?: number[] } | undefined) {
  if (!body) return false;
  if (body.error === "invalid_grant" || body.error === "interaction_required") return true;
  // 70000-family: refresh token expired, revoked or issued to a removed app.
  return (body.error_codes ?? []).some((c) => c === 70000 || c === 70008 || c === 700082 || c === 70043 || c === 50173);
}
