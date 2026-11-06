/**
 * Video tracking in the session: saved tracks, and the background unit, one object on one frame.
 *
 * A unit does one of three things for the next piece of work (`nextUnit`):
 *   1. If the frame's trunk isn't stored, it encodes the frame. That is a unit of its own, so only frames someone is
 *      about to read get encoded, and the nearest one first.
 *   2. For a track not seeded yet, it seeds it: seed.npz, the seed frame's mask, then tracks.json.
 *   3. Otherwise it moves the track to its next frame: the mask, the leg's memory as of that frame, tracks.json, and only
 *      then the leg's old memory file goes.
 * A crash before tracks.json leaves files that nothing names, and the same unit runs again and overwrites them. Finished
 * frames are in tracks.json, so cancel, pause and reload keep them, and resuming starts after them.
 *
 * A leg that misses the object parks: it skips frames and looks again on a schedule (`parkRule`). When the object is
 * back the same track goes on frame by frame, as propagate takes a gap as it comes. A skipped frame has no mask file and
 * is covered all the same, and `track.masks` names the tracks parked there. A frame looked at and missed has an empty
 * mask.
 *
 * Auto tracking (`track.auto`) queues the keyframes that have detections no track holds yet, and association is a unit
 * of its own: when the tracks of a keyframe's shot have covered it, its detections go against their masks there, and
 * those no track holds seed new tracks behind any requested one. Masks of a parked track must be there to compare, so a
 * parked leg stops on a queued keyframe. A track's decisions go to assoc.json first and tracks.json after, so a crash
 * between them runs the unit again. Two tracks' masks agreeing on a frame are counted in `pairs`, as a merge suggestion.
 * Nothing merges tracks or gives them to an object on its own: labelling stays the user's.
 *
 * Tracks are derived data and stay out of ops.jsonl. Their link to labelling is only the seed detection's id, looked up
 * when read, so deleting or changing an object, and undo, leave tracks alone. A detection goes only with its clip, and
 * so do its tracks.
 *
 * One TrackFrame stays held, so the neck runs once while several objects pass the same frame. A failure that retrying
 * can't fix fails the track and the queue moves on. Any other failure goes to the actor, which backs off.
 *
 * With tracking off nothing here reads or writes a file.
 */
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { DetId } from "../../detections/pure.ts";
import { invariant } from "../../invariant/index.ts";
import type { TrackFrame } from "../../tracking/index.ts";
import {
  ASSOC_FORMAT,
  AUTO_PRIORITY,
  CONVERGED_IOU,
  EMPTY_TRACK_INDEX,
  TRACK_FORMAT,
  associate,
  nextAssociation,
  nextUnit,
  planeIou,
  startTrack,
  type AssocData,
  type AssocDet,
  type AssocLink,
  type PendingFrame,
  type TrackDirection,
  type TrackIndex,
  type TrackMemory,
  type TrackPair,
  type TrackRecord,
  type TrackUnit,
} from "../../tracking/pure.ts";
import type { ClipKey } from "../../video/pure.ts";
import { parallel } from "./context.ts";
import type { SessionError } from "../types.ts";
import type { Kit } from "./context.ts";
import { writeMeta } from "./persist.ts";
import { binaryPlane, seedPlane } from "./tracks.kernel.ts";

/** Writes the index, after stamping the format the first time. */
export const saveTracks = (k: Kit, index: TrackIndex): ResultAsync<void, SessionError> => {
  const f = k.state.formats();
  const stamp =
    f.tracks === TRACK_FORMAT ? okAsync(undefined) : writeMeta(k, { formats: { ...f, tracks: TRACK_FORMAT } });
  return stamp.andThen(() => k.stores.tracks.writeIndex(index)).map(() => k.tracks.set(index));
};

