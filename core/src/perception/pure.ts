/** What the models produce, as values other modules may hold. */
import type { Gray, MeasuredMask } from "../pixels/index.ts";

/** Model files under the model directory. */
export const MODEL_FILES = {
  vision: "vision_fp16.onnx",
  text: "text_fp16.onnx",
  detector: { fp32: "detector_fp32_nosign.onnx", fp16: "detector_fp16_nosign.onnx" },
  tokenizer: "tokenizer.json",
  appearance: "dinov2-small/model_cls.onnx",
} as const;
export type DetectorPrecision = keyof typeof MODEL_FILES.detector;

/** The stored feature format, stamped in session.json `features`. */
export const FEATURE_FORMAT = "onnx-cardanvil-vision-fp16/f16-concat-v1";

/** Side of the detector's mask and heatmap planes. */
export const MASK_SIZE = 288;
/** The vision encoder's three outputs, in the order the fp16 feature cache and the detector feeds use. */
export const FEATURE_PLANES = [
  { name: "features_288", dims: [1, 256, 288, 288], len: 256 * 288 * 288 },
  { name: "features_144", dims: [1, 256, 144, 144], len: 256 * 144 * 144 },
  { name: "features_72", dims: [1, 256, 72, 72], len: 256 * 72 * 72 },
] as const;
/** fp16 values per frame in the feature cache, the sum of the FEATURE_PLANES lengths. */
export const FEATURE_TOTAL = FEATURE_PLANES.reduce((s, p) => s + p.len, 0);
/** Bytes per stored feature file. */
export const FEATURE_BYTES = FEATURE_TOTAL * 2;
/** The feature cache's size in MB when the host sets none. */
export const DEFAULT_CACHE_MB = 4096;

/**
 * One keyframe's vision features, the three encoder outputs as concatenated fp16 (FEATURE_TOTAL values). Code
 * outside perception treats it as opaque. Storage moves its bytes without looking, since FeatureStore takes
 * Uint8Array.
 */
export type Features = Uint16Array & { readonly brand: "perception.Features" };

/** One detector hit, in frame coordinates (a region crop's hits are shifted by its offset). */
export type Instance = MeasuredMask & { readonly score: number };
export type Detected = {
  /** Sorted by score, after NMS. */
  readonly instances: readonly Instance[];
  /** sigmoid(presence logit), which says how sure the model is that the concept is in the image at all. */
  readonly presence: number;
  /** The semantic heatmap, MASK_SIZE² values of sigmoid·255, or null if the export has none. */
  readonly heatmap: Gray | null;
};

export type { Appearance } from "./internal/vector.kernel.ts";
export { APPEARANCE_DIM, dot as similarity, isAppearance, mean, normalize, sum } from "./internal/vector.kernel.ts";
