/** DINOv2 input pixels, bit-exact with BitImageProcessor, and the region crop. */
import { cropBox, dilate, type Mask, type RGB } from "../../../pixels/index.ts";
import { resizeAA } from "../resample.kernel.ts";

export const DINO_SIZE = 224;
/** Values per item of a pixel_values batch. */
const DINO_PIXELS = 3 * DINO_SIZE * DINO_SIZE;

const fr = Math.fround;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/**
 * DINOv2's BitImageProcessor. Resizes the shortest edge to 256 (bicubic, antialiased, on uint8), centre-crops 224
 * and applies ImageNet normalisation. Writes DINO_PIXELS values into `out` at `off`.
 * @internal
 */
export function dinoPixels(img: RGB, out: Float32Array, off: number): void {
  const short = Math.min(img.w, img.h),
    long = Math.max(img.w, img.h);
  const nl = Math.trunc((256 * long) / short);
  const [ow, oh] = img.w <= img.h ? [256, nl] : [nl, 256];
  const r = resizeAA(img, ow, oh, "bicubic");
  const top = Math.trunc((oh - 224) / 2),
    left = Math.trunc((ow - 224) / 2);
  const P = 224 * 224;
  const k = 1 / 0.00392156862745098;
  const mean = IMAGENET_MEAN.map((m) => fr(fr(m) * k));
  const std = IMAGENET_STD.map((s) => fr(fr(s) * k));
  for (let y = 0; y < 224; y++)
    for (let x = 0; x < 224; x++) {
      const p = ((y + top) * ow + x + left) * 3;
      for (let c = 0; c < 3; c++) out[off + c * P + y * 224 + x] = fr(fr(r.data[p + c]! - mean[c]!) / std[c]!);
    }
}

/** A batch's pixel_values. */
export function dinoBatch(crops: readonly RGB[]): Float32Array {
  const px = new Float32Array(crops.length * DINO_PIXELS);
  crops.forEach((c, i) => dinoPixels(c, px, i * DINO_PIXELS));
  return px;
}

/** The region's box cropped from the image, with everything outside its mask (dilated by a 9×9 square) set to 128. */
export function regionCrop(img: RGB, region: Mask): RGB {
  const [x0, y0, x1, y1] = region.box;
  const w = x1 - x0,
    h = y1 - y0;
  const m = dilate(region.mask, w, h, 9);
  const c = cropBox(img, region.box);
  for (let p = 0; p < w * h; p++) if (!m[p]) c.data.fill(128, p * 3, p * 3 + 3);
  return c;
}
