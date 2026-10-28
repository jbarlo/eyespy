/**
 * Keyframe picking spaced by motion. Laplacian variance measures sharpness, and Hann-windowed phase correlation of
 * consecutive grey frames measures camera shift. It emits the sharpest frame since the last pick each time the
 * accumulated shift reaches `thresh`.
 */
import { FFT2 } from "./fft.kernel.ts";

/** As cv2.createHanningWindow((w, h), CV_32F), the sqrt of the outer product of two Hann windows. @internal */
export function hanning(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const c0 = (2 * Math.PI) / (w - 1),
    c1 = (2 * Math.PI) / (h - 1);
  const wc = Array.from({ length: w }, (_, j) => 0.5 * (1 - Math.cos(c0 * j)));
  for (let i = 0; i < h; i++) {
    const wr = 0.5 * (1 - Math.cos(c1 * i));
    for (let j = 0; j < w; j++) out[i * w + j] = Math.sqrt(wr * wc[j]!);
  }
  return out;
}

/** var(cv2.Laplacian(f, CV_32F)) with ksize 1 (4-neighbour kernel) and BORDER_REFLECT_101. @internal */
export function laplacianVar(f: Uint8Array, w: number, h: number): number {
  const at = (x0: number, y0: number) => {
    const x = x0 < 0 ? -x0 : x0 >= w ? 2 * w - 2 - x0 : x0;
    const y = y0 < 0 ? -y0 : y0 >= h ? 2 * h - 2 - y0 : y0;
    return f[y * w + x]!;
  };
  let s = 0,
    s2 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) - 4 * f[y * w + x]!;
      s += v;
      s2 += v * v;
    }
  const n = w * h;
  return s2 / n - (s / n) ** 2;
}

/**
 * Spectra of `a` windowed `passesA` times and `b` windowed once, with float32 products, at the frames' own size
 * (no zero padding). In pickTimes every frame but the first is windowed twice as the earlier frame of a pair and once
 * as the later one, so every pair after the first is weighted the same way.
 */
function spectra(fft: FFT2, a: Uint8Array, passesA: number, b: Uint8Array, win: Float32Array) {
  const { w, h } = fft;
  const n = a.length;
  // Both real inputs go in one complex FFT, z = a + i·b.
  const zr = new Float64Array(n),
    zi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = Math.fround(win[i]! * a[i]!);
    if (passesA === 2) v = Math.fround(win[i]! * v);
    zr[i] = v;
    zi[i] = Math.fround(win[i]! * b[i]!);
  }
  fft.run(zr, zi, false);
  // A[k] = (Z[k] + conj Z[-k]) / 2,  B[k] = (Z[k] - conj Z[-k]) / 2i
  const A = { re: new Float64Array(n), im: new Float64Array(n) };
  const B = { re: new Float64Array(n), im: new Float64Array(n) };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x,
        j = ((h - y) % h) * w + ((w - x) % w);
      const pr = zr[k]!,
        pi = zi[k]!,
        qr = zr[j]!,
        qi = -zi[j]!;
      A.re[k] = (pr + qr) / 2;
      A.im[k] = (pi + qi) / 2;
      B.re[k] = (pi - qi) / 2;
      B.im[k] = -(pr - qr) / 2;
    }
  return { A, B };
}

/**
 * The shift (dx, dy) between two frames given their spectra: the peak of the normalised cross-power spectrum's
 * inverse, refined by a 5×5 weighted centroid.
 */
function phaseCorrelate(
  fft: FFT2,
  A: { re: Float64Array; im: Float64Array },
  B: { re: Float64Array; im: Float64Array },
): [number, number] {
  const { w, h } = fft;
  const n = w * h;
  const re = new Float64Array(n),
    im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // A * conj(B), normalised to unit magnitude
    const r = A.re[i]! * B.re[i]! + A.im[i]! * B.im[i]!;
    const q = A.im[i]! * B.re[i]! - A.re[i]! * B.im[i]!;
    const mag = Math.sqrt(r * r + q * q);
    re[i] = mag > 0 ? r / mag : 0;
    im[i] = mag > 0 ? q / mag : 0;
  }
  fft.run(re, im, true);
  // fftShift (even sizes), then find the peak
  const C = new Float64Array(n);
  const cx = w >> 1,
    cy = h >> 1;
  let best = -Infinity,
    px = 0,
    py = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = re[y * w + x]!;
      const sx = (x + cx) % w,
        sy = (y + cy) % h;
      C[sy * w + sx] = v;
    }
  for (let i = 0; i < n; i++)
    if (C[i]! > best) {
      best = C[i]!;
      px = i % w;
      py = (i / w) | 0;
    }
  // 5×5 weighted centroid, clamped at the borders
  let sx = 0,
    sy = 0,
    sum = 0;
  for (let y = Math.max(0, py - 2); y <= Math.min(h - 1, py + 2); y++)
    for (let x = Math.max(0, px - 2); x <= Math.min(w - 1, px + 2); x++) {
      const v = C[y * w + x]!;
      sx += x * v;
      sy += y * v;
      sum += v;
    }
  sum += Number.EPSILON;
  return [w / 2 - sx / sum, h / 2 - sy / sum];
}

/** The phase-correlation shift of two grey frames, `a` windowed `passesA` times. @internal */
export function phaseCorrelateFrames(
  a: Uint8Array,
  b: Uint8Array,
  w: number,
  h: number,
  win: Float32Array,
  passesA = 1,
) {
  const fft = new FFT2(w, h);
  const { A, B } = spectra(fft, a, passesA, b, win);
  return phaseCorrelate(fft, A, B);
}

/**
 * Keyframe times of a grey stream, in seconds to 2 decimals. `raw` holds whole frames of width×sh at `fps`. It always
 * picks the first frame, even for an empty stream.
 */
export function pickTimes(raw: Uint8Array, width: number, sh: number, thresh: number, fps: number): number[] {
  const size = width * sh;
  const n = Math.floor(raw.length / size);
  const frame = (i: number) => raw.subarray(i * size, (i + 1) * size);
  const win = hanning(width, sh);
  const fft = new FFT2(width, sh);
  const sharp = Array.from({ length: n }, (_, i) => laplacianVar(frame(i), width, sh));
  const picks = [0];
  let acc = 0;
  let cand: number[] = [];
  for (let i = 1; i < n; i++) {
    const { A, B } = spectra(fft, frame(i - 1), i - 1 >= 1 ? 2 : 1, frame(i), win);
    const [dx, dy] = phaseCorrelate(fft, A, B);
    acc += Math.hypot(dx / width, dy / sh);
    cand.push(i);
    if (acc >= thresh) {
      let b = cand[0] ?? i;
      for (const j of cand) if (sharp[j]! > sharp[b]!) b = j;
      picks.push(b);
      acc = 0;
      cand = [];
    }
  }
  return picks.map((p) => Math.round((p / fps) * 100) / 100);
}

/** Grey stream height for a w×h video at `width`, rounded to even, keeping the aspect ratio. */
export const streamHeight = (w: number, h: number, width: number) => Math.round((width * h) / w / 2) * 2;
