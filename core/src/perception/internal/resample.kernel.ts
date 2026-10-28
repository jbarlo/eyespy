/**
 * Resamplers that match the models' torch code. One is torch's antialiased uint8 resize, which HF image processors
 * use to resize SAM and DINOv2 inputs. The other is torch upsample_bilinear2d(align_corners=False), for the
 * detector's MASK_SIZE² mask logits. Both match torch references exactly because of two details:
 *   - torchLinear rounds the source index scale*(d+0.5)-0.5 once, like torch's fma. It computes in double, where
 *     the product and difference are exact, then calls Math.fround once. Rounding twice is off by an ulp.
 *   - upsampleMask compares the float32 values with Math.fround(threshold), as torch compares float32 tensors with
 *     a float32 scalar. Comparing with the double would keep a value equal to fround(0.3).
 */
import type { MeasuredMask, RGB } from "../../pixels/index.ts";

const fr = Math.fround;

// Antialiased resize, as in torch's uint8 CPU kernel (torchvision resize(antialias=True) in HF processors).

function bilinearFilter(x: number): number {
  const a = Math.abs(x);
  return a < 1 ? 1 - a : 0;
}
function bicubicFilter(x: number): number {
  const a = -0.5;
  const ax = Math.abs(x);
  return ax < 1 ? ((a + 2) * ax - (a + 3)) * ax * ax + 1 : ax < 2 ? (((ax - 5) * ax + 8) * ax - 4) * a : 0;
}

export type AAKind = "bilinear" | "bicubic";
type Coeffs = {
  readonly lo: Int32Array;
  readonly n: Int32Array;
  readonly k: Int32Array;
  readonly size: number;
  readonly precision: number;
};

