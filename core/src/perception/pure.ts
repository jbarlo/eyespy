/** What the models produce, as values other modules may hold. */
import type { Gray, MeasuredMask } from "../pixels/index.ts";
import type { ChainStep } from "../ports/index.ts";

/** The tensor each vision part ends in: every ViT block's residual output, then the trunk. */
const VISION_PART_OUTPUTS = [
  ...Array.from({ length: 31 }, (_, k) => `add_${4 * (k + 1)}`),
  "permute_58",
] as const satisfies readonly string[];

/** Model files under the model directory. */
export const MODEL_FILES = {
  vision: "vision_fp16.onnx",
  text: "text_fp16.onnx",
  detector: { fp32: "detector_fp32_nosign.onnx", fp16: "detector_fp16_nosign.onnx" },
  tokenizer: "tokenizer.json",
  appearance: "dinov2-small/model_cls.onnx",
  /** The vision encoder cut into parts, used with tracking on. Its nodes and weights are `vision`'s. */
  visionParts: {
    parts: VISION_PART_OUTPUTS.map((_, k) => `vision/part_${String(k).padStart(2, "0")}.onnx`),
    neck: "vision/neck.onnx",
    /** The neck's input, the last part's output. */
    trunk: "permute_58",
  },
  tracker: {
    tables: "tracker/tables.onnx",
    graphs: {
      fp32: {
        neck: "tracker/neck_fp32.onnx",
        maskEmbed: "tracker/mask_embed_fp32.onnx",
        decoder: "tracker/decoder_fp32.onnx",
        memenc: "tracker/memenc_fp32.onnx",
        attention: [
          "tracker/attn_l0_fp32.onnx",
          "tracker/attn_l1_fp32.onnx",
          "tracker/attn_l2_fp32.onnx",
          "tracker/attn_l3_fp32.onnx",
        ],
      },
      fp16: {
        neck: "tracker/neck_fp16.onnx",
        maskEmbed: "tracker/mask_embed_fp16.onnx",
        decoder: "tracker/decoder_fp16.onnx",
        memenc: "tracker/memenc_fp16.onnx",
        attention: [
          "tracker/attn_l0_fp16.onnx",
          "tracker/attn_l1_fp16.onnx",
          "tracker/attn_l2_fp16.onnx",
          "tracker/attn_l3_fp16.onnx",
        ],
      },
    },
  },
} as const;
export type DetectorPrecision = keyof typeof MODEL_FILES.detector;

/** The vision parts as a chain, which starts from the pixels. */
export const VISION_PART_STEPS: readonly ChainStep[] = MODEL_FILES.visionParts.parts.map((file, k) => ({
  file,
  input: VISION_PART_OUTPUTS[k - 1] ?? "pixel_values",
  output: VISION_PART_OUTPUTS[k] ?? MODEL_FILES.visionParts.trunk,
}));

/** The stored feature format, stamped in session.json `features`. */
export const FEATURE_FORMAT = "onnx-cardanvil-vision-fp16/f16-concat-v1";

/** The stored trunk format, stamped in session.json `trunks`. */
export const TRUNK_FORMAT = "onnx-cardanvil-vision-parts/f16-trunk-v1";
/** fp16 values of one trunk, [1024, 72, 72], the last vision part's output. */
export const TRUNK_LEN = 1024 * 72 * 72;
/** Bytes per stored trunk file. */
export const TRUNK_BYTES = TRUNK_LEN * 2;
/** The disk budget for stored trunks in MB when the host sets none, about 390 frames. */
export const DEFAULT_TRUNK_DISK_MB = 4096;
/** One frame's trunk as fp16 bits. */
export type Trunk = Uint16Array;

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
