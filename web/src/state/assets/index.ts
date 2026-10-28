/**
 * Page-side assets of the open session, outside the zustand stores, keyed by store key or detection id.
 */
import { errAsync, okAsync } from "neverthrow";
import type { ResultAsync } from "neverthrow";
import type { EngineError, EngineSession, HostError } from "../ports.ts";
import type { Box } from "../types.ts";
import { createCache } from "./cache.ts";
import type { AssetCache } from "./cache.ts";
import type { CropSource, Imaging } from "./imaging.ts";
import { createSprites } from "./masks.ts";
import type { Sprites } from "./masks.ts";

export type { Imaging, Sprites };
export { browserImaging } from "./imaging.ts";

type AssetError = EngineError | HostError | { readonly kind: "missing"; readonly message: string };
type Reader = EngineSession["file"];

/** One detection's crop: its keyframe's store key, its box, and its display size (CSS px) at a pixel ratio. */
type CropKey = {
  readonly image: string;
  readonly det: string;
  readonly box: Box;
  readonly size: number;
  readonly dpr: number;
};

export type AssetCaches = {
  readonly bitmaps: AssetCache<string, ImageBitmap>;
  readonly crops: AssetCache<CropKey, ImageBitmap>;
  readonly thumbs: AssetCache<string, string>;
  readonly heat: AssetCache<string, ImageBitmap>;
  readonly sprites: Sprites;
  /** Read files from this session. With null (no session open), loads fail. */
  readonly attach: (read: Reader | null) => void;
  readonly reset: () => void;
  /**
   * Keep only these frame images, detections and heatmaps (after a clip removal). A run found again later writes its
   * heatmap under the same store key, so a dropped run's heatmap must leave too.
   */
  readonly prune: (
    liveImages: ReadonlySet<string>,
    liveDets: ReadonlySet<string>,
    liveHeat: ReadonlySet<string>,
  ) => void;
  /** Any keyframe bitmap, thumbnail or heatmap arrived or left. Crops don't notify, since each Crop awaits its own. */
  readonly subscribe: (fn: () => void) => () => void;
};

type AssetOptions = {
  readonly imaging: Imaging;
  readonly bitmapCount?: number;
  readonly cropCount?: number;
  readonly heatCount?: number;
  readonly onError?: (what: string, key: string, e: AssetError) => void;
};

export function createAssetCaches(o: AssetOptions): AssetCaches {
  let read: Reader | null = null;
  const { imaging } = o;
  const missing = (message: string): AssetError => ({ kind: "missing", message });
  const bytes = (key: string): ResultAsync<Uint8Array, AssetError> =>
    read
      ? read(key).andThen((b) => (b ? okAsync(b) : errAsync(missing(`${key} is not stored`))))
      : errAsync(missing("no session open"));
  const mime = (key: string) => (key.endsWith(".png") ? "image/png" : "image/jpeg");
  const report = (what: string) => (key: string, e: AssetError) => o.onError?.(what, key, e);

  const bitmaps = createCache<string, ImageBitmap, AssetError>({
    load: (key) => bytes(key).andThen((b) => imaging.bitmap(b, mime(key))),
    dispose: imaging.close,
    max: o.bitmapCount ?? 10,
    onError: report("keyframe"),
  });
  /** Cuts from the keyframe's bitmap when the Stage already has it decoded, else decodes the keyframe's bytes. */
  const cropSource = (image: string): ResultAsync<CropSource, AssetError> => {
    const bitmap = bitmaps.peek(image);
    return bitmap?.width ? okAsync({ bitmap }) : bytes(image).map((b) => ({ bytes: b, type: mime(image) }));
  };
  const crops = createCache<CropKey, ImageBitmap, AssetError>({
    id: (k) => `${k.det}@${k.size}x${k.dpr}:${k.box.join(",")}`,
    load: (k) => cropSource(k.image).andThen((src) => imaging.crop(src, k.box, k.size, k.dpr)),
    dispose: imaging.close,
    max: o.cropCount ?? 400,
    serial: true,
    onError: (k, e) => o.onError?.("crop", k.det, e),
  });
  const thumbs = createCache<string, string, AssetError>({
    load: (key) => bytes(key).andThen(imaging.thumb),
    dispose: imaging.revoke,
    serial: true,
    onError: report("thumbnail"),
  });
  const heat = createCache<string, ImageBitmap, AssetError>({
    load: (key) => bytes(key).andThen(imaging.heat),
    dispose: imaging.close,
    max: o.heatCount ?? 8,
    onError: report("heatmap"),
  });
  const sprites = createSprites();
  const notifying = [bitmaps, thumbs, heat];

  return {
    bitmaps,
    crops,
    thumbs,
    heat,
    sprites,
    attach: (r) => {
      read = r;
    },
    reset: () => {
      read = null;
      for (const c of notifying) c.reset();
      crops.reset();
      sprites.reset();
    },
    prune: (liveImages, liveDets, liveHeat) => {
      bitmaps.prune((k) => liveImages.has(k));
      heat.prune((k) => liveHeat.has(k));
      crops.prune((k) => liveDets.has(k.det));
      thumbs.prune((k) => liveImages.has(k));
      sprites.prune(liveDets);
    },
    subscribe: (fn) => {
      const offs = notifying.map((c) => c.subscribe(fn));
      return () => offs.forEach((off) => off());
    },
  };
}
