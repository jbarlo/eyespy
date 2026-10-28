/** numpy, torch and OpenCV goldens. Inputs are not stored: both sides derive them from a seed. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readNpz, type NpyArray } from "../../../src/storage/internal/npz.kernel.ts";
import type { RGB } from "../../../src/pixels/index.ts";

export const DIR = path.dirname(fileURLToPath(import.meta.url));

export const bytes = (name: string) => new Uint8Array(readFileSync(path.join(DIR, name)));
export const json = <T>(name: string): T => JSON.parse(readFileSync(path.join(DIR, name), "utf8")) as T;

export function npz(name: string) {
  const arrays = readNpz(bytes(name))._unsafeUnwrap();
  return (key: string): NpyArray => {
    const a = arrays.get(key);
    if (!a) throw new Error(`${name}: no array ${key}`);
    return a;
  };
}

/** The goldens' `noise`: xorshift32 (13, 17, 5) from `seed`, the top byte of each step, row-major interleaved. */
export function noiseBytes(seed: number, n: number): Uint8Array {
  let x = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x >>> 24;
  }
  return out;
}

export const noise = (seed: number, w: number, h: number): RGB => ({ w, h, data: noiseBytes(seed, w * h * 3) });

export const sha256 = (a: ArrayBufferView) =>
  createHash("sha256")
    .update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
    .digest("hex");

/** First index where two arrays differ (or -1), with a count, for readable failures on big arrays. */
export function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>) {
  let first = -1,
    n = 0,
    max = 0;
  if (a.length !== b.length)
    return { first: 0, n: Math.max(a.length, b.length), max: Infinity, lengths: [a.length, b.length] };
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > 0 || Number.isNaN(d)) {
      if (first < 0) first = i;
      n++;
      if (d > max) max = d;
    }
  }
  return { first, n, max };
}

export type Known = { n: number; maxDiff: number; why: string };

/**
 * Exact parity, or, for a documented mismatch with the golden, exactly the known number of
 * differing elements (each off by at most `maxDiff`), so the TS side can't drift silently either way.
 */
export function parity(actual: ArrayLike<number>, expected: ArrayLike<number>, known?: Known) {
  const d = firstDiff(actual, expected);
  if (!known) {
    if (d.n !== 0) throw new Error(`differs from the reference: ${JSON.stringify(d)}`);
    return;
  }
  if (d.n !== known.n || d.max > known.maxDiff)
    throw new Error(
      `known mismatch (${known.why}) changed: expected ${JSON.stringify(known)}, got ${JSON.stringify(d)}`,
    );
}
