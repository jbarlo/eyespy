/** The look ops: overlays of what was found, close-ups, look-alikes, detection lists and coverage gaps. */
import { okAsync } from "neverthrow";
import type { DetId, Detection } from "../../../detections/pure.ts";
import { covered } from "../../../detections/pure.ts";
import type { Owner } from "../../../labelling/index.ts";
import { REJECT } from "../../../labelling/pure.ts";
import type { Rgb3 } from "../../../ports/index.ts";
import { color } from "../../../render/pure.ts";
import type { Session } from "../../types.ts";
import type { Kit } from "../context.ts";
import { sequence } from "../context.ts";
import { save, saveGrid, saveSheet, someFrames, view } from "../pictures.ts";
import { bestOfEach, scored, selectDets, simLabel, summary, threshold } from "../replies.ts";

/**
 * For `show --objects`, one region per object per frame (its best-scoring hit there), coloured and labelled by
 * object.
 */
const perObject = (k: Kit, hits: readonly Detection[], own: ReadonlyMap<DetId, Owner>) => {
  const shown = bestOfEach(
    hits,
    (d) => {
      const o = own.get(d.id);
      return o ? `${o}\u0000${d.frame}` : null;
    },
    (d) => d.score,
  );
  const ownerOf = (d: Detection): Owner | undefined => own.get(d.id);
  const labelOf = (o: Owner) =>
    k.modules.labelling.get(o).match(
      (x) => [...x.label].slice(0, 24).join(""),
      () => "",
    );
  const labels = new Map(
    shown.flatMap((d) => {
      const o = ownerOf(d);
      return o ? [[d.id, `${o} ${labelOf(o)}`] as const] : [];
    }),
  );
  const colors = new Map(
    shown.flatMap((d): (readonly [string, Rgb3])[] => {
      const o = ownerOf(d);
      return o ? [[d.id, color(o)]] : [];
    }),
  );
  return { shown, labels, colors };
};

export const look = (k: Kit): Session["look"] => ({
  show: (ctx, req) =>
    k.modules.video.frames(req.frames).asyncAndThen((fs) => {
      const { detections, labelling, render } = k.modules;
      const fset = new Set(fs);
      const own = labelling.owners();
      const inView = detections.all().filter((d) => fset.has(d.frame));
      const hits = req.rejects
        ? detections.collapse(
            inView.filter((d) => own.get(d.id) === REJECT),
            ctx.cfg.alias_iou,
          )
        : inView.filter((d) => d.score >= threshold(ctx, req) && own.get(d.id) !== REJECT);
      if (req.crops)
        return view(k, req, hits, "show").map((image) => ({
          image,
          hits: hits.map((d) => summary(d, own, k.modules.video)),
        }));
      const drawn = req.objects
        ? perObject(k, hits, own)
        : {
            shown: hits,
            labels: new Map(
              hits.flatMap((d) => {
                const o = own.get(d.id);
                return o ? [[d.id, o] as const] : [];
              }),
            ),
            colors: undefined,
          };
      return sequence(fs, (i) =>
        render.overlay(
          i,
          drawn.shown.filter((d) => d.frame === i),
          { scale: fs.length > 1 ? 0.35 : 0.6, labels: drawn.labels, colors: drawn.colors },
        ),
      )
        .andThen((tiles) => saveGrid(k, tiles, "show"))
        .andThen(someFrames)
        .map((image) => ({ image, hits: drawn.shown.map((d) => summary(d, own, k.modules.video)) }));
    }),

  crop: (_ctx, req) =>
    k.modules.detections.get(req.id).asyncAndThen((d) =>
      k.modules.render
        .cropRegion(d)
        .andThen((img) => save(k, img, `crop-${d.id}`, 95))
        .map((image) => ({ image, ...summary(d, k.modules.labelling.owners(), k.modules.video) })),
    ),

  similar: (ctx, req) =>
    k.modules.detections.get(req.id).asyncAndThen((d) => {
      const own = k.modules.labelling.owners();
      const th = threshold(ctx, req);
      const { near, matches } = scored(
        k.modules.detections.all().filter((o) => o.frame !== d.frame && o.score >= th),
        d.emb,
        req.k ?? 8,
        own,
        k.modules.video,
      );
      const labels = [`${d.id} (query)`, ...matches.map(simLabel)];
      return saveSheet(k, [d, ...near], `similar-${d.id}`, labels).map((image) => ({
        query: summary(d, own, k.modules.video),
        image,
        matches,
      }));
    }),

  dets: (ctx, req) =>
    k.modules.video.frames(req.frames).asyncAndThen((fs) => {
      const own = k.modules.labelling.owners();
      const sel = selectDets(k.modules.detections.all(), new Set(fs), threshold(ctx, req), req.prompt);
      return (req.crops ? view(k, req, sel, "dets") : okAsync(null)).map((image) => ({
        image,
        hits: sel.map((d) => summary(d, own, k.modules.video)),
      }));
    }),

  gaps: (_ctx, req) =>
    k.modules.video.frames(req.frames).asyncAndThen((fs) => {
      const { video, render, detections, labelling } = k.modules;
      const own = labelling.owners();
      return sequence(fs, (i) =>
        video.image(i).andThen((img) =>
          video
            .shape(i)
            .map((shape) =>
              covered(
                detections.byFrame(i).filter((d) => own.has(d.id)),
                shape,
              ),
            )
            .asyncAndThen((cov) => render.tagged(render.scale(render.darken(img, cov, 0.15), 0.35), i)),
        ),
      )
        .andThen((tiles) => saveGrid(k, tiles, "gaps"))
        .andThen(someFrames)
        .map((image) => ({ image }));
    }),
});
