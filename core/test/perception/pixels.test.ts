/**
 * References: Sam3Processor for samPixels, BitImageProcessor for dinoPixels, post_process_instance_segmentation for
 * keepInstances and upsampleMask.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dinoPixels, regionCrop } from "../../src/perception/internal/dino/pixels.kernel.ts";
import { upsampleMask } from "../../src/perception/internal/resample.kernel.ts";
import {
  concatF16,
  heatmapGray,
  keepInstances,
  samPixels,
  splitF32,
} from "../../src/perception/internal/sam/pixels.kernel.ts";
import { FEATURE_PLANES, FEATURE_TOTAL, MASK_SIZE } from "../../src/perception/pure.ts";
import { PlanesPool } from "../../src/perception/internal/sam/planes.cache.ts";
import { f16ToF32, f32ToF16 } from "../../src/pixels/index.ts";
import { unpackbits } from "../../src/storage/internal/npz.kernel.ts";
import { crop, dilate } from "../../src/pixels/index.ts";
import { json, noise, noiseBytes, npz, parity, sha256 } from "../fixtures/numerics/lib.ts";

type Px = { key: string; seed: number; w: number; h: number; sha256: string };
type Meta = {
  step: number;
  sam: Px[];
  dino: Px[];
  keep: {
    pred_logits: number[];
    presence: number;
    cases: { key: string; threshold: number; size: [number, number] | null; scores_f32_bits: number[]; n: number }[];
  };
};
const meta = json<Meta>("models.json");
const arr = npz("models.npz");
const strided = (a: Float32Array, step: number) => a.filter((_, i) => i % step === 0);

for (const c of meta.sam)
  test(`samPixels ${c.w}x${c.h} = Sam3Processor pixel_values (bit-exact)`, () => {
    const px = samPixels(noise(c.seed, c.w, c.h));
    assert.equal(px.length, 3 * 1008 * 1008);
    parity(strided(px, meta.step), arr(c.key).data as Float32Array);
    assert.equal(sha256(px), c.sha256);
  });

for (const c of meta.dino)
  test(`dinoPixels ${c.w}x${c.h} = BitImageProcessor pixel_values (bit-exact)`, () => {
    const P = 3 * 224 * 224;
    const out = new Float32Array(P + 5).fill(-7);
    dinoPixels(noise(c.seed, c.w, c.h), out, 5);
    assert.deepEqual([...out.subarray(0, 5)], [-7, -7, -7, -7, -7]);
    const px = out.subarray(5);
    parity(strided(px, meta.step), arr(c.key).data as Float32Array);
    assert.equal(sha256(px), c.sha256);
  });

const M = MASK_SIZE * MASK_SIZE;
const levels = arr("keep_levels").data as Uint8Array;
const output = {
  logits: Float32Array.from(meta.keep.pred_logits),
  presence: meta.keep.presence,
  masks: Float32Array.from(levels, (v) => (v - 128) / 16),
  semantic: null,
};

for (const c of meta.keep.cases)
  test(`keepInstances(> ${c.threshold}) + upsampleMask to ${c.size?.join("x") ?? "288x288"} = post_process_instance_segmentation`, () => {
    const kept = keepInstances(output, c.threshold);
    const bits = new Uint32Array(Float32Array.from(kept.map((k) => k.score)).buffer);
    assert.deepEqual([...bits], c.scores_f32_bits);
    const [H, W] = c.size ?? [MASK_SIZE, MASK_SIZE];
    const ref = unpackbits(arr(c.key).data as Uint8Array, c.n * H * W);
    kept.forEach((k, q) => {
      const full = new Uint8Array(W * H);
      if (c.size) {
        const r = upsampleMask(k.probs, MASK_SIZE, MASK_SIZE, W, H, 0.5);
        if (r) {
          const [x0, y0, x1, y1] = r.box;
          for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) full[y * W + x] = r.mask[(y - y0) * (x1 - x0) + x - x0]!;
        }
      } else for (let i = 0; i < M; i++) full[i] = k.probs[i]! > 0.5 ? 1 : 0;
      parity(full, ref.subarray(q * W * H, (q + 1) * W * H));
    });
  });

test("keepInstances: a score equal to float32(threshold) is dropped, as torch does", () => {
  // a huge presence logit gives sigmoid 1 in float32, so pick a logit whose float32 score is exactly float32(t)
  const t = Math.fround(0.3);
  const logit = Math.log(t / (1 - t));
  const out = { logits: Float32Array.of(logit), presence: 40, masks: new Float32Array(M), semantic: null };
  assert.ok(t > 0.3, "a comparison with the double 0.3 would keep it");
  assert.deepEqual(keepInstances(out, 0.3), []);
});

test("concatF16 / splitF32 = the encode concat and detector feeds", () => {
  const planes = FEATURE_PLANES.map((p, k) =>
    Float32Array.from({ length: p.len }, (_, i) => ((i * 7 + k) % 1000) / 37),
  );
  const f = concatF16(planes);
  assert.equal(f.length, FEATURE_TOTAL);
  let off = 0;
  const want = new Uint16Array(FEATURE_TOTAL);
  for (const p of planes) {
    f32ToF16(p, want.subarray(off, off + p.length));
    off += p.length;
  }
  assert.deepEqual(f, want);
  // caller planes hold stale values, as the reused detector buffers do, and every value gets overwritten
  const out = FEATURE_PLANES.map((p) => new Float32Array(p.len).fill(NaN));
  const back = splitF32(f, out);
  assert.equal(back, out);
  off = 0;
  back.forEach((b, k) => {
    assert.deepEqual(b, f16ToF32(want.subarray(off, off + FEATURE_PLANES[k]!.len)));
    off += b.length;
  });
  const short = FEATURE_PLANES.map((p, k) => new Float32Array(k === 1 ? p.len - 1 : p.len));
  assert.throws(() => splitF32(f, short), /features_144 buffer has/);
  assert.throws(() => concatF16(planes.slice(0, 2)), /index 2 out of range/);
});

test("PlanesPool: one kept set reused across calls; overlapping takes never share planes", () => {
  const pool = new PlanesPool();
  const a = pool.take();
  assert.deepEqual(
    a.map((p) => p.length),
    FEATURE_PLANES.map((p) => p.len),
  );
  const b = pool.take(); // `a` is still out, so take() returns a new set
  assert.notEqual(a, b);
  pool.give(a);
  assert.equal(pool.take(), a);
  assert.notEqual(pool.take(), a);
});

test("heatmapGray: trunc(float32(sigmoid(logit)) · 255) per value, MASK_SIZE²", () => {
  const s = Float32Array.from(noiseBytes(9, M), (v) => (v - 128) / 9);
  const g = heatmapGray(s);
  assert.deepEqual([g.w, g.h], [MASK_SIZE, MASK_SIZE]);
  const want = new Uint8Array(M);
  for (let k = 0; k < M; k++) want[k] = Math.trunc(Math.fround(1 / (1 + Math.exp(-s[k]!))) * 255);
  assert.deepEqual(g.data, want);
});

test("regionCrop: the box crop, grey outside the 9-px dilated mask", () => {
  const img = noise(4, 60, 40);
  const box = [10, 5, 41, 30] as const;
  const [w, h] = [box[2] - box[0], box[3] - box[1]];
  const mask = Uint8Array.from(noiseBytes(5, w * h), (v) => (v > 250 ? 1 : 0));
  const want = crop(img, ...box);
  const m = dilate(mask, w, h, 9);
  for (let p = 0; p < w * h; p++) if (!m[p]) want.data.fill(128, p * 3, p * 3 + 3);
  assert.deepEqual(regionCrop(img, { box, mask }), want);
});
