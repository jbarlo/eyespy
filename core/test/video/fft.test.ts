import assert from "node:assert/strict";
import { test } from "node:test";
import { FFT, FFT2 } from "../../src/video/internal/fft.kernel.ts";
import { json, noiseBytes } from "../fixtures/numerics/lib.ts";

type Cx = [number[], number[]];
type Meta = {
  "1d": { n: number; re_seed: number; im_seed: number; fwd: Cx; inv: Cx }[];
  "2d": { w: number; h: number; seed: number; fwd: Cx }[];
};
const meta = json<Meta>("fft.json");

const signal = (seed: number, n: number) => Float64Array.from(noiseBytes(seed, n), (v) => v - 128);

/** Max abs difference, against a tolerance that scales with the transform's magnitude (inputs are ±128). */
function close(re: Float64Array, im: Float64Array, want: Cx, n: number) {
  const tol = 1e-12 * 128 * n * Math.max(1, Math.log2(n));
  let max = 0;
  for (let k = 0; k < re.length; k++)
    max = Math.max(max, Math.abs(re[k]! - want[0][k]!), Math.abs(im[k]! - want[1][k]!));
  assert.ok(max <= tol, `max |diff| ${max} > ${tol}`);
}

for (const c of meta["1d"])
  test(`FFT n=${c.n} forward and unnormalised inverse = numpy.fft`, () => {
    const fft = new FFT(c.n);
    for (const [inverse, want] of [
      [false, c.fwd],
      [true, c.inv],
    ] as const) {
      // the strided, offset layout FFT2 uses, with element k at 3 + 2k
      const re = new Float64Array(3 + 2 * c.n),
        im = new Float64Array(3 + 2 * c.n);
      const sr = signal(c.re_seed, c.n),
        si = signal(c.im_seed, c.n);
      for (let k = 0; k < c.n; k++) {
        re[3 + 2 * k] = sr[k]!;
        im[3 + 2 * k] = si[k]!;
      }
      fft.run(re, im, 3, 2, inverse);
      const pick = (a: Float64Array) => Float64Array.from({ length: c.n }, (_, k) => a[3 + 2 * k]!);
      close(pick(re), pick(im), want, c.n);
    }
  });

for (const c of meta["2d"])
  test(`FFT2 ${c.w}x${c.h} = numpy.fft.fft2`, () => {
    const re = signal(c.seed, c.w * c.h),
      im = new Float64Array(c.w * c.h);
    new FFT2(c.w, c.h).run(re, im, false);
    close(re, im, c.fwd, c.w * c.h);
  });
