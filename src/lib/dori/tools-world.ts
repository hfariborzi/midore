/**
 * Dori's tools for the world outside the calendar: the weather (Apple's WeatherKit, or MET Norway) and travel
 * times (Apple Maps, with traffic). Places come from the user's saved places (Home, Work) or a name or address
 * the user gave. Read-only; nothing here changes the user's data.
 */
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db, places as placesTable, type Place } from "@/db";
import type { ToolDef } from "../ai/client";
import { appleConfigured, geocode, travelTime, type Coord, type TravelMode } from "../apple-services";
import { forecast, WEATHER_CREDIT } from "../weather";
import type { ToolContext } from "./tools";

const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToUndefined, s.optional());
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

const S = {
  str: (description?: string) => ({ type: "string", ...(description ? { description } : {}) }),
  int: (description?: string) => ({ type: "integer", ...(description ? { description } : {}) }),
  enum: (values: string[], description?: string) => ({ type: "string", enum: values, ...(description ? { description } : {}) }),
  obj: (properties: Record<string, object>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false }),
};

export const WORLD_TOOL_DEFS: ToolDef[] = [
  { type: "function", function: { name: "weather", description: "The forecast: daily highs, lows, sky and rain for up to 10 days, and hour by hour for the next two days. For a saved place (default Home) or any city or address.", parameters: S.obj({
    place: S.str("A saved place's name, or a city or address; leave out for Home"),
    day: S.str("YYYY-MM-DD: the day asked about (hourly detail if within two days)"),
  }) } },
  { type: "function", function: { name: "travel_time", description: "How long it takes to get somewhere (driving with traffic, walking or transit) and when to leave. To: an event's location (event_ref), a saved place, or an address. From: a saved place (default Home) or an address.", parameters: S.obj({
    to: S.str("A saved place's name or an address"),
    event_ref: S.str("Instead of to: the event whose location to go to; arrive by its start"),
    from: S.str("A saved place's name or an address; leave out for Home"),
    mode: S.enum(["driving", "walking", "transit"]),
    arrive_by: S.str("YYYY-MM-DDTHH:mm: be there by then (the answer says when to leave)"),
    leave_at: S.str("YYYY-MM-DDTHH:mm: leaving then"),
  }) } },
];

export const WORLD_TOOL_STATUS: Record<string, string> = {
  weather: "Checking the weather",
  travel_time: "Working out the travel time",
};

type Exec = (ctx: ToolContext, args: unknown) => Promise<string>;

async function savedPlaces(userId: number): Promise<Place[]> {
  return db.select().from(placesTable).where(eq(placesTable.userId, userId));
}

const VAGUE = /^(the )?(campus|office|work|school|university|uni|college|gym|airport|home|downtown|hospital|clinic|station|city|town|my place|there)$/i;

const byName = (list: Place[], name: string) => list.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());

/** A saved place, or a name or address looked up with Apple Maps (near Home when there is one). */
async function resolve(list: Place[], text: string | undefined, near?: Coord): Promise<(Coord & { label: string; saved: boolean }) | string> {
  if (!text) {
    const home = byName(list, "home") ?? (list.length === 1 ? list[0] : undefined);
    if (home) return { lat: home.lat, lng: home.lng, label: home.name, saved: true };
    return list.length
      ? `Error: which place? Saved places: ${list.map((p) => p.name).join(", ")}. Or give a city or address.`
      : "Error: no saved Home. Ask where (a city or address), or suggest saving Home under Settings › Places.";
  }
  const saved = byName(list, text);
  if (saved) return { lat: saved.lat, lng: saved.lng, label: saved.name, saved: true };
  // A bare word like "campus" would land on whatever the map finds first; ask instead.
  if (VAGUE.test(text.trim())) return `Error: "${text}" isn't a saved place. Ask which one (its name or address)${list.length ? `; saved places: ${list.map((p) => p.name).join(", ")}` : ""}.`;
  if (!appleConfigured()) return "Error: looking up addresses isn't available; use a saved place.";
  const found = await geocode(text, near).catch(() => null);
  return found ? { ...found, saved: false } : `Error: couldn't find "${text}" on the map. Ask for a fuller address.`;
}

function credit(ctx: ToolContext, c: { text: string; href: string }) {
  ctx.credits ??= [];
  if (!ctx.credits.some((x) => x.href === c.href)) ctx.credits.push({ ...c });
}

