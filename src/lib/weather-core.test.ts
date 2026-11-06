import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { appleSky, fromMet, fromWeatherKit, metSky, type MetResponse } from "./weather-core.ts";

const TZ = "America/Regina"; // UTC-6, no daylight saving

test("sky words", () => {
  assert.equal(appleSky("MostlyCloudy"), "mostly cloudy");
  assert.equal(metSky("lightrainshowersandthunder_day"), "light rain showers and thunder");
  assert.equal(metSky("lightssleetshowersandthunder_night"), "light sleet showers and thunder");
  assert.equal(metSky("clearsky_day"), "clear");
  assert.equal(metSky("partlycloudy_night"), "partly cloudy");
  assert.equal(metSky("heavysnow"), "heavy snow");
});

test("WeatherKit: days in the user's zone, rain chance in percent", () => {
  const f = fromWeatherKit({
    forecastDaily: { days: [{ forecastStart: "2026-11-07T06:00:00Z", temperatureMax: 4.6, temperatureMin: -3.2, conditionCode: "SnowShowers", precipitationChance: 0.4, precipitationAmount: 1.23, snowfallAmount: 15 }] },
    forecastHourly: { hours: [{ forecastStart: "2026-11-07T00:00:00Z", temperature: 1.4, conditionCode: "Clear", precipitationChance: 0.05, windSpeed: 12.4 }] },
  }, TZ);
  assert.deepEqual(f.days[0], { date: "2026-11-07", high: 5, low: -3, sky: "snow showers", rainChance: 40, rainMm: 1.2, snowCm: 1.5 });
  assert.equal(f.hours[0].at, "2026-11-06T18:00-06:00");
});

test("MET Norway: hourly then six-hourly steps become days without counting rain twice", () => {
  const now = DateTime.fromISO("2026-11-06T10:00", { zone: TZ }).toMillis();
  const step = (iso: string, temp: number, opts: { one?: number; six?: number; sym?: string } = {}) => ({
    time: DateTime.fromISO(iso, { zone: TZ }).toUTC().toISO()!,
    data: {
      instant: { details: { air_temperature: temp, wind_speed: 5 } },
      ...(opts.one !== undefined ? { next_1_hours: { summary: { symbol_code: opts.sym ?? "rain" }, details: { precipitation_amount: opts.one } } } : {}),
      ...(opts.six !== undefined ? { next_6_hours: { summary: { symbol_code: opts.sym ?? "cloudy" }, details: { precipitation_amount: opts.six } } } : {}),
    },
  });
  const d: MetResponse = { properties: { timeseries: [
    step("2026-11-06T10:00", 2, { one: 0.5, six: 3 }),
    step("2026-11-06T11:00", 4, { one: 0.2, six: 2, sym: "lightrain" }),
    step("2026-11-06T12:00", 6, { six: 1, sym: "cloudy" }), // six-hourly from here
    step("2026-11-06T18:00", 1, { six: 0.4 }),
  ] } };
  const f = fromMet(d, TZ, now);
  assert.deepEqual(f.days, [{ date: "2026-11-06", high: 6, low: 1, sky: "light rain", rainChance: null, rainMm: 2.1 }]);
  assert.equal(f.hours.length, 2);
  assert.deepEqual(f.hours[0], { at: "2026-11-06T10:00-06:00", temp: 2, sky: "rain", rainChance: null, rainMm: 0.5, windKmh: 18 });
});
