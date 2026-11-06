import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCoords } from "./places.ts";

test("reads coordinates from plain text and map links", () => {
  assert.deepEqual(parseCoords("51.0447, -114.0719"), { lat: 51.0447, lng: -114.0719 });
  assert.deepEqual(parseCoords("51.0447 -114.0719"), { lat: 51.0447, lng: -114.0719 });
  assert.deepEqual(parseCoords("https://www.google.com/maps/place/Calgary/@51.0277,-114.3680,10z/data=x"), { lat: 51.0277, lng: -114.368 });
  assert.deepEqual(parseCoords("https://maps.google.com/?q=51.05,-114.06"), { lat: 51.05, lng: -114.06 });
  assert.deepEqual(parseCoords("https://maps.apple.com/?ll=51.05,-114.06&q=Home"), { lat: 51.05, lng: -114.06 });
  assert.deepEqual(parseCoords("https://www.openstreetmap.org/#map=17/51.04470/-114.07190"), { lat: 51.0447, lng: -114.0719 });
  assert.deepEqual(parseCoords("https://www.openstreetmap.org/?mlat=51.1&mlon=-114.2#map=17"), { lat: 51.1, lng: -114.2 });
});

test("rejects what isn't a place", () => {
  assert.equal(parseCoords("my house"), null);
  assert.equal(parseCoords("123, 45"), null);
  assert.equal(parseCoords("0, 0"), null);
  assert.equal(parseCoords("https://goo.gl/maps/abc"), null);
});
