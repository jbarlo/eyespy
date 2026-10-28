/** The data ops return raw per-frame data for interactive UIs, which draw their own overlays. */
import { okAsync, Result, ResultAsync } from "neverthrow";
import type { DetId, Detection } from "../../../detections/pure.ts";
import { rle, runLabel } from "../../../detections/pure.ts";
import type { Owner } from "../../../labelling/index.ts";
import { REJECT } from "../../../labelling/pure.ts";
import { hostFailure } from "../../../ports/index.ts";
import type { DataMask, MaskFormat, Session, SessionError } from "../../types.ts";
import type { Kit } from "../context.ts";
import { parallel } from "../context.ts";
import { round, selectDets, summary } from "../replies.ts";

/** A detection's mask over its box as `rle` counts, or null for none. */
const inlineMask = (d: Detection, kind: Exclude<MaskFormat, "png">): DataMask | null => {
  const [x0, y0, x1, y1] = d.box;
  return kind === "rle" ? { format: "rle", w: x1 - x0, h: y1 - y0, counts: rle(d.mask) } : null;
};
/** A detection's mask as a stored 8-bit grey PNG of 0 and 255 values, written on first request. */
const pngMask = (k: Kit, d: Detection): ResultAsync<DataMask, SessionError> => {
  const [x0, y0, x1, y1] = d.box;
  const w = x1 - x0,
    h = y1 - y0;
  const store = k.stores.detections;
  return store
    .maskImage(d.id)
    .andThen((have) =>
      have !== null
        ? okAsync(have)
        : ResultAsync.fromPromise(k.host.codec.encodePng({ w, h, data: d.mask.map((v) => (v ? 255 : 0)) }), (e) =>
            hostFailure("codec", "encodePng", e),
          ).andThen((png) => store.writeMaskImage(d.id, png)),
    )
    .map((image) => ({ format: "png", w, h, image }));
};

export const data = (k: Kit): Session["data"] => ({
  frames: () => {
    const { video, perception } = k.modules;
    return Result.combine(
      video.liveFrames().map((i) =>
        video.slot(i).andThen((s) =>
          video.ref(i).map((ref) => ({
            frame: i,
            t: s.t,
            clip: s.clip.path,
            clipKey: s.clip.key,
            w: s.clip.shape[1],
            h: s.clip.shape[0],
            encoded: perception.encoded(i),
            image: k.stores.frameFiles.locate(ref),
          })),
        ),
      ),
    ).asyncAndThen((list) => okAsync({ frames: list }));
  },

  dets: (ctx, req) =>
    k.modules.video.frames(req.frames).asyncAndThen((fs) => {
      const own: ReadonlyMap<DetId, Owner> = k.modules.labelling.owners();
      const fset = new Set(fs);
      const th = req.threshold ?? 0; // every cached detection (above the score floor) unless asked
      const sel = selectDets(k.modules.detections.all(), fset, th, req.prompt);
      const row = (d: Detection, mask: DataMask | null) => ({
        ...summary(d, own),
        prompt: d.prompt,
        run: runLabel(d),
        rejected: own.get(d.id) === REJECT,
        mask,
        // On request, same-frame detections that cover the same region, which todo and obj ops treat as one.
        ...(req.aliases ? { aliases: k.modules.detections.aliases(d, ctx.cfg.alias_iou).map((o) => o.id) } : {}),
      });
      const kind = req.mask ?? "rle";
      // Only png masks touch the store, a few at a time. rle and none are plain data and need no async chain per
      // detection. The web UI asks for every detection without masks on each refresh.
      return kind === "png"
        ? parallel(sel, (d) => pngMask(k, d).map((mask) => row(d, mask))).map((dets) => ({ dets }))
        : okAsync({ dets: sel.map((d) => row(d, inlineMask(d, kind))) });
    }),

  runs: (_ctx, req) =>
    k.modules.video.frames(req.frames).asyncAndThen((fs) =>
      okAsync({
        runs: k.modules.detections.runs({ frames: new Set(fs), prompt: req.prompt ?? null }).map((r) => ({
          frame: r.frame,
          prompt: runLabel(r),
          presence: round(r.presence, 4),
          ids: r.ids,
          semantic: r.heatmap === null ? null : k.stores.heatmaps.locate(r.heatmap),
        })),
      }),
    ),

  objects: () => {
    const L = k.modules.labelling;
    return Result.combine(L.objectIds().map((id) => L.summary(id))).asyncAndThen((objects) =>
      okAsync({ objects, rejected: L.rejected() }),
    );
  },

  history: () => okAsync(k.modules.labelling.history()),
});
