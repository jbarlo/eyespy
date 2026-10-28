import assert from "node:assert/strict";
import { test } from "node:test";
import { featureBytes, featuresFromBytes } from "../../src/perception/internal/features.ts";
import { FEATURE_BYTES, FEATURE_TOTAL } from "../../src/perception/pure.ts";

test("aligned bytes become Features without a copy, at their offset", () => {
  const buf = new ArrayBuffer(FEATURE_BYTES + 4);
  const bytes = new Uint8Array(buf, 2, FEATURE_BYTES);
  bytes[0] = 0x34;
  bytes[1] = 0x12;
  const f = featuresFromBytes(bytes);
  assert.ok(f);
  assert.equal(f.buffer, buf);
  assert.equal(f.byteOffset, 2);
  assert.equal(f.length, FEATURE_TOTAL);
  assert.equal(f[0], 0x1234);
  const back = featureBytes(f);
  assert.equal(back.buffer, buf);
  assert.equal(back.byteOffset, 2);
});

test("an odd offset is copied into an aligned buffer, same values", () => {
  const buf = new ArrayBuffer(FEATURE_BYTES + 1);
  const bytes = new Uint8Array(buf, 1, FEATURE_BYTES);
  bytes[0] = 0x34;
  bytes[1] = 0x12;
  bytes[FEATURE_BYTES - 1] = 0xff;
  const f = featuresFromBytes(bytes);
  assert.ok(f);
  assert.notEqual(f.buffer, buf);
  assert.equal(f.length, FEATURE_TOTAL);
  assert.equal(f[0], 0x1234);
  assert.equal(f[FEATURE_TOTAL - 1], 0xff00);
});

test("wrong size is null", () => {
  assert.equal(featuresFromBytes(new Uint8Array(FEATURE_BYTES - 2)), null);
  assert.equal(featuresFromBytes(new Uint8Array(FEATURE_BYTES + 2)), null);
});
