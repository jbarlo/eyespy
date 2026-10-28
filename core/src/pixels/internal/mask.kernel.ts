import type { Box, MeasuredMask, Shape } from "../types.ts";

export function maskArea(m: Uint8Array): number {
  let a = 0;
  for (let i = 0; i < m.length; i++) a += m[i]!;
  return a;
}

/**
 * Intersection over union of two masks in one frame, each cropped to its box. It is 0 if the boxes don't meet.
 * The union uses each mask's `area`, so alias checks and NMS, which run per pair, never recount a mask.
 */
export function maskIou(a: MeasuredMask, b: MeasuredMask): number {
  const [ax0, ay0, ax1, ay1] = a.box;
  const [bx0, by0, bx1, by1] = b.box;
  const x0 = Math.max(ax0, bx0),
    y0 = Math.max(ay0, by0),
    x1 = Math.min(ax1, bx1),
    y1 = Math.min(ay1, by1);
  if (x0 >= x1 || y0 >= y1) return 0;
  const aw = ax1 - ax0,
    bw = bx1 - bx0;
  // Copy to locals. Callers pass several object shapes (Instances in NMS, Detections in alias checks), and V8 won't
  // hoist a polymorphic `a.mask` load out of the pixel loop.
  const am = a.mask,
    bm = b.mask;
  let inter = 0;
  for (let y = y0; y < y1; y++) {
    const ra = (y - ay0) * aw - ax0,
      rb = (y - by0) * bw - bx0;
    for (let x = x0; x < x1; x++) inter += am[ra + x]! & bm[rb + x]!;
  }
  return inter / (a.area + b.area - inter);
}

/** Rectangular k×k dilation of a 0/1 mask inside its own frame. Pixels outside don't count, as in cv2's default. */
export function dilate(m: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const r = k >> 1;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = Math.max(0, x - r); d <= Math.min(w - 1, x + r) && !v; d++) v = m[y * w + d]!;
      tmp[y * w + x] = v;
    }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = Math.max(0, y - r); d <= Math.min(h - 1, y + r) && !v; d++) v = tmp[d * w + x]!;
      out[y * w + x] = v;
    }
  return out;
}

/** Rebuilds the 0/1 mask of `size` pixels that `runLengths` turned into `counts`. Runs past the end are cut off. */
export function fromRunLengths(counts: readonly number[], size: number): Uint8Array {
  const m = new Uint8Array(size);
  let p = 0,
    v = 0;
  for (const n of counts) {
    if (v) m.fill(1, p, p + n);
    p += n;
    v ^= 1;
  }
  return m;
}

/** Run lengths of a 0/1 mask. Runs alternate and start with the 0 run, which may be empty. */
export function runLengths(m: Uint8Array): number[] {
  const out: number[] = [];
  let cur = 0,
    n = 0;
  for (let i = 0; i < m.length; i++) {
    const v = m[i] ? 1 : 0;
    if (v === cur) n++;
    else {
      out.push(n);
      cur = v;
      n = 1;
    }
  }
  out.push(n);
  return out;
}

/** A frame mask ([h, w]) with 1 wherever any of the box-cropped masks is set. */
export function paintMasks(regions: readonly { readonly box: Box; readonly mask: Uint8Array }[], [h, w]: Shape) {
  const m = new Uint8Array(w * h);
  for (const d of regions) {
    const [x0, y0, x1, y1] = d.box;
    const bw = x1 - x0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (d.mask[(y - y0) * bw + x - x0]) m[y * w + x] = 1;
  }
  return m;
}
