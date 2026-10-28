/**
 * One-entry memo for derived data: recomputes only when an input changed (Object.is), so a selector returns the
 * same reference until its inputs move (stable for useSyncExternalStore and the Stage's same-scene check). With
 * `keep`, a recomputed result equal to the last one (as `keep` judges) keeps the last reference too.
 */
export function memo<const A extends readonly unknown[], R>(
  inputs: () => A,
  compute: (...a: A) => R,
  keep?: (prev: R, next: R) => R,
): () => R {
  let last: { a: A; r: R } | null = null;
  return () => {
    const a = inputs();
    const prev = last;
    if (prev && a.length === prev.a.length && a.every((x, i) => Object.is(x, prev.a[i]))) return prev.r;
    const next = compute(...a);
    const r = prev && keep ? keep(prev.r, next) : next;
    last = { a, r };
    return r;
  };
}
