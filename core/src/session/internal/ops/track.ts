/**
 * The tracking ops. They change only the queue's saved state. The units run in the background, and tracks stay out of
 * ops.jsonl. Restarting a cancelled or failed track keeps its finished frames.
 */
import { err, errAsync, ok, okAsync, Result, type ResultAsync } from "neverthrow";
import { isDetId, rle, type DetId } from "../../../detections/pure.ts";
import { MASK_SIZE } from "../../../perception/pure.ts";
import {
  CONVERGED_FRAMES,
  convergedGroups,
  parkRule,
  topTrackPriority,
  trackDone,
  trackFinished,
  trackParked,
  type AssocLink,
  type PendingFrame,
  type TrackIndex,
  type TrackRecord,
} from "../../../tracking/pure.ts";
import type { Session, SessionError, TrackPrepareReply, TrackProposal, TrackSummary } from "../../types.ts";
import { round } from "../replies.ts";
import type { Kit } from "../context.ts";
import { detectionsOf, parallel } from "../context.ts";
import { writeMeta } from "../persist.ts";
import { saveTracks, unassociated } from "../tracks.ts";

const summary = (k: Kit, t: TrackRecord): TrackSummary => {
  const owner = k.modules.labelling.owners().get(t.det);
  return {
    id: t.id,
    det: t.det,
    clip: t.clip,
    ...(owner ? { object: owner } : {}),
    seed_at: t.seedAt,
    state: t.state,
    failure: t.failure,
    priority: t.priority,
    forward: t.forward,
    reverse: t.reverse,
    done: trackDone(t),
    total: t.last - t.first + 1,
    parked: trackParked(t),
    skipped: t.skipped,
    seen: t.seeded ? { first: t.seenFirst, last: t.seenLast, count: t.seenCount } : null,
    finished: trackFinished(t),
  };
};

const statusOf = (k: Kit) => {
  const { paused, tracks, pending } = k.tracks.index();
  return { paused, tracks: tracks.map((t) => summary(k, t)), waiting: pending.length };
};

/** A detection as a proposal shows it. */
const shownDet = (k: Kit, id: DetId, how: AssocLink["how"]) => {
  const d = k.modules.detections.get(id);
  return d.isOk() ? [{ id, how, prompt: d.value.prompt, score: round(d.value.score, 3), frame: d.value.frame }] : [];
};

/** The groups a review shows. Tracks in one group are likely one object. Nothing here assigns or merges anything. */
const proposalsOf = (k: Kit) => {
  const { tracks, pairs, pending } = k.tracks.index();
  const { links, weak } = k.tracks.assoc();
  const links_ = Object.entries(links);
  const proposal = (t: TrackRecord): TrackProposal => {
    const owner = k.modules.labelling.owners().get(t.det);
    const dets = [
      ...shownDet(k, t.det, "seed"),
      ...links_.flatMap(([id, l]) => (l.track === t.id && id !== t.det && isDetId(id) ? shownDet(k, id, l.how) : [])),
    ];
    return {
      track: t.id,
      clip: t.clip,
      seed_at: t.seedAt,
      state: t.state,
      finished: trackFinished(t),
      auto: t.auto,
      ...(owner ? { object: owner } : {}),
      dets,
      score: Math.max(0, ...dets.map((d) => d.score)),
      frames: t.seeded ? { first: t.seenFirst, last: t.seenLast, count: t.seenCount } : null,
      converged_with: pairs.flatMap((p) =>
        p.a === t.id || p.b === t.id
          ? [{ track: p.a === t.id ? p.b : p.a, frames: p.frames, first: p.first, last: p.last }]
          : [],
      ),
    };
  };
  const live = tracks.filter((t) => t.state !== "cancelled");
  const groups = convergedGroups(
    live.map((t) => t.id),
    pairs,
    CONVERGED_FRAMES,
  ).map((ids) => ({ tracks: live.filter((t) => ids.includes(t.id)).map(proposal) }));
  return {
    groups,
    waiting: pending.length,
    left_out: links_.flatMap(([id, l]) => (l.how === "over" && isDetId(id) ? [id] : [])),
    weak_covers: weak.length,
  };
};

