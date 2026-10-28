/** Image byte ops over interleaved 8-bit buffers. */
import type { Box, NonEmpty, RGB } from "../types.ts";

export const blank = (w: number, h: number, v = 0): RGB => ({ w, h, data: new Uint8Array(w * h * 3).fill(v) });

/** The rectangle [x0, x1) × [y0, y1) of `img` as a new image, like a numpy slice. */
export function crop(img: RGB, x0: number, y0: number, x1: number, y1: number): RGB {
  const w = x1 - x0,
    h = y1 - y0;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    out.set(img.data.subarray(((y0 + y) * img.w + x0) * 3, ((y0 + y) * img.w + x1) * 3), y * w * 3);
  return { w, h, data: out };
}

export const cropBox = (img: RGB, [x0, y0, x1, y1]: Box): RGB => crop(img, x0, y0, x1, y1);

/** Writes `src` into `dst` at (x, y) for compositing. It is the only op here that changes its argument. */
export function paste(dst: RGB, src: RGB, x: number, y: number): void {
  for (let r = 0; r < src.h; r++)
    dst.data.set(src.data.subarray(r * src.w * 3, (r + 1) * src.w * 3), ((y + r) * dst.w + x) * 3);
}

/** Puts tiles side by side, at the first tile's height. */
export function hstack(tiles: NonEmpty<RGB>): RGB {
  const out = blank(
    tiles.reduce((s, t) => s + t.w, 0),
    tiles[0].h,
  );
  let x = 0;
  for (const t of tiles) {
    paste(out, t, x, 0);
    x += t.w;
  }
  return out;
}

/** Stacks tiles, at the first tile's width. */
export function vstack(tiles: NonEmpty<RGB>): RGB {
  const out = blank(
    tiles[0].w,
    tiles.reduce((s, t) => s + t.h, 0),
  );
  let y = 0;
  for (const t of tiles) {
    paste(out, t, 0, y);
    y += t.h;
  }
  return out;
}