/** Writes what association decided, after stamping its format the first time. */
const saveAssoc = (k: Kit, assoc: AssocData): ResultAsync<void, SessionError> => {
  const f = k.state.formats();
  const stamp =
    f.assoc === ASSOC_FORMAT ? okAsync(undefined) : writeMeta(k, { formats: { ...f, assoc: ASSOC_FORMAT } });
  return stamp.andThen(() => k.stores.tracks.writeAssoc(assoc)).map(() => k.tracks.setAssoc(assoc));
};

/** Reads association, unless it was made by another rule. What is gone with its clip's detections goes from it. */
const loadAssoc = (k: Kit): ResultAsync<void, SessionError> => {
  if (k.state.formats().assoc !== ASSOC_FORMAT) return okAsync(undefined);
  return k.stores.tracks.readAssoc().map((a) => k.tracks.setAssoc(liveAssoc(k, a)));
};

const liveAssoc = (k: Kit, a: AssocData): AssocData => ({
  links: Object.fromEntries(Object.entries(a.links).filter(([id]) => k.modules.detections.has(id))),
  weak: a.weak.filter((w) => k.modules.detections.has(w.det)),
});

/**
 * Reads the index. Files of another format, or an index that doesn't parse, count as no tracks. A track whose seed
 * detection is gone goes too: its clip was removed while tracking was off, and the removal took its files.
 */
export const loadTracks = (k: Kit): ResultAsync<void, SessionError> => {
  if (!k.modules.tracking) return okAsync(undefined);
  const stamp = k.state.formats().tracks;
  if (stamp !== undefined && stamp !== TRACK_FORMAT) return okAsync(undefined);
  return loadAssoc(k).andThen(() =>
    k.stores.tracks.readIndex().andThen((index) => {
      if (index === null) k.host.logger.log("ignoring tracks.json: it doesn't parse");
      const i = index ?? EMPTY_TRACK_INDEX;
      const tracks = i.tracks.filter((t) => k.modules.detections.get(t.det).isOk());
      k.tracks.set({ ...i, tracks });
      return tracks.length === i.tracks.length ? okAsync(undefined) : saveTracks(k, { ...i, tracks });
    }),
  );
};

/** Drops a removed clip's tracks from the index, if it had any, and whatever is held of them. */
export const dropClipTracks = (k: Kit, clip: ClipKey): ResultAsync<void, SessionError> => {
  k.tracks.letGo();
  const index = k.tracks.index();
  const tracks = index.tracks.filter((t) => t.clip !== clip);
  const pending = index.pending.filter((p) => p.clip !== clip);
  const unchanged = tracks.length === index.tracks.length && pending.length === index.pending.length;
  if (unchanged) return okAsync(undefined);
  const gone = new Set(index.tracks.filter((t) => t.clip === clip).map((t) => t.id));
  const pairs = index.pairs.filter((p) => !gone.has(p.a) && !gone.has(p.b));
  const assoc = liveAssoc(k, k.tracks.assoc());
  return saveAssoc(k, assoc).andThen(() => saveTracks(k, { ...index, tracks, pending, pairs }));
};

const withTrack = (index: TrackIndex, t: TrackRecord): TrackIndex => ({
  ...index,
  tracks: index.tracks.map((o) => (o.id === t.id ? t : o)),
});

const memoryKey = (t: TrackRecord, d: TrackDirection) => `${t.id}/${d}`;

/** Failures that retrying the same unit can't fix. The track stops and keeps what it has. */
const hopeless = (e: SessionError): boolean =>
  [
    "no-keyframe",
    "missing-frame-file",
    "missing-track-frame",
    "track-seed-empty",
    "track-frame-order",
    "track-memory-missing",
    "no-detection",
  ].includes(e.kind);

