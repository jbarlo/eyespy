/**
 * Look-alike grouping. The similarity matrix is float32, with each dot product computed in double and then rounded.
 * Candidate pairs sort descending by (sim, i, j). Linking uses average linkage over union-find, and a group never
 * holds two detections of one frame.
 */
import { similarity } from "../../perception/pure.ts";

/**
 * Returns groups of indices into the inputs. `embs[k]` and `frames[k]` describe detection k. Members keep input
 * order, and groups sort stably by the frame of their first member.
 */
export function groupIndices(
  embs: readonly Float32Array[],
  frames: readonly number[],
  link: number,
  window: number,
): number[][] {
  const n = embs.length;
  if (!n) return [];
  const sim = new Float32Array(n * n);
  // The dot runs in double and a·b gives the same bits as b·a, so fill b >= a and mirror it to halve the work.
  for (let a = 0; a < n; a++)
    for (let b = a; b < n; b++) sim[a * n + b] = sim[b * n + a] = similarity(embs[a]!, embs[b]!);
  const pairs: [number, number, number][] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      const gap = Math.abs(frames[a]! - frames[b]!);
      const s = sim[a * n + b]!;
      if (s >= link && gap > 0 && gap <= window) pairs.push([s, a, b]);
    }
  pairs.sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2]);
  const root = Array.from({ length: n }, (_, k) => k);
  const members = Array.from({ length: n }, (_, k) => [k]);
  const frameSets = frames.map((f) => new Set([f]));
  const find = (k: number) => {
    let x = k;
    while (root[x] !== x) {
      root[x] = root[root[x]!]!;
      x = root[x]!;
    }
    return x;
  };
  // Average linkage, because single-link chains drift across a long pan (jar ~ tub ~ other tub ...).
  for (const [, a, b] of pairs) {
    const ra = find(a),
      rb = find(b);
    const fa = frameSets[ra]!,
      fb = frameSets[rb]!,
      ma = members[ra]!,
      mb = members[rb]!;
    if (ra === rb || [...fb].some((f) => fa.has(f))) continue;
    let s = 0;
    for (const i of ma) for (const j of mb) s += sim[i * n + j]!;
    if (s / (ma.length * mb.length) < link) continue;
    root[rb] = ra;
    for (const f of fb) fa.add(f);
    ma.push(...mb);
  }
  const out = new Map<number, number[]>();
  for (let k = 0; k < n; k++) {
    const r = find(k);
    const g = out.get(r);
    if (g) g.push(k);
    else out.set(r, [k]);
  }
  return [...out.values()].sort((x, y) => frames[x[0]!]! - frames[y[0]!]!);
}
