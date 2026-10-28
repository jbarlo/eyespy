/** Pixel loops of the renderer. Each returns a new image and leaves its inputs as they were. */
import type { Box, Gray, RGB } from "../../pixels/index.ts";
import { blank, paste } from "../../pixels/index.ts";
import type { Rgb3 } from "../../ports/index.ts";
import { JET } from "./color.kernel.ts";
import { outline } from "./outline.kernel.ts";
import { resizeGray, resizeRGB } from "./resize.kernel.ts";

const copy = (img: RGB): { w: number; h: number; data: Uint8Array } => ({ w: img.w, h: img.h, data: img.data.slice() });

function plotInto(img: RGB, pts: Int32Array, c: Rgb3, dx = 0, dy = 0): void {
  const [r, g, b] = c;
  for (let k = 0; k < pts.length; k += 2) {
    const x = pts[k]! + dx,
      y = pts[k + 1]! + dy;
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    const p = (y * img.w + x) * 3;
    img.data[p] = r;
    img.data[p + 1] = g;
    img.data[p + 2] = b;
  }
}

type Painted = { readonly box: Box; readonly mask: Uint8Array; readonly color: Rgb3 };

/**
 * Draws each region in order. It blends the mask 50% with the region's colour (truncating), then draws the outline
 * at `thickness` in that colour on top. A later region's blend covers an earlier outline.
 */
export function blendOutlined(src: RGB, regions: readonly Painted[], thickness: number): RGB {
  const out = copy(src);
  for (const d of regions) {
    const c = d.color;
    const [x0, y0, x1, y1] = d.box;
    const w = x1 - x0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (!d.mask[(y - y0) * w + (x - x0)]) continue;
        const p = (y * out.w + x) * 3;
        for (let k = 0; k < 3; k++) out.data[p + k] = Math.trunc(0.5 * out.data[p + k]! + 0.5 * c[k]!);
      }
    plotInto(out, outline(d.mask, d.box, out.w, out.h, thickness), c);
  }
  return out;
}

/**
 * The crop [x0, x1) × [y0, y1) of `img`, with the region's outline drawn in `c`. The outline is computed in frame
 * coordinates, and pixels outside the crop are dropped.
 */
export function cropOutlined(
  img: RGB,
  crop: Box,
  region: { readonly box: Box; readonly mask: Uint8Array },
  thickness: number,
  c: Rgb3,
): RGB {
  const [x0, y0, x1, y1] = crop;
  const w = x1 - x0,
    h = y1 - y0;
  const out = { w, h, data: new Uint8Array(w * h * 3) };
  for (let y = 0; y < h; y++)
    out.data.set(img.data.subarray(((y0 + y) * img.w + x0) * 3, ((y0 + y) * img.w + x1) * 3), y * w * 3);
  plotInto(out, outline(region.mask, region.box, img.w, img.h, thickness), c, -x0, -y0);
  return out;
}

/** Scales `img` to fit side×side (size truncated, at least 1 px) and centres it on a grey (32) square. */
export function letterbox(img: RGB, side: number): RGB {
  const s = side / Math.max(img.w, img.h);
  const fit = resizeRGB(img, Math.max(1, Math.trunc(img.w * s)), Math.max(1, Math.trunc(img.h * s)));
  const out = blank(side, side, 32);
  paste(out, fit, (side - fit.w) >> 1, (side - fit.h) >> 1);
  return out;
}

/**
 * Resizes `heat` to the image (cv2 INTER_LINEAR), zeroes it under `covered`, and tints the image with JET at
 * 60% × heat (truncating). `active` counts pixels whose heat (f32, /255) exceeds the threshold.
 */
export function heatTint(
  img: RGB,
  heat: Gray,
  active: number,
  covered: Uint8Array | null,
): { readonly image: RGB; readonly active: number } {
  const heat8 = resizeGray(heat, img.w, img.h).data;
  const n = img.w * img.h;
  const out = new Uint8Array(n * 3);
  let on = 0;
  for (let p = 0; p < n; p++) {
    const v = covered && covered[p] ? 0 : Math.fround(heat8[p]! / 255);
    if (v > active) on++;
    const cm = Math.trunc(Math.fround(v * 255)) * 3;
    const a = v * 0.6;
    for (let k = 0; k < 3; k++) out[p * 3 + k] = Math.trunc(img.data[p * 3 + k]! * (1 - a) + JET[cm + k]! * a);
  }
  return { image: { w: img.w, h: img.h, data: out }, active: on };
}

/** Scales pixels under `covered` (w×h, 0/1) to `factor` of their value, truncating. */
export function darken(img: RGB, covered: Uint8Array, factor: number): RGB {
  const out = copy(img);
  for (let p = 0; p < covered.length; p++)
    if (covered[p]) for (let k = 0; k < 3; k++) out.data[p * 3 + k] = Math.trunc(out.data[p * 3 + k]! * factor);
  return out;
}
