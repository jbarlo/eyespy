/** A tracked object's state as a plain value, what is saved of it, and the sizes of what goes in and out. */
import type { DetId } from "../detections/pure.ts";
import type { ClipKey, FrameNo } from "../video/pure.ts";

export { COVER_SCORE, associate, convergedGroups, planeIou, type AssocDet } from "./internal/associate.kernel.ts";

/** Values of one frame's memory tokens, 5184 tokens of 64 values. They fit bfloat16 exactly, as upstream rounds them. */
export const MEMORY_LEN = 72 * 72 * 64;
/** Values of one object pointer. */
export const POINTER_LEN = 256;
/** Recent frames whose memory tokens the bank keeps, next to the seed's. */
export const RECENT_BLOCKS = 2;
/** The most pointers one frame reads, the seed's and those of recent frames. */
export const MAX_POINTERS = 16;

/** Which way a track moves through the clip. A track only moves one way. */
export type TrackDirection = "forward" | "reverse";

/** The object as a seed mask gave it. Forward and reverse tracks can start from one seed. */
export type TrackSeed = {
  /** The seed's frame on the tracking grid. */
  readonly at: number;
  /** How many frames the tracking grid has in the clip. It scales the pointers' temporal positions, as upstream. */
  readonly clipFrames: number;
  /** MEMORY_LEN values, token by token. */
  readonly tokens: Float32Array;
  /** POINTER_LEN values. */
  readonly pointer: Float32Array;
};

/** What one tracked frame left behind. Tokens are dropped once the frame is too old to give a memory block. */
export type TrackedFrame = {
  readonly at: number;
  readonly tokens: Float32Array | null;
  readonly pointer: Float32Array;
};

/**
 * All a track needs between frames: plain numbers and typed arrays. Frame features are not part of it. It holds at
 * most 3 × MEMORY_LEN + 16 × POINTER_LEN floats. Each call that advances it returns a new value and leaves this one
 * alone, so a caller may keep the old one until the new one is saved.
 */
export type TrackMemory = {
  readonly direction: TrackDirection;
  readonly seed: TrackSeed;
  /** Tracked frames, oldest first. */
  readonly recent: readonly TrackedFrame[];
};

/** Starts a track from a seed. */
export const startTrack = (seed: TrackSeed, direction: TrackDirection): TrackMemory => ({
  direction,
  seed,
  recent: [],
});

/** The saved track format, stamped in session.json `tracks`. */
export const TRACK_FORMAT = "tracker-v1/bf16-memory-v1";

/** One object on one frame as it is saved. */
export type TrackMask = {
  /** MASK_SIZE² values, 0 or 1. */
  readonly mask: Uint8Array;
  /** The object score logit. Positive means the object is on the frame. */
  readonly score: number;
  readonly iou: number;
};

/**
 * One object's track as it is saved: its two legs, outward from the seed. Each leg has a frame it last covered, and
 * the seed's until it moved. Finished work stays whatever the state.
 */
export type TrackRecord = {
  /** "t<n>". Never reused in a session. */
  readonly id: string;
  /** The detection that seeded it. */
  readonly det: DetId;
  readonly clip: ClipKey;
  /** The seed's place on the clip's tracking grid. */
  readonly seedAt: number;
  readonly clipFrames: number;
  /** The grid stretch of the seed's shot, both ends included. A leg ends at a cut, so it never goes past these. */
  readonly first: number;
  readonly last: number;
  /** Higher runs first. Equal ones take turns frame by frame. */
  readonly priority: number;
  /** Cancelled and failed tracks are out of the queue. */
  readonly state: "active" | "cancelled" | "failed";
  readonly failure: string | null;
  readonly seeded: boolean;
  /** The last frame covered going forward. */
  readonly forward: number;
  /** The last frame covered going back. */
  readonly reverse: number;
  /** Misses in a row (score <= 0) after which a leg parks. */
  readonly parkAfter: number;
  /** How many frames on a parked leg's next re-check lies. 1 means it never skips. */
  readonly recheck: number;
  /** Each leg's misses in a row, up to its last frame. */
  readonly forwardMisses: number;
  readonly reverseMisses: number;
  /** Frames the legs jumped over while parked. They have no mask file and count as covered. */
  readonly skipped: number;
  /** Where the object was on a frame: the first and last such place, and how many. The seed's frame counts. */
  readonly seenFirst: number;
  readonly seenLast: number;
  readonly seenCount: number;
  /** Queued by auto tracking. Only these count against auto_tracks. */
  readonly auto: boolean;
};

