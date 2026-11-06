/**
 * The tracking module follows one object through a clip with SAM 3's memory tracker, one frame per call. Its state
 * is a value the caller holds and can save between frames. It hides ONNX graph names, tensor layouts and the way the
 * memory bank becomes attention inputs.
 */
export type { TrackFrame, Tracking, TrackingError, TrackingOptions } from "./types.ts";
export { createTracking } from "./internal/tracking.ts";