export const worldExecutors: Record<string, Exec> = {
  async weather(ctx, raw) {
    const a = z.object({ place: opt(z.string().trim().max(200)), day: opt(day) }).parse(raw);
    const tz = ctx.user.timezone;
    const list = await savedPlaces(ctx.user.id);
    const home = byName(list, "home");
    const where = await resolve(list, a.place, home ? { lat: home.lat, lng: home.lng } : undefined);
    if (typeof where === "string") return where;
    const f = await forecast(where, tz);
    if (!f) return "Error: the weather service didn't answer; try again in a bit.";
    credit(ctx, WEATHER_CREDIT[f.source]);
    const hours = a.day ? f.hours.filter((h) => h.at.startsWith(a.day!)) : f.hours.slice(0, 24);
    const days = f.days.slice(0, 10);
    if (a.day && !days.some((d) => d.date === a.day)) return JSON.stringify({ place: where.label, note: `No forecast for ${a.day} yet (forecasts reach ${days.at(-1)?.date ?? "a few days"}).`, days });
    return JSON.stringify({
      place: where.label,
      units: "°C, mm of rain, km/h",
      days,
      ...(hours.length ? { hours: hours.map((h) => ({ ...h, at: h.at.slice(11, 16), day: h.at.slice(0, 10) })) } : {}),
      ...(f.source === "met" ? { note: "No rain chance in this forecast; use the rain amounts." } : {}),
    });
  },

  async travel_time(ctx, raw) {
    const a = z.object({
      to: opt(z.string().trim().max(300)), event_ref: opt(z.string().max(10)), from: opt(z.string().trim().max(300)),
      mode: opt(z.enum(["driving", "walking", "transit"])), arrive_by: opt(z.string().max(25)), leave_at: opt(z.string().max(25)),
    }).parse(raw);
    if (!appleConfigured()) return "Error: travel times aren't available right now.";
    const tz = ctx.user.timezone;
    const list = await savedPlaces(ctx.user.id);
    let toText = a.to;
    let arriveBy = a.arrive_by ? DateTime.fromISO(a.arrive_by, { zone: tz }) : null;
    if (a.event_ref) {
      const ev = ctx.refs.get(a.event_ref);
      if (!ev) return "Error: no such event; use a ref from the calendar data or list_meetings.";
      if (!ev.location?.trim()) return `Error: "${ev.title}" has no location. Ask where it is.`;
      toText = ev.location.trim();
      if (!arriveBy && !ev.allDay) arriveBy = DateTime.fromISO(ev.start, { zone: tz });
    }
    if (!toText) return "Error: say where to (to, or event_ref).";
    const from = await resolve(list, a.from);
    if (typeof from === "string") return from;
    const to = await resolve(list, toText, from);
    if (typeof to === "string") return to;
    const leaveAt = a.leave_at ? DateTime.fromISO(a.leave_at, { zone: tz }) : null;
    if ((arriveBy && !arriveBy.isValid) || (leaveAt && !leaveAt.isValid)) return "Error: use YYYY-MM-DDTHH:mm for times.";
    const mode: TravelMode = a.mode === "walking" ? "Walking" : a.mode === "transit" ? "Transit" : "Automobile";
    const future = (d: DateTime | null) => (d && d.toMillis() > Date.now() ? d.toJSDate() : undefined);
    const eta = await travelTime(from, to, mode, { arriveBy: future(arriveBy), departAt: future(leaveAt) }).catch(() => null);
    if (!eta) return `Error: no ${a.mode ?? "driving"} route found from ${from.label} to ${to.label}.`;
    credit(ctx, { text: "Travel times from Apple Maps", href: "https://www.apple.com/legal/internet-services/maps/" });
    const minutes = Math.round(eta.seconds / 60);
    const hm = (d: DateTime) => d.toFormat("ccc d LLL, H:mm");
    return JSON.stringify({
      from: from.label,
      to: to.label,
      mode: a.mode ?? "driving",
      minutes,
      ...(eta.typicalSeconds && mode === "Automobile" ? { without_traffic_minutes: Math.round(eta.typicalSeconds / 60) } : {}),
      km: Math.round(eta.meters / 100) / 10,
      ...(arriveBy ? { arrive_by: hm(arriveBy), leave_by: hm(arriveBy.minus({ minutes })) } : {}),
      ...(leaveAt ? { arrive_around: hm(leaveAt.plus({ minutes })) } : {}),
      note: "Suggest leaving a few minutes earlier than leave_by (parking, finding the room).",
    });
  },
};
