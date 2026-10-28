/**
 * Display resizes, as cv2.resize(INTER_LINEAR) does for 8-bit images. They use half-pixel centres, clamp at the
 * edges and use 11-bit fixed-point weights, without antialiasing, like OpenCV. Two differences from cv2 are
 * accepted, since only displays use these and no model sees them. Rounding differs by 1 from cv2's SIMD
 * path on some pixels. `scaleRGB`'s output size and coordinate mapping differ from cv2's for some fx.
 */
import type { Gray, RGB } from "../../pixels/index.ts";

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

type Tab = { readonly i0: Int32Array; readonly i1: Int32Array; readonly a: Int32Array };

function tab(inSize: number, outSize: number): Tab {
  const scale = inSize / outSize;
  const i0 = new Int32Array(outSize),
    i1 = new Int32Array(outSize),
    a = new Int32Array(outSize);
  for (let d = 0; d < outSize; d++) {
    let f = (d + 0.5) * scale - 0.5;
    let s = Math.floor(f);
    f -= s;
    if (s < 0) {
      f = 0;
      s = 0;
    }
    if (s >= inSize - 1) {
      f = 0;
      s = inSize - 1;
    }
    i0[d] = s;
    i1[d] = Math.min(s + 1, inSize - 1);
    a[d] = Math.round(f * 2048);
  }
  return { i0, i1, a };
}

/** cv2.resize(INTER_LINEAR) of an interleaved `C`-channel 8-bit image to ow×oh. @internal */
export function resizeLinear8(
  src: { readonly w: number; readonly h: number; readonly data: Uint8Array },
  C: number,
  ow: number,
  oh: number,
): { w: number; h: number; data: Uint8Array } {
  const X = tab(src.w, ow),
    Y = tab(src.h, oh);
  const out = new Uint8Array(ow * oh * C);
  const sstride = src.w * C;
  for (let y = 0; y < oh; y++) {
    const r0 = Y.i0[y]! * sstride,
      r1 = Y.i1[y]! * sstride,
      b1 = Y.a[y]!,
      b0 = 2048 - b1;
    for (let x = 0; x < ow; x++) {
      const c0 = X.i0[x]! * C,
        c1 = X.i1[x]! * C,
        a1 = X.a[x]!,
        a0 = 2048 - a1;
      for (let c = 0; c < C; c++) {
        const top = src.data[r0 + c0 + c]! * a0 + src.data[r0 + c1 + c]! * a1;
        const bot = src.data[r1 + c0 + c]! * a0 + src.data[r1 + c1 + c]! * a1;
        out[(y * ow + x) * C + c] = clamp8((top * b0 + bot * b1 + (1 << 21)) >> 22);
      }
    }
  }
  return { w: ow, h: oh, data: out };
}

/** Resizes RGB to ow×oh. Returns the same image if the size already matches, since images are immutable. */
export const resizeRGB = (img: RGB, ow: number, oh: number): RGB =>
  ow === img.w && oh === img.h ? img : resizeLinear8(img, 3, ow, oh);

/** Resizes Gray to ow×oh. It always resamples, which at the same size gives the same pixels. */
export const resizeGray = (img: Gray, ow: number, oh: number): Gray => resizeLinear8(img, 1, ow, oh);

/** Like cv2.resize(img, None, fx=s, fy=s), with the output size rounded. */
export const scaleRGB = (img: RGB, s: number): RGB => resizeRGB(img, Math.round(img.w * s), Math.round(img.h * s));