/** As torch `_compute_index_ranges_int16_weights`, double weights, then int16 with the largest safe precision. */
function aaCoeffs(inSize: number, outSize: number, kind: AAKind): Coeffs {
  const interp = kind === "bilinear" ? 2 : 4;
  const filter = kind === "bilinear" ? bilinearFilter : bicubicFilter;
  const scale = inSize / outSize;
  const support = scale >= 1 ? interp * 0.5 * scale : interp * 0.5;
  const size = Math.ceil(support) * 2 + 1;
  const invscale = scale >= 1 ? 1 / scale : 1;
  const lo = new Int32Array(outSize);
  const n = new Int32Array(outSize);
  const w = new Float64Array(outSize * size);
  let wtMax = 0;
  for (let i = 0; i < outSize; i++) {
    const center = scale * (i + 0.5);
    const xmin = Math.max(Math.trunc(center - support + 0.5), 0);
    const xsize = Math.min(Math.max(Math.min(Math.trunc(center + support + 0.5), inSize) - xmin, 0), size);
    let total = 0;
    for (let j = 0; j < xsize; j++) {
      const v = filter((j + xmin - center + 0.5) * invscale);
      w[i * size + j] = v;
      total += v;
    }
    if (total !== 0)
      for (let j = 0; j < xsize; j++) {
        const v = w[i * size + j]! / total;
        w[i * size + j] = v;
        wtMax = Math.max(wtMax, v);
      }
    lo[i] = xmin;
    n[i] = xsize;
  }
  let precision = 0;
  for (; precision < 22; precision++) {
    if (Math.trunc(0.5 + wtMax * (1 << (precision + 1))) >= 1 << 15) break;
  }
  const k = new Int32Array(w.length);
  for (let j = 0; j < w.length; j++) {
    const v = w[j]! * (1 << precision);
    k[j] = Math.trunc(v < 0 ? v - 0.5 : v + 0.5);
  }
  return { lo, n, k, size, precision };
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Separable antialiased resize of interleaved uint8 RGB, horizontal then vertical, with uint8 in between. */
export function resizeAA(src: RGB, ow: number, oh: number, kind: AAKind): RGB {
  const C = 3;
  let cur = src;
  if (ow !== src.w) {
    const H = aaCoeffs(src.w, ow, kind);
    const out = new Uint8Array(src.h * ow * C);
    const half = 1 << (H.precision - 1);
    for (let y = 0; y < src.h; y++) {
      const row = y * src.w * C;
      for (let o = 0; o < ow; o++) {
        const x0 = H.lo[o]!;
        const kb = o * H.size;
        let r = half,
          g = half,
          b = half;
        for (let i = 0; i < H.n[o]!; i++) {
          const p = row + (x0 + i) * C;
          const kk = H.k[kb + i]!;
          r += src.data[p]! * kk;
          g += src.data[p + 1]! * kk;
          b += src.data[p + 2]! * kk;
        }
        const q = (y * ow + o) * C;
        out[q] = clamp8(r >> H.precision);
        out[q + 1] = clamp8(g >> H.precision);
        out[q + 2] = clamp8(b >> H.precision);
      }
    }
    cur = { w: ow, h: src.h, data: out };
  }
  if (oh !== cur.h) {
    const V = aaCoeffs(cur.h, oh, kind);
    const out = new Uint8Array(oh * ow * C);
    const half = 1 << (V.precision - 1);
    const stride = ow * C;
    for (let o = 0; o < oh; o++) {
      const y0 = V.lo[o]!;
      const kb = o * V.size;
      for (let x = 0; x < stride; x++) {
        let s = half;
        for (let i = 0; i < V.n[o]!; i++) s += cur.data[(y0 + i) * stride + x]! * V.k[kb + i]!;
        out[o * stride + x] = clamp8(s >> V.precision);
      }
    }
    cur = { w: ow, h: oh, data: out };
  }
  return cur === src ? { w: src.w, h: src.h, data: src.data.slice() } : cur;
}

/** The two source indices and their float32 weights, for each output index. */
export type Lin = {
  readonly i0: Int32Array;
  readonly i1: Int32Array;
  readonly l0: Float32Array;
  readonly l1: Float32Array;
};

/**
 * Index and weight tables for torch upsample_bilinear2d(align_corners=False), in float32 like the CPU kernel. Scale
 * is float32 and d+0.5 needs about 12 bits, so scale*(d+0.5)-0.5 is exact in double.
 * @internal
 */
export function torchLinear(inSize: number, outSize: number): Lin {
  const scale = fr(inSize / outSize);
  const i0 = new Int32Array(outSize),
    i1 = new Int32Array(outSize);
  const l0 = new Float32Array(outSize),
    l1 = new Float32Array(outSize);
  for (let d = 0; d < outSize; d++) {
    let s = fr(scale * (d + 0.5) - 0.5);
    if (s < 0) s = 0;
    const a = Math.trunc(s);
    const lam = fr(s - a);
    i0[d] = a;
    i1[d] = a + (a < inSize - 1 ? 1 : 0);
    l1[d] = lam;
    l0[d] = fr(1 - lam);
  }
  return { i0, i1, l0, l1 };
}

export type LinTables = { readonly x: Lin; readonly y: Lin };

export const linearTables = (sw: number, sh: number, W: number, H: number): LinTables => ({
  x: torchLinear(sw, W),
  y: torchLinear(sh, H),
});

/**
 * HF post-processing for one instance. It takes probabilities (after sigmoid) at sw×sh, resizes them bilinearly
 * to W×H and keeps pixels > float32(threshold). It returns the box [x0,y0,x1,y1) of the kept pixels, the mask
 * cropped to it and its area, or null if empty. It counts the area while copying the crop, so nothing downstream
 * recounts. It evaluates only output pixels whose source neighbourhood holds a value above the threshold. This is
 * exact, because a bilinear value can't exceed its four inputs.
 */
export function upsampleMask(
  probs: Float32Array,
  sw: number,
  sh: number,
  W: number,
  H: number,
  threshold: number,
  tables?: LinTables,
): MeasuredMask | null {
  const t32 = fr(threshold);
  const tx = tables?.x ?? torchLinear(sw, W);
  const ty = tables?.y ?? torchLinear(sh, H);
  let sx0 = sw,
    sy0 = sh,
    sx1 = -1,
    sy1 = -1;
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++)
      if (probs[y * sw + x]! > t32) {
        if (x < sx0) sx0 = x;
        if (x > sx1) sx1 = x;
        if (y < sy0) sy0 = y;
        if (y > sy1) sy1 = y;
      }
  if (sx1 < 0) return null;
  // the output range whose source indices touch [sx0-1, sx1+1]
  const rangeOf = (t: Lin, a: number, b: number, n: number): readonly [number, number] => {
    let lo = n,
      hi = -1;
    for (let d = 0; d < n; d++)
      if (t.i1[d]! >= a && t.i0[d]! <= b) {
        if (d < lo) lo = d;
        hi = d;
      }
    return [lo, hi];
  };
  const [ox0, ox1] = rangeOf(tx, sx0, sx1, W);
  const [oy0, oy1] = rangeOf(ty, sy0, sy1, H);
  const bw = ox1 - ox0 + 1,
    bh = oy1 - oy0 + 1;
  const tmp = new Uint8Array(bw * bh);
  let mx0 = W,
    my0 = H,
    mx1 = -1,
    my1 = -1;
  for (let y = oy0; y <= oy1; y++) {
    const r0 = ty.i0[y]! * sw,
      r1 = ty.i1[y]! * sw,
      h0 = ty.l0[y]!,
      h1 = ty.l1[y]!;
    for (let x = ox0; x <= ox1; x++) {
      const c0 = tx.i0[x]!,
        c1 = tx.i1[x]!,
        w0 = tx.l0[x]!,
        w1 = tx.l1[x]!;
      const top = fr(fr(w0 * probs[r0 + c0]!) + fr(w1 * probs[r0 + c1]!));
      const bot = fr(fr(w0 * probs[r1 + c0]!) + fr(w1 * probs[r1 + c1]!));
      const v = fr(fr(h0 * top) + fr(h1 * bot));
      if (v > t32) {
        tmp[(y - oy0) * bw + (x - ox0)] = 1;
        if (x < mx0) mx0 = x;
        if (x > mx1) mx1 = x;
        if (y < my0) my0 = y;
        if (y > my1) my1 = y;
      }
    }
  }
  if (mx1 < 0) return null;
  const cw = mx1 - mx0 + 1,
    ch = my1 - my0 + 1;
  const mask = new Uint8Array(cw * ch);
  let area = 0;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const v = tmp[(y + my0 - oy0) * bw + (x + mx0 - ox0)]!;
      mask[y * cw + x] = v;
      area += v;
    }
  return { box: [mx0, my0, mx1 + 1, my1 + 1], mask, area };
}