/** The tracks these ids name, all of them when absent. An unknown id is an error. */
const pick = (
  index: TrackIndex,
  ids: readonly string[] | null | undefined,
): Result<ReadonlySet<string>, SessionError> => {
  if (!ids) return ok(new Set(index.tracks.map((t) => t.id)));
  const unknown = ids.find((id) => !index.tracks.some((t) => t.id === id));
  return unknown === undefined ? ok(new Set(ids)) : err({ kind: "no-track", id: unknown });
};

export const track = (k: Kit): Session["track"] => {
  /** An op over the saved index: tracking must be on, and the new index is saved before the reply. */
  const change = (make: (index: TrackIndex) => Result<TrackIndex, SessionError>) => {
    if (!k.modules.tracking) return errAsync<ReturnType<typeof statusOf>, SessionError>({ kind: "tracking-off" });
    return make(k.tracks.index())
      .asyncAndThen((next) => saveTracks(k, next))
      .map(() => statusOf(k));
  };
  const whenOn = <T>(run: () => ResultAsync<T, SessionError>): ResultAsync<T, SessionError> =>
    k.modules.tracking ? run() : errAsync({ kind: "tracking-off" });

  return {
    start: (ctx, req) =>
      change((index) =>
        detectionsOf(k, req.ids).andThen((dets) => {
          const { video } = k.modules;
          const priority = req.first ? topTrackPriority(index) + 1 : 0;
          return Result.combine(
            dets.map(
              (
                d,
              ): Result<
                { det: DetId; clip: TrackRecord["clip"]; at: number; frames: number; first: number; last: number },
                SessionError
              > => {
                const ref = video.trackRef(d.frame);
                return ref
                  ? ok({
                      det: d.id,
                      clip: ref.clipKey,
                      at: ref.index,
                      frames: video.trackGrid(ref.clipKey).length,
                      ...video.trackShot(ref.clipKey, ref.index),
                    })
                  : err({ kind: "no-keyframe", frame: d.frame });
              },
            ),
          ).map((places) =>
            places.reduce<TrackIndex>((acc, p) => {
              // A detection association put on a track is that track's to follow.
              const linked = k.tracks.assoc().links[p.det]?.track;
              const old = acc.tracks.find((t) => t.det === p.det || t.id === linked);
              if (old) {
                const back: TrackRecord = {
                  ...old,
                  state: "active",
                  failure: null,
                  priority: Math.max(old.priority, priority),
                };
                return { ...acc, tracks: acc.tracks.map((t) => (t === old ? back : t)) };
              }
              const fresh: TrackRecord = {
                id: `t${acc.next}`,
                det: p.det,
                clip: p.clip,
                seedAt: p.at,
                clipFrames: p.frames,
                first: p.first,
                last: p.last,
                priority,
                state: "active",
                failure: null,
                seeded: false,
                forward: p.at,
                reverse: p.at,
                ...parkRule(ctx.cfg.track_fps, ctx.cfg.track_recheck),
                forwardMisses: 0,
                reverseMisses: 0,
                skipped: 0,
                seenFirst: p.at,
                seenLast: p.at,
                seenCount: 1,
                auto: false,
              };
              return { ...acc, next: acc.next + 1, tracks: [...acc.tracks, fresh] };
            }, index),
          );
        }),
      ),

    auto: (ctx, req) =>
      change((index) =>
        k.modules.video.frames(req.frames).map((frames) => {
          const threshold = req.threshold ?? ctx.cfg.threshold;
          const rule = parkRule(ctx.cfg.track_fps, ctx.cfg.track_recheck);
          const asked = frames.flatMap((frame): readonly PendingFrame[] => {
            const ref = k.modules.video.trackRef(frame);
            const waits = k.modules.detections
              .byFrame(frame)
              .some((d) => d.score >= threshold && unassociated(k, d.id));
            return ref && waits
              ? [{ clip: ref.clipKey, at: ref.index, frame, threshold, maxTracks: ctx.cfg.auto_tracks, ...rule }]
              : [];
          });
          const others = index.pending.filter((p) => !asked.some((q) => q.frame === p.frame));
          return { ...index, pending: [...others, ...asked].toSorted((a, b) => a.frame - b.frame) };
        }),
      ),

    proposals: () => whenOn(() => okAsync(proposalsOf(k))),

    prioritise: (_ctx, req) =>
      change((index) =>
        pick(index, req.ids).map((ids) => {
          const top = topTrackPriority(index) + 1;
          return { ...index, tracks: index.tracks.map((t) => (ids.has(t.id) ? { ...t, priority: top } : t)) };
        }),
      ),

    pause: () => change((index) => ok({ ...index, paused: true })),
    resume: () => change((index) => ok({ ...index, paused: false })),

    cancel: (_ctx, req) =>
      change((index) =>
        pick(index, req.ids).map((ids) => ({
          ...index,
          tracks: index.tracks.map((t) =>
            ids.has(t.id) && t.state === "active" ? { ...t, state: "cancelled" as const } : t,
          ),
          // Cancelling everything also stops what auto tracking hasn't started.
          pending: req.ids ? index.pending : [],
        })),
      ),

    status: () => whenOn(() => okAsync(statusOf(k))),

    prepare: (ctx, req) =>
      whenOn(() =>
        k.modules.video.findClip(req.clip).asyncAndThen((c): ResultAsync<TrackPrepareReply, SessionError> => {
          if (k.tracks.index().tracks.some((t) => t.clip === c.key))
            return errAsync({ kind: "clip-has-tracks", clip: c.key });
          return k.modules.video
            .prepareTrack(req.video, c.key, ctx.cfg.track_fps)
            .andThen((clip) => writeMeta(k).map(() => clip))
            .map((clip) => ({
              clip: clip.key,
              frames: k.modules.video.trackGrid(clip.key).length,
              cuts: k.modules.video.trackCuts(clip.key),
            }));
        }),
      ),

    frames: (_ctx, req) =>
      whenOn(() =>
        k.modules.video
          .findClip(req.clip)
          .map((c) => ({
            clip: c.key,
            frames: k.modules.video.trackGrid(c.key).map((s) => {
              const own = { clipKey: c.key, index: s.at };
              const key = s.keyframe === null ? null : k.modules.video.ref(s.keyframe).unwrapOr(null);
              const image = key ? k.stores.frameFiles.locate(key) : k.stores.frameFiles.locateTrack(own);
              return { ...s, image };
            }),
            cuts: k.modules.video.trackCuts(c.key),
          }))
          .asyncAndThen((x) => okAsync(x)),
      ),

    masks: (_ctx, req) =>
      whenOn(() =>
        k.modules.video.findClip(req.clip).asyncAndThen((c) => {
          const place = k.modules.video.trackGrid(c.key)[req.at];
          if (!place) return errAsync<never, SessionError>({ kind: "missing-track-frame", clip: c.key, at: req.at });
          const tracks = k.tracks.index().tracks.filter((t) => t.clip === c.key);
          // Files past a leg's last frame are from a unit that never finished.
          const covered = tracks.filter((t) => t.seeded && req.at <= t.forward && req.at >= t.reverse);
          return parallel(covered, (t) =>
            k.stores.tracks.readMask({ clip: t.clip, track: t.id }, req.at).map((m) => {
              return m
                ? [
                    {
                      track: t.id,
                      det: t.det,
                      score: m.score,
                      iou: m.iou,
                      mask: { format: "rle" as const, w: MASK_SIZE, h: MASK_SIZE, counts: rle(m.mask) },
                    },
                  ]
                : [];
            }),
          ).map((rows) => ({
            clip: c.key,
            at: req.at,
            t: place.t,
            keyframe: place.keyframe,
            masks: rows.flat(),
            parked: covered.filter((_, n) => rows[n]?.length === 0).map((t) => t.id),
          }));
        }),
      ),
  };
};