/** Two tracks whose masks were on one object. A suggestion to merge them, never a merge. */
export type TrackPair = {
  /** The two ids, in index order. */
  readonly a: string;
  readonly b: string;
  /** The grid frames both looked at where their masks agreed, and the first and last of them. */
  readonly frames: number;
  readonly first: number;
  readonly last: number;
};

/** A keyframe whose detections wait for association, until the tracks of its shot have got there. */
export type PendingFrame = {
  readonly clip: ClipKey;
  readonly at: number;
  readonly frame: FrameNo;
  /** As the auto op's context had them. */
  readonly threshold: number;
  readonly maxTracks: number;
  readonly parkAfter: number;
  readonly recheck: number;
};

export type TrackIndex = {
  /** No tracking unit runs while this is set. It is saved, so it holds across a reload. */
  readonly paused: boolean;
  /** The number in the next track's id. */
  readonly next: number;
  readonly tracks: readonly TrackRecord[];
  /** Frames left for association, in time order per clip. */
  readonly pending: readonly PendingFrame[];
  readonly pairs: readonly TrackPair[];
};

export const EMPTY_TRACK_INDEX: TrackIndex = { paused: false, next: 1, tracks: [], pending: [], pairs: [] };

/** The saved association format, stamped in session.json `assoc`. Another stamp means association runs again. */
export const ASSOC_FORMAT = "assoc-v1/score2-iou.5-overlap.7-ratio.5";

/** What association decided for a detection. */
export type AssocLink = {
  /**
   * seed: it started the track. match: the track held it already. dup: it shows the same thing as detection `of`, on
   * the same track. small: too small to track. over: the max-tracks guard left it out, and another auto op may take it.
   */
  readonly how: "seed" | "match" | "dup" | "small" | "over";
  readonly track: string | null;
  readonly of?: DetId;
};

/** Derived data, in assoc.json: what association decided. It says how a track and detections relate, and no one's labels. */
export type AssocData = {
  readonly links: Readonly<Record<string, AssocLink>>;
  /** Pairs the masks agreed on, where the track scored too low to count. It didn't stop the detection seeding. */
  readonly weak: readonly {
    readonly det: DetId;
    readonly track: string;
    readonly iou: number;
    readonly score: number;
  }[];
};

export const EMPTY_ASSOC: AssocData = { links: {}, weak: [] };

/** Masks at least this alike on a frame count as one object. */
export const CONVERGED_IOU = 0.5;
/** Frames two tracks must agree on before their tracks are shown as one group. One frame can be a passing overlap. */
export const CONVERGED_FRAMES = 2;
/** Behind any requested track, which has priority 0 or more. */
export const AUTO_PRIORITY = -1;

/** One piece of work: seed a track, or move one of its legs to frame `at`. */
export type TrackUnit = {
  readonly track: TrackRecord;
  readonly kind: "seed" | TrackDirection;
  readonly at: number;
};

/** Seconds of misses before a leg parks, at any rate. At 2 fps that is one miss. */
const PARK_AFTER_SECONDS = 0.5;

/**
 * The parking rule for a tracking rate, from the seconds between re-checks (track_recheck). 0 turns parking off. Tracks
 * keep the rule they started with.
 */
export const parkRule = (fps: number, seconds: number): Pick<TrackRecord, "parkAfter" | "recheck"> => ({
  parkAfter: Math.max(1, Math.round(PARK_AFTER_SECONDS * fps)),
  recheck: Math.max(1, Math.round(seconds * fps)),
});

