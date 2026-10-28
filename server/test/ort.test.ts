import assert from "node:assert/strict";
import { test } from "node:test";
import { fromOrt } from "../src/adapters/ort.ts";

test("ort: outputs map to the port's tensor types, checked (the edge), fp16 always as Uint16Array bits", () => {
  const f32 = new Float32Array([1, 2]);
  assert.deepEqual(fromOrt("a", { type: "float32", data: f32, dims: [2] }), { type: "float32", data: f32, dims: [2] });
  const i64 = new BigInt64Array([3n]);
  assert.equal(fromOrt("b", { type: "int64", data: i64, dims: [1] }).data, i64);
  const u16 = new Uint16Array([0x3c00]);
  assert.equal(fromOrt("c", { type: "float16", data: u16, dims: [1] }).data, u16);
  const F16 = (globalThis as { Float16Array?: new (xs: number[]) => ArrayBufferView }).Float16Array;
  if (F16) {
    const bits = fromOrt("d", { type: "float16", data: new F16([1, -2]), dims: [2] }).data;
    assert.ok(bits instanceof Uint16Array);
    assert.deepEqual([...bits], [0x3c00, 0xc000]);
  }
});

test("ort: an output type the port doesn't carry (or data that doesn't match its type) throws", () => {
  assert.throws(() => fromOrt("m", { type: "bool", data: new Uint8Array(1), dims: [1] }), /model output m: .*bool/);
  assert.throws(() => fromOrt("m", { type: "float32", data: new Float64Array(1), dims: [1] }), /float32/);
});
