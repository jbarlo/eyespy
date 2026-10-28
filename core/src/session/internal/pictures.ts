/**
 * Saves pictures, encoded with PictureCodec and written to OutputSink. Draws frame overlays and close-up sheets as
 * agents see them.
 */
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { Detection } from "../../detections/pure.ts";
import type { RGB } from "../../pixels/index.ts";
import { isNonEmpty } from "../../pixels/index.ts";
import { hostFailure } from "../../ports/index.ts";
import type { Locator, SessionError } from "../types.ts";
import type { Kit } from "./context.ts";
import { framesOf, sequence } from "./context.ts";

/** Saves a picture as out/<name>.jpg and returns the locator replies carry as `image`. */
export const save = (k: Kit, img: RGB, name: string, quality = 85): ResultAsync<Locator, SessionError> =>
  ResultAsync.fromPromise(k.host.codec.encodeJpeg(img, quality), (e) => hostFailure("codec", "encodeJpeg", e)).andThen(
    (jpeg) => k.stores.outputs.writeImage(name, jpeg),
  );

/** Saves a grid of tiles under `name`. Returns null if there is nothing to draw. */
export const saveGrid = (
  k: Kit,
  tiles: readonly RGB[],
  name: string,
  cols?: number,
): ResultAsync<Locator | null, SessionError> =>
  isNonEmpty(tiles) ? save(k, k.modules.render.grid(tiles, cols), name) : okAsync(null);

/** Saves a crop sheet under `name`. Returns null for none. */
export const saveSheet = (
  k: Kit,
  regions: readonly Detection[],
  name: string,
  labels?: readonly string[],
  limit?: number | null,
): ResultAsync<Locator | null, SessionError> =>
  k.modules.render.cropSheet(regions, labels, limit).andThen((img) => (img ? save(k, img, name) : okAsync(null)));

/** Frame overlays by default, one tile per frame at `scale`. A close-up sheet if the request asks for crops. */
export const view = (
  k: Kit,
  req: { readonly crops?: boolean | null },
  dets: readonly Detection[],
  name: string,
  scale = 0.35,
): ResultAsync<Locator | null, SessionError> => {
  if (!dets.length) return okAsync(null);
  if (req.crops) return saveSheet(k, dets, `${name}-crops`);
  return sequence(framesOf(dets), (i) =>
    k.modules.render.overlay(
      i,
      dets.filter((d) => d.frame === i),
      { scale },
    ),
  ).andThen((tiles) => saveGrid(k, tiles, name));
};

/** A saved grid's locator, or `no-frames` if there was nothing to draw. */
export const someFrames = (image: string | null): ResultAsync<string, SessionError> =>
  image === null ? errAsync({ kind: "no-frames" }) : okAsync(image);
