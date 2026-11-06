/**
 * Apple's web services, signed with one key from the Apple Developer account: Apple Maps (geocoding, travel
 * times with traffic) and WeatherKit. Needs APPLE_TEAM_ID, APPLE_MAPS_KEY_ID and the key itself (APPLE_MAPS_KEY_P8,
 * the .p8 file's contents; locally APPLE_MAPS_KEY_P8_PATH may point at the file instead). Separate from the Sign in
 * with Apple key (APPLE_KEY_ID / APPLE_PRIVATE_KEY in apple.ts).
 */
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { logWarn } from "./log";

const clean = (v: string | undefined) => v?.trim().replace(/^["']|["']$/g, "") || undefined;
let cachedKey: KeyObject | null | undefined;

function key(): KeyObject | null {
  if (cachedKey !== undefined) return cachedKey;
  try {
    const path = clean(process.env.APPLE_MAPS_KEY_P8_PATH);
    const pem = clean(process.env.APPLE_MAPS_KEY_P8)?.replace(/\\n/g, "\n") ?? (path ? readFileSync(path.replace(/^~/, process.env.HOME ?? ""), "utf8") : null);
    cachedKey = pem ? createPrivateKey(pem) : null;
  } catch (err) {
    logWarn("apple", `key: ${(err as Error).message}`);
    cachedKey = null;
  }
  return cachedKey;
}

export function appleConfigured(): boolean {
  return !!(clean(process.env.APPLE_TEAM_ID) && clean(process.env.APPLE_MAPS_KEY_ID) && key());
}

function sign(header: Record<string, string>, payload: Record<string, string | number>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${b64({ alg: "ES256", kid: clean(process.env.APPLE_MAPS_KEY_ID)!, ...header })}.${b64(payload)}`;
  return `${data}.${createSign("SHA256").update(data).sign({ key: key()!, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

const now = () => Math.floor(Date.now() / 1000);

// --- Apple Maps -------------------------------------------------------------------------------------------

let maps: { token: string; until: number } | null = null;

async function mapsToken(fresh = false): Promise<string> {
  if (!fresh && maps && maps.until > Date.now() + 60_000) return maps.token;
  const auth = sign({ typ: "JWT" }, { iss: clean(process.env.APPLE_TEAM_ID)!, iat: now(), exp: now() + 1800 });
  const res = await fetch("https://maps-api.apple.com/v1/token", { headers: { Authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Apple Maps token: ${res.status}`);
  const d = (await res.json()) as { accessToken: string; expiresInSeconds: number };
  maps = { token: d.accessToken, until: Date.now() + d.expiresInSeconds * 1000 };
  return maps.token;
}

async function mapsGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `https://maps-api.apple.com${path}?${new URLSearchParams(params)}`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${await mapsToken()}` }, signal: AbortSignal.timeout(8000) });
  if (res.status === 401) res = await fetch(url, { headers: { Authorization: `Bearer ${await mapsToken(true)}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Apple Maps ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export type Coord = { lat: number; lng: number };

/** An address or place name to coordinates, preferring results near `near`. */
export async function geocode(q: string, near?: Coord): Promise<(Coord & { label: string }) | null> {
  const d = await mapsGet<{ results?: { coordinate: { latitude: number; longitude: number }; formattedAddressLines?: string[]; name?: string }[] }>("/v1/geocode", {
    q: q.slice(0, 300),
    lang: "en-US",
    ...(near ? { searchLocation: `${near.lat},${near.lng}` } : {}),
  });
  let r = d.results?.[0];
  if (!r) {
    // A bare name ("Banff") can stump the geocoder; Apple's place search usually finds it.
    const found = await mapsGet<typeof d>("/v1/search", { q: q.slice(0, 300), lang: "en-US", resultTypeFilter: "Address,Poi", ...(near ? { searchLocation: `${near.lat},${near.lng}` } : {}) }).catch(() => ({ results: [] }));
    r = found.results?.[0];
  }
  return r ? { lat: r.coordinate.latitude, lng: r.coordinate.longitude, label: (r.formattedAddressLines ?? [r.name ?? q]).join(", ") } : null;
}

export type TravelMode = "Automobile" | "Walking" | "Transit";

/** Travel time from one point to another, with traffic when driving, leaving or arriving at a time. */
export async function travelTime(from: Coord, to: Coord, mode: TravelMode, when?: { departAt?: Date; arriveBy?: Date }) {
  const d = await mapsGet<{ etas?: { expectedTravelTimeSeconds: number; staticTravelTimeSeconds?: number; distanceMeters: number }[] }>("/v1/etas", {
    origin: `${from.lat},${from.lng}`,
    destinations: `${to.lat},${to.lng}`,
    transportType: mode,
    ...(when?.arriveBy ? { arrivalDate: when.arriveBy.toISOString() } : when?.departAt ? { departureDate: when.departAt.toISOString() } : {}),
  });
  const e = d.etas?.[0];
  return e ? { seconds: e.expectedTravelTimeSeconds, typicalSeconds: e.staticTravelTimeSeconds ?? null, meters: e.distanceMeters } : null;
}

// --- WeatherKit -------------------------------------------------------------------------------------------

let weatherOff = 0; // when WeatherKit last said it isn't enabled; retried after an hour

/** WeatherKit's forecast, or null when it isn't set up or fails (the caller falls back to another source). */
export async function weatherKit(c: Coord, tz: string, hoursAhead: number): Promise<WeatherKitResponse | null> {
  if (!appleConfigured() || Date.now() - weatherOff < 3600_000) return null;
  const team = clean(process.env.APPLE_TEAM_ID)!;
  const sub = clean(process.env.APPLE_WEATHER_ID) ?? "app.midore";
  const auth = sign({ id: `${team}.${sub}` }, { iss: team, sub, iat: now(), exp: now() + 1800 });
  const start = new Date();
  const params = new URLSearchParams({
    dataSets: "forecastDaily,forecastHourly",
    timezone: tz,
    hourlyStart: start.toISOString(),
    hourlyEnd: new Date(start.getTime() + hoursAhead * 3600_000).toISOString(),
  });
  try {
    const res = await fetch(`https://weatherkit.apple.com/api/v1/weather/en/${c.lat.toFixed(2)}/${c.lng.toFixed(2)}?${params}`, { headers: { Authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) weatherOff = Date.now();
    if (!res.ok) return null;
    return (await res.json()) as WeatherKitResponse;
  } catch (err) {
    logWarn("weatherkit", (err as Error).message);
    return null;
  }
}

export type WeatherKitResponse = {
  forecastDaily?: { days: { forecastStart: string; temperatureMax: number; temperatureMin: number; conditionCode: string; precipitationChance: number; precipitationAmount: number; snowfallAmount?: number }[] };
  forecastHourly?: { hours: { forecastStart: string; temperature: number; conditionCode: string; precipitationChance: number; windSpeed: number }[] };
};
