/**
 * Forecasts from Apple's WeatherKit or MET Norway, turned into one shape: daily highs and lows with rain, and
 * hourly for the next two days. Pure; unit tested. Fetching is in weather.ts.
 */
import { DateTime } from "luxon";

export type DayWeather = { date: string; high: number; low: number; sky: string; rainChance: number | null; rainMm: number; snowCm?: number };
export type HourWeather = { at: string; temp: number; sky: string; rainChance: number | null; rainMm?: number; windKmh: number };
export type Forecast = { source: "apple" | "met"; days: DayWeather[]; hours: HourWeather[] };

const r1 = (n: number) => Math.round(n * 10) / 10;

/** "MostlyCloudy" → "mostly cloudy". */
export const appleSky = (code: string) => code.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/** "lightrainshowersandthunder_day" → "light rain showers and thunder". */
export function metSky(symbol: string): string {
  return symbol
    .replace(/_(day|night|polartwilight)$/, "")
    .replace("clearsky", "clear")
    .replace("partlycloudy", "partly cloudy")
    .replace("andthunder", " and thunder")
    .replace(/^(light|heavy)s?(?=rain|sleet|snow)/, "$1 ") // MET spells a few "lightssleet…"
    .replace(/(rain|sleet|snow)showers/, "$1 showers")
    .replace(/\s+/g, " ")
    .trim();
}

type WK = {
  forecastDaily?: { days: { forecastStart: string; temperatureMax: number; temperatureMin: number; conditionCode: string; precipitationChance: number; precipitationAmount: number; snowfallAmount?: number }[] };
  forecastHourly?: { hours: { forecastStart: string; temperature: number; conditionCode: string; precipitationChance: number; windSpeed: number }[] };
};

export function fromWeatherKit(d: WK, tz: string): Forecast {
  return {
    source: "apple",
    days: (d.forecastDaily?.days ?? []).map((x) => ({
      date: DateTime.fromISO(x.forecastStart, { zone: tz }).toISODate()!,
      high: Math.round(x.temperatureMax),
      low: Math.round(x.temperatureMin),
      sky: appleSky(x.conditionCode),
      rainChance: Math.round(x.precipitationChance * 100),
      rainMm: r1(x.precipitationAmount),
      ...(x.snowfallAmount ? { snowCm: r1(x.snowfallAmount / 10) } : {}),
    })),
    hours: (d.forecastHourly?.hours ?? []).map((h) => ({
      at: DateTime.fromISO(h.forecastStart, { zone: tz }).toISO({ suppressMilliseconds: true, suppressSeconds: true })!,
      temp: Math.round(h.temperature),
      sky: appleSky(h.conditionCode),
      rainChance: Math.round(h.precipitationChance * 100),
      windKmh: Math.round(h.windSpeed),
    })),
  };
}

type MetStep = {
  time: string;
  data: {
    instant: { details: { air_temperature: number; wind_speed?: number } };
    next_1_hours?: { summary: { symbol_code: string }; details?: { precipitation_amount?: number } };
    next_6_hours?: { summary: { symbol_code: string }; details?: { precipitation_amount?: number } };
  };
};
export type MetResponse = { properties: { timeseries: MetStep[] } };

/**
 * MET Norway's compact forecast: hourly for about two days, then every six hours. Days are built from it in the
 * user's time zone; rain is the hourly amounts where they exist and the six-hour amounts after that.
 */
export function fromMet(d: MetResponse, tz: string, now: number, hoursAhead = 48): Forecast {
  const steps = d.properties.timeseries;
  const hours: HourWeather[] = [];
  const days = new Map<string, { temps: number[]; rain: number; skies: Map<string, number>; noon?: string }>();
  let coveredUntil = 0; // rain already counted up to here (ms)
  for (const s of steps) {
    const t = Date.parse(s.time);
    const local = DateTime.fromMillis(t, { zone: tz });
    const key = local.toISODate()!;
    const temp = s.data.instant.details.air_temperature;
    const one = s.data.next_1_hours;
    const six = s.data.next_6_hours;
    let e = days.get(key);
    if (!e) days.set(key, (e = { temps: [], rain: 0, skies: new Map() }));
    e.temps.push(temp);
    if (t >= coveredUntil) {
      if (one) {
        e.rain += one.details?.precipitation_amount ?? 0;
        coveredUntil = t + 3600_000;
      } else if (six) {
        e.rain += six.details?.precipitation_amount ?? 0;
        coveredUntil = t + 6 * 3600_000;
      }
    }
    const sky = (one ?? six)?.summary.symbol_code;
    if (sky) {
      const word = metSky(sky);
      if (local.hour >= 8 && local.hour <= 20) e.skies.set(word, (e.skies.get(word) ?? 0) + (one ? 1 : 6));
      if (local.hour >= 11 && local.hour <= 13 && !e.noon) e.noon = word;
    }
    if (one && t >= now - 3600_000 && t <= now + hoursAhead * 3600_000) {
      hours.push({ at: local.toISO({ suppressMilliseconds: true, suppressSeconds: true })!, temp: Math.round(temp), sky: metSky(one.summary.symbol_code), rainChance: null, rainMm: r1(one.details?.precipitation_amount ?? 0), windKmh: Math.round((s.data.instant.details.wind_speed ?? 0) * 3.6) });
    }
  }
  const today = DateTime.fromMillis(now, { zone: tz }).toISODate()!;
  return {
    source: "met",
    hours,
    days: [...days.entries()]
      .filter(([date, e]) => date >= today && e.temps.length >= 2)
      .map(([date, e]) => ({
        date,
        high: Math.round(Math.max(...e.temps)),
        low: Math.round(Math.min(...e.temps)),
        sky: e.noon ?? [...e.skies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
        rainChance: null,
        rainMm: r1(e.rain),
      })),
  };
}
