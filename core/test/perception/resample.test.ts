/**
 * Every result matches torch exactly, including torchLinear's FMA cases and upsampleMask's threshold case. The last
 * tests show that the naive arithmetic gets those two wrong.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { linearTables, resizeAA, torchLinear, upsampleMask } from "../../src/perception/internal/resample.kernel.ts";
import { unpackbits } from "../../src/storage/internal/npz.kernel.ts";
import { maskArea } from "../../src/pixels/index.ts";
import { json, noise, npz, parity } from "../fixtures/numerics/lib.ts";

type Meta = {
  aa: { key: string; kind: "bilinear" | "bicubic"; seed: number; w: number; h: number; ow: number; oh: number }[];
  lin: { key: string; in: number; out: number }[];
  upsample: { key: string; W: number; H: number; threshold: number; count: number }[];
};
const meta = json<Meta>("raster.json");
const arr = npz("raster.npz");

for (const c of meta.aa)
  test(`resizeAA ${c.kind} ${c.w}x${c.h} -> ${c.ow}x${c.oh} = torchvision resize(antialias=True)`, () => {
    const out = resizeAA(noise(c.seed, c.w, c.h), c.ow, c.oh, c.kind);
    assert.deepEqual([out.w, out.h], [c.ow, c.oh]);
    parity(out.data, arr(c.key).data as Uint8Array);
  });

test("resizeAA to the same size copies", () => {
  const img = noise(3, 7, 5);
  const out = resizeAA(img, 7, 5, "bilinear");
  assert.notEqual(out.data, img.data);
  assert.deepEqual(out.data, img.data);
});

for (const c of meta.lin)
  test(`torchLinear ${c.in} -> ${c.out} = torch upsample_bilinear2d(align_corners=False) weights (exact)`, () => {
    const t = linearTables(c.in, 1, c.out, 1).x;
    const idx = arr(`${c.key}_idx`).data as Int32Array;
    const w = arr(`${c.key}_w`).data as Float32Array;
    const mine: number[] = [],
      theirs: number[] = [];
    for (let d = 0; d < c.out; d++) {
      const col = new Map<number, number>();
      col.set(t.i0[d]!, t.l0[d]!);
      col.set(t.i1[d]!, Math.fround((col.get(t.i1[d]!) ?? 0) + t.l1[d]!));
      const nz = [...col].filter(([, v]) => v !== 0).sort((a, b) => a[0] - b[0]);
      const ref: [number, number][] = [];
      for (let k = 0; k < 2; k++) if (idx[d * 2 + k]! >= 0) ref.push([idx[d * 2 + k]!, w[d * 2 + k]!]);
      assert.deepEqual(
        nz.map(([i]) => i),
        ref.map(([i]) => i),
        `source indices of output ${d}`,
      );
      mine.push(nz.at(-1)?.[1] ?? 0);
      theirs.push(ref.at(-1)?.[1] ?? 0);
    }
    parity(mine, theirs);
  });

const probs = Float32Array.from(arr("blob_levels").data as Uint8Array, (v) => v / 255);

const full = (r: ReturnType<typeof upsampleMask>, W: number, H: number) => {
  const out = new Uint8Array(W * H);
  if (r) {
    const [x0, y0, x1, y1] = r.box;
    const bw = x1 - x0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * W + x] = r.mask[(y - y0) * bw + x - x0]!;
  }
  return out;
};

for (const c of meta.upsample)
  test(`upsampleMask 288² -> ${c.W}x${c.H} > ${c.threshold} = F.interpolate(bilinear) > t (exact)`, () => {
    const r = upsampleMask(probs, 288, 288, c.W, c.H, c.threshold);
    parity(full(r, c.W, c.H), unpackbits(arr(c.key).data as Uint8Array, c.W * c.H));
    assert.equal(r?.area ?? 0, r ? maskArea(r.mask) : 0, "area counted while upsampling = its set pixels");
  });

test("upsampleMask: nothing above the threshold -> null", () => {
  assert.equal(upsampleMask(new Float32Array(16).fill(0.5), 4, 4, 9, 9, 0.5), null);
});

/** torchLinear lambdas (l1) with the product and the -0.5 rounded separately (not torch's fma). */
function twoRoundingLambdas(inSize: number, outSize: number): Float32Array {
  const fr = Math.fround;
  const scale = fr(inSize / outSize);
  return Float32Array.from({ length: outSize }, (_, d) => {
    const s = Math.max(0, fr(fr(scale * fr(d + 0.5)) - 0.5));
    return fr(s - Math.trunc(s));
  });
}

test("torchLinear: the source index rounds once, as torch's fma", () => {
  // from 288 to 1008, rounding scale*(d+0.5) and then the -0.5 moves some lambdas by 1 ulp
  const mine = torchLinear(288, 1008);
  const twice = twoRoundingLambdas(288, 1008);
  let diff = 0;
  for (let d = 0; d < 1008; d++) if (mine.l1[d] !== twice[d]) diff++;
  assert.equal(diff, 10, "10 lambdas of lin_288_1008 differ");
  const s = Math.fround(288 / 1008);
  for (let d = 0; d < 1008; d++) {
    const src = Math.max(0, Math.fround(s * (d + 0.5) - 0.5));
    assert.equal(mine.l1[d], Math.fround(src - Math.trunc(src)));
  }
});

test("upsampleMask: the threshold is compared as float32", () => {
  const t = 0.3;
  const p = new Float32Array(16).fill(0);
  p[5] = Math.fround(t); // exactly float32(0.3), which torch drops (not > float32(0.3))
  assert.equal(upsampleMask(p, 4, 4, 4, 4, t), null);
  assert.ok(p[5] > t, "a comparison with the double threshold would keep this pixel");
});
