import assert from "node:assert/strict";
import { test } from "node:test";
import { f16ToF32, f32ToF16, f32ToF16Bits } from "../../src/pixels/index.ts";
import { npz } from "../fixtures/numerics/lib.ts";

const f16 = npz("f16.npz");

test("f16ToF32 for all 65536 halves = numpy float16 -> float32", () => {
  const t = f16("table").data as Float32Array;
  const table = new Uint32Array(t.buffer, t.byteOffset, t.length);
  const got = f16ToF32(Uint16Array.from({ length: 65536 }, (_, i) => i));
  const bits = new Uint32Array(got.buffer);
  let bad = 0;
  for (let h = 0; h < 65536; h++) {
    const want = table[h]!;
    const wantNaN = (want & 0x7f800000) === 0x7f800000 && (want & 0x7fffff) !== 0;
    if (wantNaN ? !Number.isNaN(got[h]) : bits[h] !== want) bad++;
  }
  assert.equal(bad, 0);
});

test("f32ToF16Bits = numpy float32 -> float16 (round to nearest even; NaN payloads aside)", () => {
  const fin = f16("f32_in").data as Float32Array;
  const input = new Uint32Array(fin.buffer, fin.byteOffset, fin.length);
  const want = f16("f16_out").data as Uint16Array;
  const floats = new Float32Array(input.buffer.slice(0));
  const got = f32ToF16(floats);
  const isNaN32 = (b: number) => (b & 0x7f800000) === 0x7f800000 && (b & 0x7fffff) !== 0;
  let nanDiffs = 0,
    bad = 0;
  for (let i = 0; i < input.length; i++) {
    assert.equal(f32ToF16Bits(floats[i]!), got[i]);
    if (got[i] === want[i]) continue;
    if (isNaN32(input[i]!)) {
      assert.equal(got[i]! & 0x7fff, 0x7e00);
      nanDiffs++;
    } else bad++;
  }
  assert.equal(bad, 0);
  assert.equal(nanDiffs, 21, "NaN payload differences (ignored), pinned");
});

test("f32ToF16 (u32 view, normal-range fast path) = f32ToF16Bits on every exponent edge and 4M spread patterns", () => {
  // every exponent with the mantissas around each rounding edge (halfway, odd or even kept bit, carry) in both signs,
  // then a multiplicative spread over all 2^32 patterns.
  const mants = [0, 1, 0xfff, 0x1000, 0x1001, 0x2000, 0x3000, 0x7fe000, 0x7fefff, 0x7ff000, 0x7fffff];
  const edges: number[] = [];
  for (let s = 0; s < 2; s++)
    for (let e = 0; e < 256; e++) for (const m of mants) edges.push(((s << 31) | (e << 23) | m) >>> 0);
  const spread = Array.from({ length: 1 << 22 }, (_, i) => Math.imul(i, 0x9e3779b1) >>> 0);
  const floats = new Float32Array(Uint32Array.from([...edges, ...spread]).buffer);
  const got = f32ToF16(floats);
  let bad = 0;
  for (let i = 0; i < floats.length; i++) if (got[i] !== f32ToF16Bits(floats[i]!)) bad++;
  assert.equal(bad, 0);
  assert.deepEqual([...f32ToF16(Float32Array.of(9, 1, -2).subarray(1))], [0x3c00, 0xc000]);
});

test("f32ToF16 writes into a caller buffer", () => {
  const out = new Uint16Array(4).fill(9);
  f32ToF16(Float32Array.of(1, -2), out.subarray(1, 3));
  assert.deepEqual([...out], [9, 0x3c00, 0xc000, 9]);
});
