/** Builds `Features` by checking for FEATURE_TOTAL fp16 values, and gives their raw bytes to the FeatureStore. */
import { FEATURE_BYTES, FEATURE_TOTAL, type Features } from "../pure.ts";

export const isFeatures = (a: Uint16Array): a is Features => a.length === FEATURE_TOTAL;

/**
 * A stored file's bytes as Features, or null if the size is wrong. It is a view over the bytes, which the
 * FeatureStore lets the caller keep. It copies only for an odd offset, since a Uint16Array must be 2-byte aligned.
 */
export function featuresFromBytes(bytes: Uint8Array): Features | null {
  if (bytes.byteLength !== FEATURE_BYTES) return null;
  const aligned = bytes.byteOffset % 2 === 0 ? bytes : bytes.slice();
  const f = new Uint16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
  return isFeatures(f) ? f : null;
}

/** The bytes the FeatureStore writes, as a view without a copy. */
export const featureBytes = (f: Features): Uint8Array => new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