/** The frame, held or made from its stored trunk, or null once this unit has encoded it. */
const frameFor = (k: Kit, u: TrackUnit): ResultAsync<TrackFrame | null, SessionError> => {
  const { perception, tracking, video } = k.modules;
  invariant(tracking !== null, "tracking is off");
  const clip = u.track.clip;
  const held = k.tracks.heldFrame(clip, u.at);
  if (held) return okAsync(held);
  const ref = { clipKey: clip, index: u.at };
  return perception.trunk(ref).andThen((stored): ResultAsync<TrackFrame | null, SessionError> => {
    if (stored)
      return tracking.frame(stored).map((frame) => {
        k.tracks.hold(clip, u.at, frame);
        return frame;
      });
    return video
      .trackImage(clip, u.at)
      .andThen((img) => perception.encodeTrunk(ref, img))
      .andThen((trunk) => stampTrunks(k).map(() => trunk))
      .andThen((trunk) => tracking.frame(trunk))
      .map((frame) => {
        k.tracks.hold(clip, u.at, frame);
        return null;
      });
  });
};

const stampTrunks = (k: Kit): ResultAsync<void, SessionError> => {
  const f = k.state.formats();
  const want = k.modules.perception.formats.trunks;
  return f.trunks === want ? okAsync(undefined) : writeMeta(k, { formats: { ...f, trunks: want } });
};

/** The tracks whose mask on this frame shows what this one does. */
const agreeing = (
  k: Kit,
  t: TrackRecord,
  at: number,
  mask: Uint8Array,
): ResultAsync<readonly string[], SessionError> => {
  const others = k.tracks
    .index()
    .tracks.filter((o) => o.id !== t.id && o.clip === t.clip && o.seeded && o.reverse <= at && at <= o.forward);
  return parallel(others, (o) =>
    k.stores.tracks
      .readMask({ clip: o.clip, track: o.id }, at)
      .map((m) => (m && m.score > 0 && planeIou(mask, m.mask) >= CONVERGED_IOU ? [o.id] : [])),
  ).map((rows) => rows.flat());
};

/** The index with one more frame counted for each of these pairs. */
const counted = (index: TrackIndex, t: TrackRecord, at: number, ids: readonly string[]): TrackIndex => {
  const order = index.tracks.map((o) => o.id);
  const pairs = ids.reduce<readonly TrackPair[]>((acc, id) => {
    const [a, b] = order.indexOf(t.id) < order.indexOf(id) ? [t.id, id] : [id, t.id];
    const old = acc.find((p) => p.a === a && p.b === b);
    if (!old) return [...acc, { a, b, frames: 1, first: at, last: at }];
    const next = { ...old, frames: old.frames + 1, first: Math.min(old.first, at), last: Math.max(old.last, at) };
    return acc.map((p) => (p === old ? next : p));
  }, index.pairs);
  return { ...index, pairs };
};

const seedUnit = (k: Kit, u: TrackUnit, frame: TrackFrame): ResultAsync<void, SessionError> => {
  const { detections, tracking, video } = k.modules;
  invariant(tracking !== null, "tracking is off");
  const t = u.track;
  const place = { clip: t.clip, track: t.id };
  return detections
    .get(t.det)
    .asyncAndThen((d) =>
      video.shape(d.frame).asyncAndThen(([h, w]) => {
        const mask = seedPlane(d.mask, d.box, w, h);
        return tracking
          .seed(frame, mask, t.seedAt, t.clipFrames)
          .andThen((seed) =>
            k.stores.tracks
              .writeSeed(place, seed)
              .andThen(() => k.stores.tracks.writeMask(place, t.seedAt, { mask, score: 10, iou: 1 })),
          )
          .andThen(() => agreeing(k, t, t.seedAt, mask));
      }),
    )
    .andThen((with_) =>
      saveTracks(k, counted(withTrack(k.tracks.index(), { ...t, seeded: true }), t, t.seedAt, with_)),
    );
};

/** A leg's memory, from RAM or the store. */
const memoryOf = (k: Kit, t: TrackRecord, d: TrackDirection): ResultAsync<TrackMemory, SessionError> => {
  const kept = k.tracks.memory(memoryKey(t, d));
  if (kept) return okAsync(kept);
  const place = { clip: t.clip, track: t.id };
  const last = d === "forward" ? t.forward : t.reverse;
  const missing = { kind: "track-memory-missing", track: t.id } as const;
  return k.stores.tracks.readSeed(place).andThen((seed): ResultAsync<TrackMemory, SessionError> => {
    if (!seed) return errAsync(missing);
    const start = startTrack({ ...seed, at: t.seedAt, clipFrames: t.clipFrames }, d);
    if (last === t.seedAt) return okAsync(start);
    return k.stores.tracks
      .readMemory(place, d, last)
      .andThen((recent): ResultAsync<TrackMemory, SessionError> =>
        recent ? okAsync({ ...start, recent }) : errAsync(missing),
      );
  });
};

