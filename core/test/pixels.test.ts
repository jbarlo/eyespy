/** References: a numpy slice for crop, cv2.dilate for dilate. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blank,
  crop,
  cropBox,
  dilate,
  hstack,
  isNonEmpty,
  maskArea,
  maskIou,
  paste,
  vstack,
  type Box,
  type MeasuredMask,
  type RGB,
} from "../src/pixels/index.ts";
import { json, noise, noiseBytes, npz, parity, sha256 } from "./fixtures/numerics/lib.ts";

type Meta = {
  dilate: { key: string; k: number; w: number; h: number }[];
  crop: { seed: number; w: number; h: number; box: [number, number, number, number] };
};
const meta = json<Meta>("raster.json");
const arr = npz("raster.npz");

test("crop = numpy slice", () => {
  const { seed, w, h, box } = meta.crop;
  const out = crop(noise(seed, w, h), ...box);
  assert.deepEqual([out.w, out.h], [box[2] - box[0], box[3] - box[1]]);
  parity(out.data, arr("crop").data as Uint8Array);
  assert.deepEqual(cropBox(noise(seed, w, h), box), out);
});

const dsrc = arr("dilate_src").data as Uint8Array;
for (const c of meta.dilate)
  test(`dilate k=${c.k} = cv2.dilate(ones(k,k))`, () => {
    parity(dilate(dsrc, c.w, c.h, c.k), arr(c.key).data as Uint8Array);
  });

const tiles: RGB[] = [noise(1, 7, 5), noise(2, 4, 5), noise(3, 9, 5)];
const column: RGB[] = [noise(4, 6, 3), noise(5, 6, 8)];

/** [w, h, sha256(data)], compared with recorded values for the same inputs. */
const shape = (i: RGB) => [i.w, i.h, sha256(i.data)];

test("blank / paste / hstack / vstack = recorded outputs", () => {
  assert.deepEqual(shape(blank(3, 2, 7)), [3, 2, "15d74f49bd431d569afe29cac7d4cce5f8b84f47b18436fa80be248e220474ca"]);
  assert.deepEqual(shape(blank(3, 2)), [3, 2, "60daa3a5f7dbfa200f8c82840ecf5b42640b70f3b7218a4c6bbd67db542e75a4"]);
  const a = blank(10, 9);
  paste(a, tiles[0]!, 2, 3);
  assert.deepEqual(shape(a), [10, 9, "07d20033b7cd1f02e9fd72a115d746095fc25a1c5f2ae0d19c822ae3a7720681"]);
  assert.ok(isNonEmpty(tiles) && isNonEmpty(column));
  assert.deepEqual(shape(hstack(tiles)), [20, 5, "b16296b390358c9ec269b9298d2162d78bc82553311f078858a60b73c7ddafb0"]);
  assert.deepEqual(shape(vstack(column)), [6, 11, "304d7fb62ab27bbc36fcb267fe7094366556aba838b4c85bb3b501498a83dd7c"]);
  assert.equal(isNonEmpty([]), false);
});

test("maskArea / maskIou = recorded values", () => {
  const box = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y1] as const;
  const mask = (seed: number, w: number, h: number) => noiseBytes(seed, w * h).map((v) => (v > 100 ? 1 : 0));
  const measured = (b: Box, m: Uint8Array): MeasuredMask => ({ box: b, mask: m, area: maskArea(m) });
  const ma = measured(box(2, 3, 12, 11), mask(11, 10, 8));
  const mb = measured(box(6, 1, 15, 9), mask(12, 9, 8));
  const far = measured(box(20, 20, 25, 25), mask(13, 5, 5));
  assert.equal(ma.area, 45);
  assert.equal(maskIou(ma, mb), 0.1506849315068493);
  assert.equal(maskIou(mb, ma), 0.1506849315068493);
  assert.equal(maskIou(ma, far), 0);
  assert.equal(maskIou(ma, ma), 1);
});

test("maskIou uses the given area, never recounts (alias checks and NMS run per pair)", () => {
  const ma = { box: [0, 0, 4, 1] as const, mask: Uint8Array.of(1, 1, 0, 0), area: 2 };
  const mb = { box: [0, 0, 4, 1] as const, mask: Uint8Array.of(1, 0, 0, 0), area: 1 };
  assert.equal(maskIou(ma, mb), 1 / 2);
  // with a wrong area of 9 for `ma`, the union is 9 + 1 - 1
  assert.equal(maskIou({ ...ma, area: 9 }, mb), 1 / 9);
});