/**
 * A leg's next frame from `from`, `sign` being its direction and `end` the last it may reach, or null at the end. A
 * parked leg jumps. A frame in `stops` that it would jump over is where it looks next instead.
 */
const nextOnLeg = (
  t: TrackRecord,
  from: number,
  end: number,
  sign: 1 | -1,
  misses: number,
  stops: readonly number[],
): number | null => {
  if ((end - from) * sign <= 0) return null;
  const step = misses >= t.parkAfter ? t.recheck : 1;
  const far = (end - from) * sign < step ? end : from + sign * step;
  const inWay = stops.filter((s) => (s - from) * sign > 0 && (far - s) * sign > 0);
  return inWay.length ? inWay.reduce((a, b) => ((a - b) * sign < 0 ? a : b)) : far;
};

/** A track's next piece of work, outward from the seed, nearest first, forward on a tie. Null when it has none. */
const unitOf = (t: TrackRecord, stops: readonly number[] = []): TrackUnit | null => {
  if (!t.seeded) return { track: t, kind: "seed", at: t.seedAt };
  const f = nextOnLeg(t, t.forward, t.last, 1, t.forwardMisses, stops);
  const r = nextOnLeg(t, t.reverse, t.first, -1, t.reverseMisses, stops);
  if (f === null && r === null) return null;
  if (r === null || (f !== null && f - t.seedAt <= t.seedAt - r)) return { track: t, kind: "forward", at: f ?? 0 };
  return { track: t, kind: "reverse", at: r };
};

/** The frames a parked leg may not jump over: detections there wait to be compared with what it holds. */
const stopsIn = (index: TrackIndex, clip: ClipKey): readonly number[] =>
  index.pending.filter((p) => p.clip === clip).map((p) => p.at);

/**
 * The association that can run now: the first one waiting in a clip, once each active track of its shot has covered
 * its frame, so all their masks on it can be read.
 */
export const nextAssociation = (index: TrackIndex): PendingFrame | null => {
  const firsts = index.pending.filter((p, k) => index.pending.findIndex((q) => q.clip === p.clip) === k);
  return (
    firsts.find(
      (p) =>
        !index.tracks.some(
          (t) =>
            t.clip === p.clip &&
            t.state === "active" &&
            t.first <= p.at &&
            p.at <= t.last &&
            !(t.seeded && t.reverse <= p.at && p.at <= t.forward),
        ),
    ) ?? null
  );
};

/**
 * What runs next. The highest priority goes first. Among equals, a track that can use the frame already held goes
 * first, so objects pass a frame together and the neck runs once for it. Otherwise the oldest track goes.
 */
export const nextUnit = (
  index: TrackIndex,
  held: { readonly clip: ClipKey; readonly at: number } | null,
): TrackUnit | null => {
  const units = index.tracks
    .filter((t) => t.state === "active")
    .flatMap((t) => {
      const u = unitOf(t, stopsIn(index, t.clip));
      return u ? [u] : [];
    });
  const top = Math.max(...units.map((u) => u.track.priority));
  const best = units.filter((u) => u.track.priority === top);
  return best.find((u) => held && u.track.clip === held.clip && u.at === held.at) ?? best[0] ?? null;
};

/** Frames a track has covered, the seed's included. */
export const trackDone = (t: TrackRecord): number => (t.seeded ? t.forward - t.reverse + 1 : 0);
/** Whether a track has reached both ends of its shot. */
export const trackFinished = (t: TrackRecord): boolean => unitOf(t) === null;
/** Whether a leg with work left is parked. */
export const trackParked = (t: TrackRecord): boolean =>
  (t.forward < t.last && t.forwardMisses >= t.parkAfter && t.recheck > 1) ||
  (t.reverse > t.first && t.reverseMisses >= t.parkAfter && t.recheck > 1);
/** The highest priority in use. */
export const topTrackPriority = (index: TrackIndex): number => Math.max(0, ...index.tracks.map((t) => t.priority));
