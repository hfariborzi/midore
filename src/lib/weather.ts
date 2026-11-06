/**
 * Weather for a place: Apple's WeatherKit when it's set up, MET Norway otherwise (free, no key, credit required).
 * Coordinates are rounded to about a kilometre before they leave Midore. Cached for 30 minutes per place.
 */
import { appleConfigured, weatherKit, type Coord } from "./apple-services";
import { logWarn } from "./log";
import { fromMet, fromWeatherKit, type Forecast, type MetResponse } from "./weather-core";

export type { Forecast } from "./weather-core";

const cache = new Map<string, { at: number; f: Forecast }>();
const TTL = 30 * 60_000;

export const WEATHER_CREDIT = {
  apple: { text: "Apple Weather", href: "https://developer.apple.com/weatherkit/data-source-attribution/" },
  met: { text: "Weather data from MET Norway", href: "https://www.met.no/en/free-meteorological-data" },
} as const;

export async function forecast(c: Coord, tz: string): Promise<Forecast | null> {
  const lat = Math.round(c.lat * 100) / 100;
  const lng = Math.round(c.lng * 100) / 100;
  const key = `${lat},${lng},${tz}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.f;
  let f: Forecast | null = null;
  if (appleConfigured()) {
    const wk = await weatherKit({ lat, lng }, tz, 48);
    if (wk?.forecastDaily) f = fromWeatherKit(wk, tz);
  }
  if (!f) {
    try {
      const res = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lng}`, {
        headers: { "User-Agent": "Midore/1.0 (+https://midore.app)" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) f = fromMet((await res.json()) as MetResponse, tz, Date.now());
      else logWarn("weather", `MET Norway: ${res.status}`);
    } catch (err) {
      logWarn("weather", (err as Error).message);
    }
  }
  if (f) {
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), f });
  }
  return f;
}