/** A track after a leg reached `at` with this score. */
const moved = (t: TrackRecord, d: TrackDirection, at: number, score: number): TrackRecord => {
  const seen = score > 0;
  const from = d === "forward" ? t.forward : t.reverse;
  return {
    ...t,
    [d]: at,
    [d === "forward" ? "forwardMisses" : "reverseMisses"]: seen
      ? 0
      : (d === "forward" ? t.forwardMisses : t.reverseMisses) + 1,
    skipped: t.skipped + Math.abs(at - from) - 1,
    seenFirst: seen ? Math.min(t.seenFirst, at) : t.seenFirst,
    seenLast: seen ? Math.max(t.seenLast, at) : t.seenLast,
    seenCount: t.seenCount + (seen ? 1 : 0),
  };
};

const moveUnit = (k: Kit, u: TrackUnit, d: TrackDirection, frame: TrackFrame): ResultAsync<void, SessionError> => {
  const { tracking } = k.modules;
  invariant(tracking !== null, "tracking is off");
  const t = u.track;
  const place = { clip: t.clip, track: t.id };
  const old = d === "forward" ? t.forward : t.reverse;
  return memoryOf(k, t, d)
    .andThen((m) => tracking.propagate(frame, m, u.at))
    .andThen((step) => {
      const mask = binaryPlane(step.logits);
      return k.stores.tracks
        .writeMask(place, u.at, { mask, score: step.score, iou: step.iou })
        .andThen(() => k.stores.tracks.writeMemory(place, d, u.at, step.memory.recent))
        .andThen(() => (step.score > 0 ? agreeing(k, t, u.at, mask) : okAsync([])))
        .andThen((ids) =>
          saveTracks(k, counted(withTrack(k.tracks.index(), moved(t, d, u.at, step.score)), t, u.at, ids)),
        )
        .andThen(() => (old === t.seedAt ? okAsync(undefined) : k.stores.tracks.removeMemory(place, d, old)))
        .map(() => k.tracks.keepMemory(memoryKey(t, d), step.memory));
    });
};

/** A new track of auto tracking on the frame `p`. */
const autoTrack = (k: Kit, p: PendingFrame, id: string, det: DetId): TrackRecord => ({
  id,
  det,
  clip: p.clip,
  seedAt: p.at,
  clipFrames: k.modules.video.trackGrid(p.clip).length,
  ...k.modules.video.trackShot(p.clip, p.at),
  priority: AUTO_PRIORITY,
  state: "active",
  failure: null,
  seeded: false,
  forward: p.at,
  reverse: p.at,
  parkAfter: p.parkAfter,
  recheck: p.recheck,
  forwardMisses: 0,
  reverseMisses: 0,
  skipped: 0,
  seenFirst: p.at,
  seenLast: p.at,
  seenCount: 1,
  auto: true,
});

/** Whether a detection still needs association. A link to a track that was never saved is from a unit that crashed. */
export const unassociated = (k: Kit, id: DetId): boolean => {
  const index = k.tracks.index();
  if (index.tracks.some((t) => t.det === id)) return false;
  const link = k.tracks.assoc().links[id];
  if (!link || link.how === "over") return true;
  return link.track !== null && !index.tracks.some((t) => t.id === link.track);
};

