/**
 * Clip use cases: add (and revive), remove (leaving a tombstone), and finish a removal a crash cut short.
 *
 * Add calls video.addClip, then writes session.json (MetaStore). After a crash, frames written before it stay, and
 * extraction skips stored frames next time. Without the session.json write the clip isn't part of the session, so
 * adding it again starts over.
 *
 * Remove, in this order:
 *   1. detections.counters(clip frames), then video.removeClip writes the tombstone with `removed` and with
 *      `reserved` set to the counters, so a revived frame never reissues an id.
 *   2. Write session.json (MetaStore), so the tombstone is on disk before anything is deleted.
 *   3. labelling.stripFrames removes the clip's detections from every object, rejects included, deletes emptied
 *      objects and writes objects.json, then one `clip_remove` line to ops.jsonl. That line is a history barrier
 *      and can't be undone.
 *   4. detections.drop, then delete each dets/<id>.npz and mask PNG and each run's heatmap, a few at a time. Their
 *      order doesn't matter because the tombstone is already on disk. Then write dets.json and runs.json.
 *   5. perception.forget and video.forget clear RAM. removeClipFiles deletes frames and features last.
 * A crash after step 2 leaves a tombstone with data: detections in its frames, or objects holding them. At session
 * creation, `recoverRemovals` runs steps 3 to 5 again for every such clip. Steps 3 to 5 skip what is already gone.
 */
import type { ResultAsync } from "neverthrow";
import { okAsync } from "neverthrow";
import { frameOf } from "../../detections/pure.ts";
import type { ObjectId } from "../../labelling/index.ts";
import { isNonEmpty } from "../../pixels/index.ts";
import type { Clip } from "../../video/pure.ts";
import type { Ctx } from "../pure.ts";
import type { AddReply, ClipsRemoveReply, SessionError } from "../types.ts";
import type { Kit } from "./context.ts";
import { parallel, sequence } from "./context.ts";
import { writeIndex, writeMeta } from "./persist.ts";

export const addClip = (k: Kit, ctx: Ctx, ref: string, fps: number | null): ResultAsync<AddReply, SessionError> =>
  k.modules.video
    .addClip(ref, { keyframeThresh: ctx.cfg.keyframe_thresh, fps })
    .andThen((added) => writeMeta(k).map(() => added))
    .map(({ clip, first, revived }) => ({
      clip: clip.path,
      keyframes: clip.times.length,
      first,
      captured: clip.captured,
      revived,
    }));

type Purged = { readonly detections: number; readonly stripped: number; readonly deleted: readonly ObjectId[] };

/** Steps 3 to 5 of removal (see the header) for a tombstoned clip. */
const purge = (k: Kit, clip: Clip): ResultAsync<Purged, SessionError> => {
  const { video, labelling, detections, perception } = k.modules;
  const fr = video.clipFrames(clip.key);
  const strip = isNonEmpty(fr)
    ? labelling.stripFrames({ key: clip.key, path: clip.path, frames: fr })
    : okAsync({ stripped: 0, deleted: [] });
  return strip.andThen(({ stripped, deleted }) => {
    const gone = detections.drop(fr);
    return parallel(gone.detections, (d) => k.stores.detections.removeDetection(d.id))
      .andThen(() =>
        parallel(gone.runs, (r) => (r.heatmap === null ? okAsync(undefined) : k.stores.heatmaps.remove(r.heatmap))),
      )
      .andThen(() => writeIndex(k))
      .andThen(() => {
        perception.forget(fr);
        video.forget(fr);
        return k.stores.removeClipFiles(clip.key);
      })
      .map(() => ({ detections: gone.detections.length, stripped, deleted }));
  });
};

export const removeClip = (k: Kit, ref: string): ResultAsync<ClipsRemoveReply, SessionError> => {
  const { video, detections } = k.modules;
  return video
    .findClip(ref)
    .andThen((c) => video.removeClip(c.key, detections.counters(video.clipFrames(c.key))))
    .asyncAndThen((removed) => writeMeta(k).map(() => removed))
    .andThen(({ clip, frames }) =>
      purge(k, clip).map((r) => {
        k.host.logger.log(`removed ${clip.path}: keyframes #${frames[0]}-#${frames[1]}, ${r.detections} detections`);
        return { removed: clip.path, key: clip.key, frames, ...r };
      }),
    );
};

/** A tombstoned clip still holding data: detections in its frames, or objects holding ids of its frames. */
const interrupted = (k: Kit, clip: Clip): boolean => {
  const fs = new Set(k.modules.video.clipFrames(clip.key));
  return (
    k.modules.detections.inFrames(fs).length > 0 ||
    [...k.modules.labelling.owners().keys()].some((id) => fs.has(frameOf(id)))
  );
};

/** Finishes steps 3 to 5 of every removal that stopped after writing its tombstone. */
export const recoverRemovals = (k: Kit): ResultAsync<number, SessionError> => {
  const todo = k.modules.video.clips().filter((c) => c.removed !== null && interrupted(k, c));
  return sequence(todo, (c) =>
    purge(k, c).map((r) => {
      k.host.logger.log(`finished removing ${c.path} (interrupted): ${r.detections} detections`);
      return r;
    }),
  ).map((done) => done.length);
};
