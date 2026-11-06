/**
 * Roughly where a request comes from: the city from its IP address (as Vercel reports it in request headers) and
 * the browser's time zone. Dori uses these to guess the user's city for the weather when they saved no Home.
 */
import { DateTime } from "luxon";

export type NearPlace = { city?: string; lat?: number; lng?: number; tz?: string };

/** The browser's time zone if it's a real one. */
export function validZone(tz: string | undefined): string | undefined {
  return tz && DateTime.now().setZone(tz).isValid ? tz : undefined;
}

/** A city fits a time zone if its longitude is within a couple of hours of the zone's offset (catches VPNs). */
export function fitsZone(lng: number, tz: string): boolean {
  const offsetHours = DateTime.now().setZone(tz).offset / 60;
  return Math.abs(lng / 15 - offsetHours) <= 2.5;
}

/** The time zone's own city ("America/Edmonton" → "Edmonton"), or nothing for zones like "Etc/UTC". */
export function zoneCity(tz: string): string | undefined {
  if (!tz.includes("/") || /^(Etc|UTC|GMT)/.test(tz)) return undefined;
  return tz.split("/").pop()!.replace(/_/g, " ");
}

export function requestPlace(headers: Headers, browserTz?: string): NearPlace | undefined {
  const tz = validZone(browserTz);
  const lat = Number(headers.get("x-vercel-ip-latitude"));
  const lng = Number(headers.get("x-vercel-ip-longitude"));
  const raw = headers.get("x-vercel-ip-city");
  if (!raw || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return tz ? { tz } : undefined;
  let city = raw;
  try {
    city = decodeURIComponent(raw);
  } catch {}
  return { city: city.slice(0, 80), lat, lng, tz };
}
