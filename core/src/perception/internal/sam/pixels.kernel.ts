/** SAM 3 pre- and post-processing loops that match the HF processors exactly. */
import { at, invariant } from "../../../invariant/index.ts";
import { f16ToF32, f32ToF16, type Gray, type RGB } from "../../../pixels/index.ts";
import { FEATURE_PLANES, FEATURE_TOTAL, MASK_SIZE } from "../../pure.ts";
import { resizeAA } from "../resample.kernel.ts";

export const SAM_SIZE = 1008;

const fr = Math.fround;

/**
 * As Sam3ImageProcessor, a bilinear antialiased resize to SAM_SIZE² on uint8, then (x/255 - 0.5)/0.5 as float32
 * CHW.
 */
export function samPixels(img: RGB): Float32Array {
  const r = resizeAA(img, SAM_SIZE, SAM_SIZE, "bilinear");
  const P = SAM_SIZE * SAM_SIZE;
  const out = new Float32Array(3 * P);
  const mean = fr(fr(0.5) * (1 / 0.00392156862745098));
  for (let i = 0; i < P; i++) for (let c = 0; c < 3; c++) out[c * P + i] = fr(fr(r.data[i * 3 + c]! - mean) / mean);
  return out;
}

/** Rounds the three float32 encoder planes (FEATURE_PLANES order and lengths) to fp16 and concatenates them. */
export function concatF16(planes: readonly Float32Array[]): Uint16Array {
  const out = new Uint16Array(FEATURE_TOTAL);
  let off = 0;
  FEATURE_PLANES.forEach(({ len }, k) => {
    f32ToF16(at(planes, k).subarray(0, len), out.subarray(off, off + len));
    off += len;
  });
  return out;
}

/** Splits the fp16 concat into `out`, three float32 planes of FEATURE_PLANES lengths, for the detector feeds. */
export function splitF32(features: Uint16Array, out: readonly Float32Array[]): readonly Float32Array[] {
  let off = 0;
  FEATURE_PLANES.forEach(({ name, len }, k) => {
    const p = at(out, k);
    invariant(p.length === len, () => `splitF32: ${name} buffer has ${p.length} values, needs ${len}`);
    f16ToF32(features.subarray(off, off + len), p);
    off += len;
  });
  return out;
}

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export type DetectorOutput = {
  /** One logit per query. */
  readonly logits: Float32Array;
  /** Presence logit. */
  readonly presence: number;
  /** Mask logits, one MASK_SIZE² plane per query. */
  readonly masks: Float32Array;
  /** MASK_SIZE² semantic logits, or null when the export has none. */
  readonly semantic: Float32Array | null;
};

export type Kept = { readonly score: number; readonly probs: Float32Array };

/**
 * Sam3ImageProcessor.post_process_instance_segmentation without the upsampling. The score is sigmoid(logit) ·
 * sigmoid(presence) in float32. It keeps score > float32(threshold), and the mask probabilities are the sigmoid of
 * the logits. Results come in query order.
 */
export function keepInstances(out: DetectorOutput, threshold: number): Kept[] {
  const t32 = fr(threshold);
  const p = fr(sigmoid(out.presence));
  const kept: Kept[] = [];
  const M = MASK_SIZE * MASK_SIZE;
  for (let q = 0; q < out.logits.length; q++) {
    const score = fr(fr(sigmoid(out.logits[q]!)) * p);
    if (!(score > t32)) continue;
    const probs = new Float32Array(M);
    const src = out.masks.subarray(q * M, (q + 1) * M);
    for (let i = 0; i < M; i++) probs[i] = sigmoid(src[i]!);
    kept.push({ score, probs });
  }
  return kept;
}

/** The semantic heatmap as stored, MASK_SIZE² values of trunc(float32(sigmoid(logit)) · 255). */
export function heatmapGray(semantic: Float32Array): Gray {
  const g = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (let k = 0; k < g.length; k++) g[k] = Math.trunc(fr(sigmoid(semantic[k]!)) * 255);
  return { w: MASK_SIZE, h: MASK_SIZE, data: g };
}
