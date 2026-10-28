import type { Result, ResultAsync } from "neverthrow";
import type { RGB, Shape } from "../pixels/index.ts";
import type { VideoPorts } from "./ports.ts";
import type {
  Clip,
  ClipKey,
  FrameAccessError,
  FrameNo,
  FrameRef,
  FrameSlot,
  FrameSpecError,
  NoKeyframe,
} from "./pure.ts";

export type VideoOptions = {
  /** The session's clips from the session folder, in index order, tombstones included. */
  readonly clips: readonly Clip[];
  /** Decoded frames kept in RAM. */
  readonly imageCacheSize?: number;
};

export type VideoError =
  | FrameAccessError
  | FrameSpecError
  | { readonly kind: "no-such-file"; readonly path: string }
  | { readonly kind: "clip-already-present"; readonly path: string }
  | { readonly kind: "no-clip"; readonly ref: string }
  | { readonly kind: "ambiguous-clip"; readonly ref: string; readonly keys: readonly ClipKey[] }
  | { readonly kind: "clip-already-removed"; readonly path: string }
  | { readonly kind: "clip-no-keyframes"; readonly path: string };

export type AddedClip = {
  readonly clip: Clip;
  /** The clip's first global keyframe index. */
  readonly first: FrameNo;
  /** True if a tombstone of the same content came back, with the same indices and times and no detections. */
  readonly revived: boolean;
};

export type RemovedClip = { readonly clip: Clip; readonly frames: readonly [FrameNo, FrameNo] };

/**
 * The instance holds state. addClip and removeClip change what later calls see, but everything returned is
 * immutable. The session persists the clip list after the call returns.
 */
export interface Video {
  /** Every clip in index order, tombstones included. */
  clips(): readonly Clip[];
  liveClips(): readonly Clip[];
  /** Finds a clip by key, path or file name, removed ones included. */
  findClip(ref: string): Result<Clip, VideoError>;
  /** Global keyframe indices of a clip, reserved ones included. */
  clipFrames(key: ClipKey): readonly FrameNo[];
  /** Every clip's reserved detection counters, the highest per frame. */
  reserved(): ReadonlyMap<FrameNo, number>;
  /** An existing keyframe of a clip that hasn't been removed. */
  live(i: number): i is FrameNo;
  /** Live keyframes of a spec, or all by default. */
  frames(spec?: string | number | null): Result<readonly FrameNo[], VideoError>;
  liveFrames(): readonly FrameNo[];
  /** Any keyframe, including those of removed clips. */
  slot(i: FrameNo): Result<FrameSlot, NoKeyframe>;
  ref(i: FrameNo): Result<FrameRef, NoKeyframe>;
  t(i: FrameNo): Result<number, NoKeyframe>;
  shape(i: FrameNo): Result<Shape, NoKeyframe>;
  tag(i: FrameNo): Result<string, NoKeyframe>;
  /** A decoded keyframe, from a small RAM cache. */
  image(i: FrameNo): ResultAsync<RGB, FrameAccessError>;
  forget(frames: readonly FrameNo[]): void;
  /**
   * Adds a clip at the end of the index and picks and stores its keyframes. `fps` is a folder of frames' rate,
   * omitted for photos or a video. A tombstone with the same content key is revived instead, and its missing frames
   * are extracted again. A failure changes nothing, though frames already written stay.
   */
  addClip(
    ref: string,
    opts: { readonly keyframeThresh: number; readonly fps?: number | null },
  ): ResultAsync<AddedClip, VideoError>;
  /**
   * Tombstones a clip. Every query then skips it, but it keeps its indices. `reserved` merges into `clip.reserved`,
   * taking the max per frame, for the clip's frames only. The session deletes its files, detections and labels.
   */
  removeClip(key: ClipKey, reserved: ReadonlyMap<FrameNo, number>): Result<RemovedClip, VideoError>;
}

export type CreateVideo = (ports: VideoPorts, opts: VideoOptions) => Video;
