/** Keyframe picking over a ClipSource. It samples the clip as a grey stream, then the kernel picks. */
import { ResultAsync } from "neverthrow";
import type { ClipSource, HostFailure, Timing } from "../../ports/index.ts";
import { hostFailure } from "../../ports/index.ts";
import { pickTimes, streamHeight } from "./keyframes.kernel.ts";

const KEYFRAME_FPS = 5;
const KEYFRAME_WIDTH = 360;

/**
 * The grey stream rate for a clip. It is KEYFRAME_FPS, or a folder's own rate if that is lower, so its frames are
 * the samples and nothing is made up between them. A folder at a higher rate is subsampled to KEYFRAME_FPS, so
 * picking sees what it would see for a video.
 */
export const keyframeRate = (timing: Exclude<Timing, { kind: "stills" }>): number =>
  timing.kind === "rate" ? Math.min(timing.fps, KEYFRAME_FPS) : KEYFRAME_FPS;

/** Keyframe times of `ref`, a w×h clip as opened, on its grey stream at `fps`. */
export const pickKeyframes = (
  reads: Pick<ClipSource, "grayStream">,
  ref: string,
  size: { readonly w: number; readonly h: number },
  thresh: number,
  fps = KEYFRAME_FPS,
  width = KEYFRAME_WIDTH,
): ResultAsync<readonly number[], HostFailure> => {
  const sh = streamHeight(size.w, size.h, width);
  return ResultAsync.fromPromise(reads.grayStream(ref, fps, width, sh), (e) =>
    hostFailure("video", "grayStream", e),
  ).map((raw) => pickTimes(raw, width, sh, thresh, fps));
};
