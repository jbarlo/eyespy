/**
 * Detect-and-record for find, with one SAM 3 call per frame and prompt cached as a run, and for region search,
 * which works on crops and caches per region.
 *
 * Detect-and-record runs these steps in order:
 *   1. Get features. The first encode stamps `features` in session.json.
 *   2. Read the frame image.
 *   3. perception.detect, which applies the score floor and NMS.
 *   4. Store the heatmap PNG (HeatmapStore).
 *   5. Embed the instances on the frame.
 *   6. detections.mint, the only code that allocates ids.
 *   7. Write each dets/<id>.npz, a few at a time.
 *   8. Write dets.json and runs.json.
 * A crash before runs.json leaves orphan npz and heatmap files and no run, so the next find runs the frame again.
 * Ids continue from the counters loaded from dets.json, so no listed id is reused.
 */
import { okAsync, ResultAsync } from "neverthrow";
import type { Detection, HeatmapRef, Run, RunRecord } from "../../detections/pure.ts";
import type { Box, Gray, RGB } from "../../pixels/index.ts";
import { hostFailure } from "../../ports/index.ts";
import type { FrameNo } from "../../video/pure.ts";
import type { Ctx } from "../pure.ts";
import type { SessionError } from "../types.ts";
import type { Kit } from "./context.ts";
import { parallel } from "./context.ts";
import { features } from "./features.ts";
import { writeIndex } from "./persist.ts";

const storeHeatmap = (
  k: Kit,
  i: FrameNo,
  prompt: string,
  heat: Gray | null,
): ResultAsync<HeatmapRef | null, SessionError> =>
  heat === null
    ? okAsync(null)
    : ResultAsync.fromPromise(k.host.codec.encodePng(heat), (e) => hostFailure("codec", "encodePng", e)).andThen(
        (png) => k.stores.heatmaps.write(i, prompt, png),
      );

/** Writes the new detections' npz files, then the index. */
const persistMinted = (k: Kit, dets: readonly Detection[]): ResultAsync<void, SessionError> =>
  parallel(dets, (d) => k.stores.detections.writeDetection(d)).andThen(() => writeIndex(k));

const detectOptions = (ctx: Ctx) => ({ scoreFloor: ctx.cfg.score_floor, nmsIou: ctx.cfg.nms_iou });

/** One SAM 3 call on a whole keyframe, recorded as a run. */
const detectFrame = (k: Kit, ctx: Ctx, run: Run): ResultAsync<RunRecord, SessionError> => {
  const { perception, video, detections } = k.modules;
  const i = run.frame;
  const t0 = k.host.clock.now();
  return features(k, i)
    .andThen((f) => video.image(i).map((img) => ({ f, img })))
    .andThen(({ f, img }) =>
      perception.detect(f, run.prompt, { w: img.w, h: img.h }, detectOptions(ctx)).map((out) => ({ img, out })),
    )
    .andThen(({ img, out }) => storeHeatmap(k, i, run.prompt, out.heatmap).map((heatmap) => ({ img, out, heatmap })))
    .andThen(({ img, out, heatmap }): ResultAsync<RunRecord, SessionError> =>
      video
        .t(i)
        .asyncAndThen((t) =>
          perception
            .embed(
              img,
              out.instances.map((x) => ({ box: x.box, mask: x.mask })),
            )
            .andThen((embs) =>
              detections.mint({ run, t, instances: out.instances, embs, presence: out.presence, heatmap }),
            ),
        )
        .andThen((m) => persistMinted(k, m.detections).map(() => m.run)),
    )
    .map((rec) => {
      // perception logs its own stages. This times the whole detect, with features, dino and files.
      if (k.opts.profile)
        k.host.logger.log(
          `detect #${i} ${JSON.stringify(run.prompt)}: ${Math.round(k.host.clock.now() - t0)} ms (${rec.ids.length} hits)`,
        );
      return rec;
    });
};

/** The run of a prompt on a keyframe, cached or else detected. */
export const ensureRun = (k: Kit, ctx: Ctx, i: FrameNo, prompt: string): ResultAsync<RunRecord, SessionError> => {
  const run: Run = { frame: i, prompt, region: null };
  const cached = k.modules.detections.run(run);
  return cached !== undefined ? okAsync(cached) : detectFrame(k, ctx, run);
};

/** A search region on a keyframe, with the frame image, the region in frame pixels, and its crop. */
export type SearchRegion = { readonly img: RGB; readonly region: Box; readonly crop: RGB };

/**
 * Detect-and-record for region search. It encodes the region crop on its own, without caching. The crop is
 * upscaled to the encoder size, so small things are found. It detects with the region's offset, in frame
 * coordinates, and embeds on the frame. It mints a region run ("prompt@x0,y0,x1,y1") with no heatmap, then writes
 * the npz files and the index. The run is cached per region, like a find.
 */
export const ensureRegionRun = (
  k: Kit,
  ctx: Ctx,
  i: FrameNo,
  { img, region, crop }: SearchRegion,
  prompt: string,
): ResultAsync<RunRecord, SessionError> => {
  const { perception, video, detections } = k.modules;
  const run: Run = { frame: i, prompt, region };
  const cached = detections.run(run);
  if (cached) return okAsync(cached);
  const [x0, y0] = region;
  return perception
    .encode(crop)
    .andThen((f) =>
      perception.detect(f, prompt, { w: crop.w, h: crop.h, offset: { x: x0, y: y0 } }, detectOptions(ctx)),
    )
    .andThen((out) =>
      perception
        .embed(
          img,
          out.instances.map((x) => ({ box: x.box, mask: x.mask })),
        )
        .andThen((embs) =>
          video
            .t(i)
            .andThen((t) =>
              detections.mint({ run, t, instances: out.instances, embs, presence: out.presence, heatmap: null }),
            ),
        ),
    )
    .andThen((m) => persistMinted(k, m.detections).map(() => m.run));
};
