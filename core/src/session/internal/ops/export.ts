/** The export op builds the manifest: objects, item counts, clips, the effective config and model provenance. */
import { okAsync, Result } from "neverthrow";
import type { Session } from "../../types.ts";
import type { Kit } from "../context.ts";
import { detectionsOf } from "../context.ts";
import { saveSheet } from "../pictures.ts";
import { countsOf } from "../replies.ts";

export const exportOps = (k: Kit): Session["export"] => ({
  manifest: (ctx, req) => {
    const { labelling, video, perception } = k.modules;
    return Result.combine(
      labelling
        .objectIds()
        .filter((id) =>
          labelling.get(id).match(
            (o) => o.members.length > 0,
            () => false,
          ),
        )
        .map((id) => labelling.summary(id)),
    )
      .map((objs) => [...objs].sort((a, b) => (a.first_t ?? 0) - (b.first_t ?? 0)))
      .asyncAndThen((objs) => {
        const counts = countsOf(objs.map((o) => o.label));
        const image =
          req.crops && objs.length
            ? detectionsOf(
                k,
                objs.flatMap((o) => (o.best === null ? [] : [o.best])),
              ).asyncAndThen((best) =>
                saveSheet(
                  k,
                  best,
                  "manifest",
                  objs.map((o) => `${o.id} ${[...o.label].slice(0, 22).join("")}`),
                  null,
                ),
              )
            : okAsync(null);
        // `first` is the clip's first global keyframe index, since detection ids are "frame.n". Removed clips are
        // left out, and so is a clip without keyframes, which only a hand-edited session.json can have.
        const clips = video.liveClips().flatMap((c) => {
          const first = video.clipFrames(c.key)[0];
          return first === undefined
            ? []
            : [
                {
                  path: c.path,
                  captured: c.captured,
                  keyframes: c.times.length,
                  first,
                  keyframe_thresh: c.keyframeThresh,
                },
              ];
        });
        return image.andThen((img) =>
          perception.provenance().map(({ models, runtime }) => ({
            meta: {
              clips,
              keyframes: video.liveFrames().length,
              config: ctx.cfg,
              // Key order is models, then the host's entries, then runtime.
              models,
              ...k.host.info,
              runtime,
            },
            items: counts.map(([label, count]) => ({ label, count })),
            objects: objs,
            image: img,
          })),
        );
      });
  },
});
