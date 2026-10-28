/**
 * Appearance vectors and their arithmetic. Sums and means accumulate in float32 and dot in float64, and stored
 * vectors and replies depend on that.
 */
import { invariant } from "../../invariant/index.ts";

export const APPEARANCE_DIM = 384;

/** DINOv2 CLS embedding, L2-normalised, APPEARANCE_DIM long. `normalize` makes one and `isAppearance` checks one. */
export type Appearance = Float32Array & { readonly brand: "perception.Appearance" };

export const isAppearance = (v: Float32Array): v is Appearance => v.length === APPEARANCE_DIM;

/** Σ a·b in double. For two L2-normalised vectors this is the cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Like F.normalize(v, dim=0), v / max(||v||, 1e-12) in float32. `v` must be APPEARANCE_DIM long. */
export function normalize(v: Float32Array): Appearance {
  invariant(v.length === APPEARANCE_DIM, () => `normalize: ${v.length} values, want ${APPEARANCE_DIM}`);
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.max(Math.sqrt(s), 1e-12);
  const out = new Float32Array(APPEARANCE_DIM);
  for (let i = 0; i < APPEARANCE_DIM; i++) out[i] = v[i]! / n;
  invariant(isAppearance(out), "normalize: output length");
  return out;
}

/** Element-wise sum accumulated in float32 (`out[k] += v[k]` over a Float32Array). */
export function sum(vs: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(APPEARANCE_DIM);
  for (const v of vs) for (let k = 0; k < APPEARANCE_DIM; k++) out[k]! += v[k]!;
  return out;
}

/** The float32 sum divided by the count, which is an object's centroid before normalising. */
export function mean(vs: readonly Float32Array[]): Float32Array {
  const out = sum(vs);
  for (let k = 0; k < APPEARANCE_DIM; k++) out[k]! /= vs.length;
  return out;
}
