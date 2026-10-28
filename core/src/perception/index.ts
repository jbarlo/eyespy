/**
 * The perception module runs the models. It encodes keyframes into SAM 3 vision features, cached in RAM and in the
 * session folder. It detects a prompt in features and embeds crops with DINOv2. It hides ONNX graph names, tensor
 * layouts, the tokenizer, and the code that matches HF pre- and post-processing.
 */
export type { FeatureStore, FrameImages } from "./ports.ts";
export type { Appearance, Detected, Features, Instance } from "./pure.ts";
export type { CacheStats, Perception, PerceptionError, PerceptionOptions, Provenance } from "./types.ts";
export { createPerception } from "./internal/perception.ts";
