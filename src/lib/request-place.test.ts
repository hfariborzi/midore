import { test } from "node:test";
import assert from "node:assert/strict";
import { fitsZone, requestPlace, validZone, zoneCity } from "./request-place.ts";

test("a city fits a time zone by longitude", () => {
  assert.equal(fitsZone(-114.07, "America/Regina"), true); // Calgary-ish longitude, UTC-6
  assert.equal(fitsZone(-79.38, "America/Regina"), true); // Toronto: about 0.7 h off, still close
  assert.equal(fitsZone(2.35, "America/Regina"), false); // Paris through a VPN
});

test("the time zone's own city", () => {
  assert.equal(zoneCity("America/Edmonton"), "Edmonton");
  assert.equal(zoneCity("America/Argentina/Buenos_Aires"), "Buenos Aires");
  assert.equal(zoneCity("Etc/UTC"), undefined);
  assert.equal(validZone("Not/AZone"), undefined);
});

test("the request's city from Vercel's headers", () => {
  const h = new Headers({ "x-vercel-ip-city": "Montr%C3%A9al", "x-vercel-ip-latitude": "45.5", "x-vercel-ip-longitude": "-73.6" });
  assert.deepEqual(requestPlace(h, "America/Toronto"), { city: "Montréal", lat: 45.5, lng: -73.6, tz: "America/Toronto" });
  assert.deepEqual(requestPlace(new Headers(), "America/Toronto"), { tz: "America/Toronto" });
  assert.equal(requestPlace(new Headers()), undefined);
});
