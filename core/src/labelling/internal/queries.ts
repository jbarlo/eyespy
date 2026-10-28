/** Queries that know about ownership, as plain functions over one labelling state and the DetectionLookup. */
import { Result, err, ok } from "neverthrow";
import type { DetId, Detection } from "../../detections/pure.ts";
import { invariant } from "../../invariant/index.ts";
import type { Appearance } from "../../perception/pure.ts";
import { mean, normalize, similarity, sum } from "../../perception/pure.ts";
import type { Obj, ObjectId, Objects, Owner } from "../model.ts";
import { isObjectId, isOwner, round } from "../model.ts";
import type { DetectionLookup } from "../ports.ts";
import type { LabelCtx, LabellingError, ObjectMatch, ObjectSummary, UnassignedQuery } from "../types.ts";

export type View = {
  readonly objects: Objects;
  readonly owners: ReadonlyMap<DetId, Owner>;
  readonly look: DetectionLookup;
};

/** `id` as an owner that exists (an object or the reject set). */
export const owner = (v: View, id: string): Result<Owner, LabellingError> =>
  isOwner(id) && v.objects.has(id) ? ok(id) : err({ kind: "no-object", id });

/** `id` as a real object that exists (not the reject set). */
export const realObject = (v: View, id: string): Result<ObjectId, LabellingError> =>
  isObjectId(id) && v.objects.has(id) ? ok(id) : err({ kind: "no-object", id });

export const obj = (v: View, id: Owner): Obj => {
  const o = v.objects.get(id);
  invariant(o !== undefined, () => `object ${id} vanished`);
  return o;
};

export const objectIds = (v: View): readonly ObjectId[] => [...v.objects.keys()].filter(isObjectId);

const dets = (v: View, ids: readonly DetId[]): Result<readonly Detection[], LabellingError> =>
  Result.combine(ids.map((m) => v.look.get(m)));

const membersOf = (v: View, id: string): Result<readonly Detection[], LabellingError> =>
  owner(v, id).andThen((o) => dets(v, obj(v, o).members));

export const summary = (v: View, id: string): Result<ObjectSummary, LabellingError> =>
  owner(v, id).andThen((oid) => {
    const o = obj(v, oid);
    return dets(v, o.members).map((ds): ObjectSummary => {
      const ms = [...ds].sort((a, b) => a.frame - b.frame);
      const best = v.look.bestView(ds);
      // A plain record keeps reply keys in order.
      const prompts = ms.reduce<Readonly<Record<string, number>>>(
        (acc, d) => ({ ...acc, [d.prompt]: Math.max(acc[d.prompt] ?? 0, round(d.score, 3)) }),
        {},
      );
      return {
        id: oid,
        label: o.label,
        sightings: new Set(ms.map((d) => d.frame)).size,
        members: o.members,
        first_t: ms[0]?.t ?? null,
        last_t: ms.at(-1)?.t ?? null,
        best: best ? best.id : null,
        prompts: Object.fromEntries(Object.entries(prompts).sort((x, y) => y[1] - x[1])),
      };
    });
  });

export const best = (v: View, id: string): Result<Detection | null, LabellingError> =>
  membersOf(v, id).map((ds) => v.look.bestView(ds));

export const centroid = (v: View, id: string): Result<Appearance, LabellingError> =>
  owner(v, id).andThen((oid) =>
    dets(v, obj(v, oid).members).andThen((ds) =>
      ds.length
        ? ok(normalize(mean(ds.map((d) => d.emb))))
        : err<Appearance, LabellingError>({ kind: "object-no-members", id: oid }),
    ),
  );

export const match = (
  v: View,
  ids: readonly string[],
  k: number,
  ctx: LabelCtx,
): Result<readonly ObjectMatch[], LabellingError> =>
  Result.combine(ids.map((i) => v.look.get(i))).andThen((qs) =>
    v.look.expand(ids, ctx.aliasIou).andThen((expanded) => {
      const qv = normalize(sum(qs.map((d) => d.emb)));
      const skip = new Set(expanded);
      return Result.combine(
        objectIds(v).map((oid) => {
          const o = obj(v, oid);
          return dets(
            v,
            o.members.filter((m) => !skip.has(m)),
          ).map((ms) => ({ oid, o, ms }));
        }),
      ).map((rows) =>
        rows
          .flatMap(({ oid, o, ms }): ObjectMatch[] => {
            const first = ms[0];
            if (first === undefined) return [];
            const closest = ms.reduce(
              (b, d) => {
                const s = similarity(d.emb, qv);
                return s > b.sim ? { d, sim: s } : b;
              },
              { d: first, sim: -2 },
            );
            return [
              {
                obj: oid,
                label: o.label,
                sim: round(similarity(normalize(sum(ms.map((d) => d.emb))), qv), 3),
                closest: closest.d.id,
                closest_sim: round(closest.sim, 3),
                sightings: new Set(ms.map((d) => d.frame)).size,
              },
            ];
          })
          .toSorted((a, b) => b.sim - a.sim)
          .slice(0, k),
      );
    }),
  );

export const unassigned = (v: View, q: UnassignedQuery, ctx: LabelCtx): readonly Detection[] => {
  const { threshold, prompt, frames } = q;
  return v.look.collapse(
    v.look
      .all()
      .filter(
        (d) =>
          d.score >= threshold &&
          !v.owners.has(d.id) &&
          (!prompt || d.prompt === prompt) &&
          (!frames || frames.has(d.frame)),
      ),
    ctx.aliasIou,
  );
};
