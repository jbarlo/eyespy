import type { DetId, Detection, Run } from "../../src/detections/index.ts";
import { detId } from "../../src/detections/pure.ts";
import type { Appearance, Instance } from "../../src/perception/index.ts";
import { APPEARANCE_DIM, normalize } from "../../src/perception/pure.ts";
import { maskArea, type Box } from "../../src/pixels/index.ts";
import type { FrameNo } from "../../src/video/pure.ts";
import { isFrameNo } from "../../src/video/pure.ts";

export const frame = (i: number): FrameNo => {
  if (!isFrameNo(i)) throw new Error(`bad frame ${i}`);
  return i;
};

/** Unit vector along axis `a` (plus `w` of axis `b`), so similarities are predictable. */
export function emb(a: number, b = a, w = 0): Appearance {
  const e = new Float32Array(APPEARANCE_DIM);
  e[a] = 1;
  e[b] = (e[b] ?? 0) + w;
  return normalize(e);
}

export const fullMask = ([x0, y0, x1, y1]: Box) => new Uint8Array((x1 - x0) * (y1 - y0)).fill(1);

export const instance = (box: Box, score = 0.9, mask = fullMask(box)): Instance => ({
  score,
  box,
  mask,
  area: maskArea(mask),
});

export type DetOpts = Partial<Pick<Detection, "prompt" | "region" | "score" | "t" | "emb" | "box">>;

/** Detection "f.n": by default a 10×10 box at x = 12n (no two overlap, so no aliases). */
export function det(id: string, o: DetOpts = {}): Detection {
  const [f, n] = id.split(".").map(Number);
  if (f === undefined || n === undefined) throw new Error(`bad id ${id}`);
  const box = o.box ?? ([n * 12, 0, n * 12 + 10, 10] as const);
  const mask = fullMask(box);
  return {
    id: detId(frame(f), n),
    frame: frame(f),
    t: o.t ?? f,
    prompt: o.prompt ?? "jar",
    region: o.region ?? null,
    score: o.score ?? 0.9,
    box,
    mask,
    area: mask.length,
    emb: o.emb ?? emb(0),
  };
}

export const run = (f: number, prompt: string, region: Box | null = null): Run => ({ frame: frame(f), prompt, region });

export const ids = (ds: readonly { readonly id: DetId }[]) => ds.map((d) => d.id);

/** The value of an Ok. Throws on an Err, since tests expect success. */
export function okv<T, E>(r: { isOk(): boolean; _unsafeUnwrap(): T; _unsafeUnwrapErr(): E }): T {
  if (!r.isOk()) throw new Error(`expected Ok, got Err ${JSON.stringify(r._unsafeUnwrapErr())}`);
  return r._unsafeUnwrap();
}
export function errv<T, E>(r: { isErr(): boolean; _unsafeUnwrap(): T; _unsafeUnwrapErr(): E }): E {
  if (!r.isErr()) throw new Error(`expected Err, got Ok ${JSON.stringify(r._unsafeUnwrap())}`);
  return r._unsafeUnwrapErr();
}
