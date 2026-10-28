/**
 * Display resizes against cv2.resize goldens. They match except for the differences pinned in KNOWN, which are
 * acceptable because no model sees these images.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resizeGray, resizeLinear8, resizeRGB, scaleRGB } from "../../src/render/internal/resize.kernel.ts";
import { type Known, json, noise, noiseBytes, npz, parity } from "../fixtures/numerics/lib.ts";

type Meta = {
  linear8: { key: string; C: number; seed: number; w: number; h: number; ow: number; oh: number }[];
  scale: { key: string; seed: number; w: number; h: number; s: number; ow: number; oh: number }[];
};
const meta = json<Meta>("raster.json");
const arr = npz("raster.npz");

const CV_SIMD =
  "OpenCV's SIMD vertical pass truncates, ((b0*(S0>>4))>>16 + (b1*(S1>>4))>>16 + 2)>>2; resizeLinear8 rounds " +
  "(b0*S0 + b1*S1 + 2^21)>>22 exactly";
const CV_FX = "cv2.resize(fx=s) maps coordinates with 1/s, scaleRGB with w/round(w*s); plus the SIMD rounding above";
const KNOWN: Record<string, Known> = {
  lin8_c3_16x11: { n: 67, maxDiff: 1, why: CV_SIMD },
  lin8_c3_80x50: { n: 1529, maxDiff: 1, why: CV_SIMD },
  lin8_c3_74x46: { n: 957, maxDiff: 1, why: CV_SIMD },
  lin8_c3_13x8: { n: 50, maxDiff: 1, why: CV_SIMD },
  lin8_c3_120x75: { n: 3432, maxDiff: 1, why: CV_SIMD },
  lin8_c1_16x11: { n: 17, maxDiff: 1, why: CV_SIMD },
  lin8_c1_80x50: { n: 510, maxDiff: 1, why: CV_SIMD },
  lin8_c1_74x46: { n: 341, maxDiff: 1, why: CV_SIMD },
  lin8_c1_13x8: { n: 11, maxDiff: 1, why: CV_SIMD },
  lin8_c1_120x75: { n: 1140, maxDiff: 1, why: CV_SIMD },
  "scale_12_0.35": { n: 293, maxDiff: 32, why: CV_FX },
  "scale_14_0.8": { n: 2210, maxDiff: 65, why: CV_FX },
};
/**
 * scaleRGB output sizes that differ from cv2.resize(fx=fy=s). Math.round rounds w*s = x.5 up and cv2's cvRound
 * rounds it to even. Each entry is the [w, h] that TS gives.
 */
const KNOWN_SIZE: Record<string, [number, number]> = { "scale_12_0.5": [19, 12], "scale_13_0.35": [14, 11] };

for (const c of meta.linear8)
  test(`resizeLinear8 C=${c.C} ${c.w}x${c.h} -> ${c.ow}x${c.oh} = cv2.resize(INTER_LINEAR)`, () => {
    const src = { w: c.w, h: c.h, data: noiseBytes(c.seed, c.w * c.h * c.C) };
    const ref = arr(c.key).data as Uint8Array;
    const out = resizeLinear8(src, c.C, c.ow, c.oh);
    parity(out.data, ref, KNOWN[c.key]);
    const via = c.C === 3 ? resizeRGB(src, c.ow, c.oh) : resizeGray(src, c.ow, c.oh);
    assert.deepEqual(via.data, out.data);
  });

test("resizeRGB to the same size returns the image itself", () => {
  const img = noise(1, 5, 4);
  assert.equal(resizeRGB(img, 5, 4), img);
});

for (const c of meta.scale)
  test(`scaleRGB ${c.w}x${c.h} by ${c.s} = cv2.resize(fx=fy=s)`, () => {
    const out = scaleRGB(noise(c.seed, c.w, c.h), c.s);
    const size = KNOWN_SIZE[c.key];
    if (size) {
      assert.deepEqual([out.w, out.h], size, "known size mismatch (Math.round vs cvRound) changed");
      assert.notDeepEqual(size, [c.ow, c.oh]);
      return;
    }
    assert.deepEqual([out.w, out.h], [c.ow, c.oh]);
    parity(out.data, arr(c.key).data as Uint8Array, KNOWN[c.key]);
  });
