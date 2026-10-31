/** The label ops: objects (create, edit, inspect, suggest, match), rejects, the triage queue and undo/redo. */
import type { Result, ResultAsync } from "neverthrow";
import { err, ok, okAsync } from "neverthrow";
import type { DetId, Detection } from "../../../detections/pure.ts";
import { groups, viewQuality } from "../../../detections/pure.ts";
import type { ObjectId, Owner } from "../../../labelling/index.ts";
import { isObjectId } from "../../../labelling/pure.ts";
import { CROP_COLS, CROP_SHEET_MAX, GROUP_PAGE } from "../../../render/pure.ts";
import type { FrameNo } from "../../../video/pure.ts";
import type { Ctx } from "../../pure.ts";
import type { Session, SessionError, TodoReply } from "../../types.ts";
import type { Kit } from "../context.ts";
import { detectionsOf, labelCtx } from "../context.ts";
import { save, saveSheet, view } from "../pictures.ts";
import { isPhoto, scored, simLabel, summary, threshold } from "../replies.ts";

/** An id labelling just accepted as a real object, because delete succeeded on it. */
const objectId = (id: string): Result<ObjectId, SessionError> =>
  isObjectId(id) ? ok(id) : err({ kind: "no-object", id });

/** Live frames of a request spec as a set, or null for no spec, meaning no frame filter. */
const frameFilter = (k: Kit, spec: string | null | undefined): Result<ReadonlySet<FrameNo> | null, SessionError> =>
  spec ? k.modules.video.frames(spec).map((fs) => new Set(fs)) : ok(null);

const unassigned = (k: Kit, ctx: Ctx, th: number, prompt?: string | null, fs?: ReadonlySet<FrameNo> | null) =>
  k.modules.labelling.unassigned({ threshold: th, prompt: prompt ?? null, frames: fs ?? null }, labelCtx(ctx));

export const label = (k: Kit): Session["label"] => {
  const L = k.modules.labelling;
  return {
    create: (ctx, req) => L.create(req.label, req.ids, labelCtx(ctx)).andThen(({ id }) => L.summary(id)),
    add: (ctx, req) => L.add(req.obj, req.ids, labelCtx(ctx)).andThen(() => L.summary(req.obj)),
    remove: (ctx, req) => L.remove(req.obj, req.ids, labelCtx(ctx)).andThen(() => L.summary(req.obj)),
    merge: (_ctx, req) => L.merge(req.into, req.from).andThen(() => L.summary(req.into)),
    relabel: (_ctx, req) => L.relabel(req.obj, req.label).andThen(() => L.summary(req.obj)),
    delete: (_ctx, req) => L.delete(req.obj).andThen(() => objectId(req.obj).map((deleted) => ({ deleted }))),

    show: (ctx, req) =>
      L.summary(req.obj)
        .andThen((s) => frameFilter(k, req.frames).map((fr) => ({ s, fr })))
        .andThen(({ s, fr }) =>
          detectionsOf(k, s.members).map((ms) => ({
            s,
            ms: k.modules.detections.collapse(
              ms.filter((d) => !fr || fr.has(d.frame)),
              ctx.cfg.alias_iou,
            ),
          })),
        )
        .asyncAndThen(({ s, ms }) => {
          const own = L.owners();
          const off = req.offset ?? 0;
          const page = ms.slice(off, off + CROP_SHEET_MAX);
          return saveSheet(k, page, `obj-${req.obj}`).map((image) => ({
            ...s,
            total: ms.length,
            offset: off,
            image,
            hits: page.map((d) => summary(d, own, k.modules.video)),
          }));
        }),

    suggest: (ctx, req) =>
      L.centroid(req.obj)
        .andThen((c) => L.best(req.obj).andThen((b) => L.summary(req.obj).map((query) => ({ c, b, query }))))
        .asyncAndThen(({ c, b, query }) => {
          const own = L.owners();
          const th = threshold(ctx, req);
          const { near, matches } = scored(
            k.modules.detections.all().filter((o) => o.score >= th && !own.has(o.id)),
            c,
            req.k ?? 8,
            own,
            k.modules.video,
          );
          const best: readonly Detection[] = b ? [b] : [];
          const labels = [`${req.obj} best=${b?.id ?? ""}`, ...matches.map(simLabel)];
          return saveSheet(k, [...best, ...near], `suggest-${req.obj}`, labels).map((image) => ({
            query,
            image,
            matches,
          }));
        }),

    match: (ctx, req) =>
      L.match(req.ids, req.k ?? 5, labelCtx(ctx))
        .andThen((matches) =>
          detectionsOf(k, req.ids).map((qs) => ({
            ids: req.ids,
            current: [
              ...new Set(
                qs.flatMap((d): Owner[] => {
                  const o = L.ownerOf(d.id);
                  return o ? [o] : [];
                }),
              ),
            ],
            matches,
          })),
        )
        .asyncAndThen((r) => okAsync(r)),

    reject: (ctx, req) => {
      const bulk: readonly DetId[] = req.prompt ? unassigned(k, ctx, 0, req.prompt).map((d) => d.id) : [];
      return L.reject([...(req.ids ?? []), ...bulk], labelCtx(ctx));
    },

    todo: (ctx, req) =>
      frameFilter(k, req.frames).asyncAndThen((fr): ResultAsync<TodoReply, SessionError> => {
        const own = L.owners();
        const q = unassigned(k, ctx, threshold(ctx, req), req.prompt, fr);
        if (req.groups) {
          const gs = groups(q, ctx.cfg.group_sim, Math.trunc(ctx.cfg.group_window));
          const off = req.offset ?? 0;
          const page = gs.slice(off, off + GROUP_PAGE);
          const tiles = page.map((g, j) => ({
            id: `g${off + j}`,
            // best views first
            regions: [...g]
              .sort((a, b) => viewQuality(b) - viewQuality(a))
              .slice(0, CROP_COLS)
              .map((d) => (isPhoto(k.modules.video, d.frame) ? { ...d, photo: true as const } : d)),
          }));
          const sheet = tiles.length
            ? k.modules.render.groupSheet(tiles).andThen((img) => (img ? save(k, img, "todo-groups") : okAsync(null)))
            : okAsync(null);
          return sheet.map((image) => ({
            total: q.length,
            groups_total: gs.length,
            image,
            groups: page.map((g, j) => ({
              group: `g${off + j}`,
              ids: g.map((d) => d.id),
              frames: `${Math.min(...g.map((d) => d.frame))}-${Math.max(...g.map((d) => d.frame))}`,
            })),
          }));
        }
        const shown = q.slice(0, req.limit ?? CROP_SHEET_MAX);
        return (shown.length ? view(k, req, shown, "todo") : okAsync(null)).map((image) => ({
          total: q.length,
          image,
          hits: shown.map((d) => summary(d, own, k.modules.video)),
        }));
      }),

    undo: () => L.undo(),
    redo: () => L.redo(),
  };
};