/** Compares one keyframe's unassociated detections with the masks there and queues tracks for those no track holds. */
const associateUnit = (k: Kit, p: PendingFrame): ResultAsync<void, SessionError> => {
  const { detections, labelling, video } = k.modules;
  const index = k.tracks.index();
  const rest = { ...index, pending: index.pending.filter((q) => q !== p) };
  const rejected = new Set(labelling.rejected());
  const dets = detections.byFrame(p.frame).filter((d) => {
    return d.score >= p.threshold && !rejected.has(d.id) && unassociated(k, d.id);
  });
  if (!dets.length) return saveTracks(k, rest);
  const covering = index.tracks.filter((t) => t.clip === p.clip && t.seeded && t.reverse <= p.at && p.at <= t.forward);
  return video.shape(p.frame).asyncAndThen(([h, w]) =>
    parallel(covering, (t) =>
      k.stores.tracks
        .readMask({ clip: t.clip, track: t.id }, p.at)
        .map((m) => (m && m.score > 0 ? [{ id: t.id, score: m.score, mask: m.mask }] : [])),
    ).andThen((rows) => {
      const planes: readonly AssocDet<DetId>[] = dets.map((d) => ({
        id: d.id,
        score: d.score,
        plane: seedPlane(d.mask, d.box, w, h),
      }));
      const r = associate(planes, rows.flat());
      const room = Math.max(0, p.maxTracks - index.tracks.filter((t) => t.auto && t.clip === p.clip).length);
      const seeds = r.seeds.slice(0, room);
      const fresh = seeds.map((id, n) => autoTrack(k, p, `t${index.next + n}`, id));
      const trackOf = new Map<DetId, string | null>([
        ...fresh.map((t) => [t.det, t.id] as const),
        ...r.matches.map((m) => [m.det, m.track] as const),
      ]);
      type Row = readonly [DetId, AssocLink];
      const decided: readonly Row[] = [
        ...fresh.map((t): Row => [t.det, { how: "seed", track: t.id }]),
        ...r.seeds.slice(room).map((id): Row => [id, { how: "over", track: null }]),
        ...r.matches.map((m): Row => [m.det, { how: "match", track: m.track }]),
        ...r.small.map((id): Row => [id, { how: "small", track: null }]),
        ...r.dups.map((x): Row => [x.det, { how: "dup", track: trackOf.get(x.of) ?? null, of: x.of }]),
      ];
      const links: Readonly<Record<string, AssocLink>> = Object.fromEntries(decided);
      const old = k.tracks.assoc();
      const assoc: AssocData = {
        links: { ...old.links, ...links },
        weak: [...old.weak, ...r.weak],
      };
      return saveAssoc(k, assoc).andThen(() =>
        saveTracks(k, { ...rest, next: index.next + fresh.length, tracks: [...index.tracks, ...fresh] }),
      );
    }),
  );
};

/** Whether any tracking unit is waiting to run. */
export const trackingWaits = (k: Kit): boolean => {
  const index = k.tracks.index();
  return k.modules.tracking !== null && !index.paused && (index.pending.length > 0 || nextUnit(index, null) !== null);
};

/** One tracking unit. False when there is nothing to do, which frees what work held. */
export const trackUnit = (k: Kit): ResultAsync<boolean, SessionError> => {
  if (!k.modules.tracking) return okAsync(false);
  const index = k.tracks.index();
  const p = index.paused ? null : nextAssociation(index);
  if (p) return associateUnit(k, p).map(() => true);
  const u = index.paused ? null : nextUnit(index, k.tracks.heldPlace());
  if (!u) {
    k.tracks.letGo();
    return k.modules.perception.releaseVision().map(() => false);
  }
  return frameFor(k, u)
    .andThen((frame) => {
      if (!frame) return okAsync(undefined);
      return u.kind === "seed" ? seedUnit(k, u, frame) : moveUnit(k, u, u.kind, frame);
    })
    .map(() => true)
    .orElse((e): ResultAsync<boolean, SessionError> => {
      if (!hopeless(e)) return errAsync(e);
      k.host.logger.log(`track ${u.track.id} failed: ${e.kind}`);
      const failed: TrackRecord = { ...u.track, state: "failed", failure: e.kind };
      return saveTracks(k, withTrack(k.tracks.index(), failed)).map(() => true);
    });
};
