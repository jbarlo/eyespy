/** Browser image work for the asset caches. This file turns host exceptions into HostError values. */
import { ResultAsync } from "neverthrow";
import { JET } from "eyespy-core/render/pure";
import type { HostError } from "../ports.ts";
import type { Box } from "../types.ts";

/** Where a crop is cut from: an already decoded keyframe, or its stored bytes (decoded only for the crop). */
export type CropSource = { readonly bitmap: ImageBitmap } | { readonly bytes: Uint8Array; readonly type: string };

export type Imaging = {
  readonly bitmap: (bytes: Uint8Array, type: string) => ResultAsync<ImageBitmap, HostError>;
  /**
   * A detection's crop, ready to draw. It shows `cropSquare(box)` of the source on a dark ground with the box outlined,
   * `round(size·dpr)` px on a side.
   */
  readonly crop: (src: CropSource, box: Box, size: number, dpr: number) => ResultAsync<ImageBitmap, HostError>;
  /** An object URL of a small JPEG thumbnail. */
  readonly thumb: (bytes: Uint8Array) => ResultAsync<string, HostError>;
  /** The grey heatmap PNG mapped through JET, with alpha rising with the value. */
  readonly heat: (bytes: Uint8Array) => ResultAsync<ImageBitmap, HostError>;
  readonly close: (b: ImageBitmap) => void;
  readonly revoke: (url: string) => void;
};

const hostError = (e: unknown): HostError => ({ kind: "host", message: e instanceof Error ? e.message : String(e) });

/**
 * The square a detection crop shows, in frame pixels. Its side is the box's longer side plus a margin, centred on the box.
 * It may reach past the frame's edges, and that part stays dark.
 * @internal
 */
export function cropSquare(box: Box): { readonly x: number; readonly y: number; readonly side: number } {
  const [x0, y0, x1, y1] = box;
  const side = Math.ceil(Math.max(x1 - x0, y1 - y0) * 1.3 + 8);
  return { x: Math.round((x0 + x1 - side) / 2), y: Math.round((y0 + y1 - side) / 2), side };
}

/** Heatmap alpha per grey level. A faint tint everywhere shows the layer is on, and strong values are opaque. */
const ALPHA = Uint8Array.from({ length: 256 }, (_, v) => Math.round(70 + 185 * (v / 255)));

/** Grey RGBA pixels (the red channel holds the value) through core's JET table, as new RGBA pixels. @internal */
export function jetTint(gray: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gray.length);
  for (let p = 0; p < gray.length; p += 4) {
    const v = gray[p] ?? 0;
    out[p] = JET[v * 3] ?? 0;
    out[p + 1] = JET[v * 3 + 1] ?? 0;
    out[p + 2] = JET[v * 3 + 2] ?? 0;
    out[p + 3] = ALPHA[v] ?? 0;
  }
  return out;
}

const blob = (bytes: Uint8Array, type: string) => new Blob([bytes.slice()], { type });

async function context(c: OffscreenCanvas): Promise<OffscreenCanvasRenderingContext2D> {
  const g = c.getContext("2d");
  return g ?? Promise.reject(new Error("no 2D canvas context"));
}

async function cropBitmap(src: CropSource, box: Box, size: number, dpr: number): Promise<ImageBitmap> {
  const px = Math.max(1, Math.round(size * dpr));
  const sq = cropSquare(box);
  const from = "bitmap" in src ? src.bitmap : blob(src.bytes, src.type);
  const opts: ImageBitmapOptions = { resizeWidth: px, resizeHeight: px, resizeQuality: "medium" };
  const cut = await createImageBitmap(from, sq.x, sq.y, sq.side, sq.side, opts);
  const c = new OffscreenCanvas(px, px);
  const g = await context(c);
  g.fillStyle = "#111";
  g.fillRect(0, 0, px, px);
  g.drawImage(cut, 0, 0);
  cut.close();
  const k = px / sq.side;
  const [x0, y0, x1, y1] = box;
  g.strokeStyle = "rgba(56,189,248,0.9)";
  g.lineWidth = 1.5 * dpr;
  g.strokeRect((x0 - sq.x) * k, (y0 - sq.y) * k, (x1 - x0) * k, (y1 - y0) * k);
  return createImageBitmap(c);
}

async function thumbUrl(bytes: Uint8Array): Promise<string> {
  const bm = await createImageBitmap(blob(bytes, "image/jpeg"), { resizeWidth: 192, resizeQuality: "medium" });
  const c = new OffscreenCanvas(bm.width, bm.height);
  (await context(c)).drawImage(bm, 0, 0);
  bm.close();
  return URL.createObjectURL(await c.convertToBlob({ type: "image/jpeg", quality: 0.8 }));
}

async function heatBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  const bm = await createImageBitmap(blob(bytes, "image/png"));
  const c = new OffscreenCanvas(bm.width, bm.height);
  const g = await context(c);
  g.drawImage(bm, 0, 0);
  bm.close();
  const img = g.getImageData(0, 0, c.width, c.height);
  img.data.set(jetTint(img.data));
  g.putImageData(img, 0, 0);
  return createImageBitmap(c);
}

export const browserImaging: Imaging = {
  bitmap: (bytes, type) => ResultAsync.fromPromise(createImageBitmap(blob(bytes, type)), hostError),
  crop: (src, box, size, dpr) => ResultAsync.fromPromise(cropBitmap(src, box, size, dpr), hostError),
  thumb: (bytes) => ResultAsync.fromPromise(thumbUrl(bytes), hostError),
  heat: (bytes) => ResultAsync.fromPromise(heatBitmap(bytes), hostError),
  close: (b) => b.close(),
  revoke: (url) => URL.revokeObjectURL(url),
};
