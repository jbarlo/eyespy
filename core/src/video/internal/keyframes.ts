/** Keyframe picking over a ClipSource. It samples the clip as a grey stream, then the kernel picks. */
import { ResultAsync } from "neverthrow";
import type { ClipSource, HostFailure, Timing } from "../../ports/index.ts";
import { hostFailure } from "../../ports/index.ts";
import { cutTimes, pickTimes, streamHeight } from "./keyframes.kernel.ts";

const KEYFRAME_FPS = 5;
const KEYFRAME_WIDTH = 360;

/**
 * The grey stream rate for a clip. It is KEYFRAME_FPS, or a folder's own rate if that is lower, so its frames are
 * the samples and nothing is made up between them. A folder at a higher rate is subsampled to KEYFRAME_FPS, so
 * picking sees what it would see for a video.
 */
export const keyframeRate = (timing: Exclude<Timing, { kind: "stills" }>): number =>
  timing.kind === "rate" ? Math.min(timing.fps, KEYFRAME_FPS) : KEYFRAME_FPS;

/** How far apart the two frames of a cut are on the grey stream, in seconds. */
export const CUT_STEP = 1 / KEYFRAME_FPS;

/**
 * Keyframe times of `ref`, a w×h clip as opened, on its grey stream at `fps`, and how long the stream lasted. With
 * `withCuts` it also finds the cuts on that stream, which it can only do at KEYFRAME_FPS. A slower stream gives none.
 */
export const pickKeyframesTimed = (
  reads: Pick<ClipSource, "grayStream">,
  ref: string,
  size: { readonly w: number; readonly h: number },
  thresh: number,
  fps = KEYFRAME_FPS,
  width = KEYFRAME_WIDTH,
  withCuts = false,
): ResultAsync<
  { readonly times: readonly number[]; readonly duration: number; readonly cuts: readonly number[] },
  HostFailure
> => {
  const sh = streamHeight(size.w, size.h, width);
  return ResultAsync.fromPromise(reads.grayStream(ref, fps, width, sh), (e) =>
    hostFailure("video", "grayStream", e),
  ).map((raw) => ({
    times: pickTimes(raw, width, sh, thresh, fps),
    duration: raw.length / (width * sh) / fps,
    cuts: withCuts && fps === KEYFRAME_FPS ? cutTimes(raw, width, sh, fps) : [],
  }));
};

/**
 * The keyframe times alone.
 * @internal
 */
export const pickKeyframes = (
  reads: Pick<ClipSource, "grayStream">,
  ref: string,
  size: { readonly w: number; readonly h: number },
  thresh: number,
  fps = KEYFRAME_FPS,
  width = KEYFRAME_WIDTH,
): ResultAsync<readonly number[], HostFailure> =>
  pickKeyframesTimed(reads, ref, size, thresh, fps, width).map((r) => r.times);
