/** The find ops: contact sheet, prompt search over keyframes, region search and semantic heatmaps. */
import { errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type { Detection, RunRecord } from "../../../detections/pure.ts";
import { covered } from "../../../detections/pure.ts";
import type { Box, RGB } from "../../../pixels/index.ts";
import { crop } from "../../../pixels/index.ts";
import { hostFailure } from "../../../ports/index.ts";
import type { FrameNo } from "../../../video/pure.ts";
import type { Ctx } from "../../pure.ts";
import type { Session, SessionError } from "../../types.ts";
import type { Kit } from "../context.ts";
import { detectionsOf, sequence } from "../context.ts";
import { ensureRegionRun, ensureRun } from "../detect.ts";
import { saveGrid, someFrames, view } from "../pictures.ts";
import { round, scored, summary, threshold } from "../replies.ts";

/** The smallest side, in pixels, of a search region. */
const MIN_REGION = 16;

/** Presence per frame, rounded to 3 decimals. */
const presenceOf = (runs: readonly { readonly i: FrameNo; readonly rec: RunRecord }[]) =>
  Object.fromEntries(runs.map(({ i, rec }) => [i, round(rec.presence, 3)]));

/**
 * Every frame's run of a prompt, cached or detected, in spec order. A frame listed twice runs once but counts
 * twice. Meanwhile the stored features of these frames and of `hold` are protected from disk-budget eviction. A
 * search over more keyframes than the budget holds then doesn't evict the frames it is about to read.
 */
const runsOn = (k: Kit, ctx: Ctx, fs: readonly FrameNo[], prompt: string, hold?: string | null) => {
  const extra: Result<readonly FrameNo[], SessionError> =
    hold === undefined || hold === null ? ok([]) : k.modules.video.frames(hold);
  return extra.asyncAndThen((more) => {
    const release = k.modules.perception.hold([...fs, ...more]);
    return sequence(fs, (i) => ensureRun(k, ctx, i, prompt).map((rec) => ({ i, rec })))
      .map((runs) => {
        release();
        return runs;
      })
      .mapErr((e) => {
        release();
        return e;
      });
  });
};

const underscored = (prompt: string) => prompt.replaceAll(" ", "_");

/** The search region of a request box. Corners may come in any order. It is clamped to the frame, in whole pixels. */
const regionOf = (box: Box, img: RGB): Box => [
  Math.max(0, Math.floor(Math.min(box[0], box[2]))),
  Math.max(0, Math.floor(Math.min(box[1], box[3]))),
  Math.min(img.w, Math.ceil(Math.max(box[0], box[2]))),
  Math.min(img.h, Math.ceil(Math.max(box[1], box[3]))),
];

/** The semantic tile of one frame, with the heatmap tinted over it. `uncovered` zeroes owned and rejected regions. */
const semanticTile = (
  k: Kit,
  ctx: Ctx,
  i: FrameNo,
  rec: RunRecord,
  uncovered: boolean,
): ResultAsync<{ readonly tile: RGB; readonly area: number | null }, SessionError> => {
  const { video, render, detections, labelling } = k.modules;
  return video.image(i).andThen((img) => {
    const ref = rec.heatmap;
    if (ref === null) return okAsync({ tile: render.scale(img, 0.35), area: null });
    return k.stores.heatmaps
      .read(ref)
      .andThen((png) =>
        png === null
          ? errAsync<Uint8Array, SessionError>({ kind: "missing-heatmap", ref })
          : okAsync<Uint8Array, SessionError>(png),
      )
      .andThen((png) =>
        ResultAsync.fromPromise(k.host.codec.decodeGray(png), (e) => hostFailure("codec", "decodeGray", e)),
      )
      .andThen((heat) => {
        const own = labelling.owners();
        const cov: Result<Uint8Array | null, SessionError> = uncovered
          ? video.shape(i).map((shape) =>
              covered(
                detections.byFrame(i).filter((d) => own.has(d.id)),
                shape,
              ),
            )
          : ok(null);
        return cov.asyncAndThen((c) => {
          const t = render.heatTint(img, heat, { active: ctx.cfg.active, covered: c });
          return render
            .tagged(render.scale(t.image, 0.35), i, ` p=${rec.presence.toFixed(2)}`)
            .map((tile) => ({ tile, area: round(t.activeFraction, 4) }));
        });
      });
  });
};

export const find = (k: Kit): Session["find"] => ({
  sheet: (_ctx, req) =>
    k.modules.video.frames(req.frames).asyncAndThen((fs) =>
      sequence(fs, (i) => k.modules.render.overlay(i, [], { scale: 0.25 })).andThen((tiles) =>
        saveGrid(k, tiles, "sheet")
          .andThen(someFrames)
          .andThen((image) =>
            Result.combine(fs.map((i) => k.modules.video.t(i).map((t) => ({ frame: i, t })))).map((list) => ({
              image,
              frames: list,
            })),
          ),
      ),
    ),

  find: (ctx, req) => {
    const own = k.modules.labelling.owners();
    const th = threshold(ctx, req);
    const t0 = k.host.clock.now();
    return k.modules.video.frames(req.frames).asyncAndThen((fs) =>
      runsOn(k, ctx, fs, req.prompt, req.hold).andThen((runs) =>
        Result.combine(runs.map(({ rec }) => detectionsOf(k, rec.ids)))
          .map((per) => per.flat().filter((d) => d.score >= th))
          .asyncAndThen((hits) => {
            const presence = presenceOf(runs);
            const present = fs.filter((i) => (presence[i] ?? 0) >= ctx.cfg.presence);
            const seconds = round((k.host.clock.now() - t0) / 1000, 1);
            return view(k, req, hits, `find-${underscored(req.prompt)}`).map((image) => ({
              prompt: req.prompt,
              seconds,
              presence,
              present,
              image,
              hits: hits.map((d) => summary(d, own)),
            }));
          }),
      ),
    );
  },

  search: (ctx, req) => {
    const { video, perception, detections, labelling } = k.modules;
    const i = req.frame;
    if (!video.live(i)) return errAsync({ kind: "no-keyframe", frame: i });
    return video.image(i).andThen((img) => {
      const region = regionOf(req.box, img);
      const [x0, y0, x1, y1] = region;
      if (x1 - x0 < MIN_REGION || y1 - y0 < MIN_REGION)
        return errAsync<never, SessionError>({ kind: "region-too-small", w: x1 - x0, h: y1 - y0, min: MIN_REGION });
      const own = labelling.owners();
      const th = threshold(ctx, req);
      const prompt = req.prompt?.trim();
      // Both halves use one crop. The region run encodes it and the similarity half embeds it.
      const where = { img, region, crop: crop(img, x0, y0, x1, y1) };
      const prompted = prompt
        ? ensureRegionRun(k, ctx, i, where, prompt).andThen((rec) =>
            detectionsOf(k, rec.ids).map((ds) => ({
              presence: round(rec.presence, 3),
              hits: ds.filter((d) => d.score >= th),
            })),
          )
        : okAsync<{ presence: number | null; hits: readonly Detection[] }, SessionError>({ presence: null, hits: [] });
      return prompted.andThen(({ presence, hits }) =>
        ((req.similar ?? true)
          ? perception.embedCrop(where.crop).map(
              (emb) =>
                scored(
                  detections.all().filter((o) => o.score >= th),
                  emb,
                  req.k ?? 8,
                  own,
                ).matches,
            )
          : okAsync([])
        ).map((similar) => ({
          frame: i,
          box: region,
          prompt: prompt ?? null,
          presence,
          hits: hits.map((d) => summary(d, own)),
          similar,
        })),
      );
    });
  },

  semantic: (ctx, req) =>
    k.modules.video.frames(req.frames).asyncAndThen((fs) =>
      runsOn(k, ctx, fs, req.prompt, req.hold).andThen((runs) =>
        sequence(runs, ({ i, rec }) => semanticTile(k, ctx, i, rec, !!req.uncovered).map((t) => ({ i, ...t }))).andThen(
          (tiles) => {
            const name = `semantic-${underscored(req.prompt)}` + (req.uncovered ? "-uncovered" : "");
            const area = Object.fromEntries(tiles.flatMap(({ i, area: a }) => (a === null ? [] : [[i, a] as const])));
            return saveGrid(
              k,
              tiles.map((t) => t.tile),
              name,
            )
              .andThen(someFrames)
              .map((image) => ({ prompt: req.prompt, image, area, presence: presenceOf(runs) }));
          },
        ),
      ),
    ),
});
