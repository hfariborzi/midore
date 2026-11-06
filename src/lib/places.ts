/**
 * Saved places (Home, Work) for alerts on arriving or leaving. Where a place is comes from the browser's location
 * ("Use where I am now") or from coordinates or a map link the user pastes; no address lookup service is used.
 */

export const MAX_PLACES = 20;

/** Latitude and longitude from "51.0447, -114.0719" or a Google, Apple or OpenStreetMap link, or null. */
export function parseCoords(text: string): { lat: number; lng: number } | null {
  const t = decodeURIComponent(text.trim());
  const patterns = [
    /@(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/, // google.com/maps/@51.04,-114.07,15z
    /[?&](?:q|query|ll|sll|daddr|center)=(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/, // ?q=51.04,-114.07 · Apple ll=
    /[?&]mlat=(-?\d{1,2}(?:\.\d+)?)&mlon=(-?\d{1,3}(?:\.\d+)?)/, // openstreetmap.org/?mlat=…&mlon=…
    /#map=\d+\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)/, // openstreetmap.org/#map=15/51.04/-114.07
    /^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/, // plain "51.04, -114.07"
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) return { lat, lng };
  }
  return null;
}
