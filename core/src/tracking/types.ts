import type { ResultAsync } from "neverthrow";
import type { DetectorPrecision } from "../perception/pure.ts";
import type { HostFailure } from "../ports/index.ts";
import type { TrackingPorts } from "./ports.ts";
import type { TrackMemory, TrackSeed } from "./pure.ts";

export type TrackingOptions = {
  /** fp16 graphs, or fp32 where the GPU has no shader-f16. */
  readonly precision: DetectorPrecision;
};

export type TrackingError =
  | HostFailure
  /** A named model output is unusable, so the ONNX export is not the one this code expects. */
  | { readonly kind: "model-output-missing"; readonly model: string; readonly output: string }
  /** A seed mask without a single pixel gives nothing to track. */
  | { readonly kind: "track-seed-empty" }
  /** `at` is outside the clip or not past the track's last frame in its direction. */
  | { readonly kind: "track-frame-order"; readonly at: number; readonly last: number; readonly clipFrames: number };

/**
 * One frame's features for tracking. They are big (21 MB) and quick to make, so they don't belong in a saved state.
 * Hold one for as long as objects are being tracked on that frame.
 */
export type TrackFrame = {
  readonly s0: Float32Array;
  readonly s1: Float32Array;
  readonly f72: Float32Array;
};

/** One object on one frame. `memory` is the track's next state. */
export type TrackStep = {
  readonly memory: TrackMemory;
  /** MASK_SIZE² logits, positive inside. -1024 everywhere when the object is not on the frame. */
  readonly logits: Float32Array;
  /** The object score logit. Positive means the object is on the frame. */
  readonly score: number;
  /** The decoder's predicted IoU of the mask. */
  readonly iou: number;
};

/**
 * The tracker's unit of work is one object on one frame. The instance holds loaded models and nothing about objects,
 * so any number of tracks can take turns, and work can stop after any call.
 */
export interface Tracking {
  /**
   * The frame features of a trunk: TRUNK_LEN fp16 bits, the only output of the vision graph's last part
   * (`permute_58`, [1,1024,72,72]). A frame that is only tracked needs no detector neck.
   */
  frame(trunk: Uint16Array): ResultAsync<TrackFrame, TrackingError>;
  /**
   * The seed of an object, from its MASK_SIZE² mask on this frame, where non-zero means inside. The mask counts as the
   * truth, so the seed's memory is encoded from it with an object score of +10.
   */
  seed(frame: TrackFrame, mask: Uint8Array, at: number, clipFrames: number): ResultAsync<TrackSeed, TrackingError>;
  /**
   * Moves a track to frame `at`, which must lie past its last frame in its direction. Normally that is the next frame
   * on the grid. A skipped frame is fine, as it only leaves a gap in the memory. Attention runs one layer at a time.
   */
  propagate(frame: TrackFrame, memory: TrackMemory, at: number): ResultAsync<TrackStep, TrackingError>;
}

export type CreateTracking = (ports: TrackingPorts, opts: TrackingOptions) => Tracking;
