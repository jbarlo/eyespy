/**
 * Structural sharing where engine replies enter the stores. A reply equal to what a store holds keeps the old reference
 * (and unchanged rows keep theirs), so memoised selectors, the Stage and panel subscriptions see no change when nothing
 * changed. Replies are plain JSON-shaped data, so equality is structural.
 */

/** Structural equality of JSON-shaped values (arrays, plain objects, primitives). */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const bs: readonly unknown[] = b;
    return a.every((x: unknown, i) => sameData(x, bs[i]));
  }
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => Object.hasOwn(b, k) && sameData(Reflect.get(a, k), Reflect.get(b, k)))
  );
}

export const keep = <T>(prev: T | null, next: T): T => (prev !== null && sameData(prev, next) ? prev : next);

/**
 * `next` with every row equal to the previous row of the same key replaced by that previous row; `prev` itself when
 * every row (and their order) is unchanged.
 */
export function keepRows<T>(prev: readonly T[], next: readonly T[], key: (row: T) => string | number): readonly T[] {
  const old = new Map(prev.map((r) => [key(r), r]));
  const rows = next.map((r) => {
    const o = old.get(key(r));
    return o !== undefined && sameData(o, r) ? o : r;
  });
  return sameRefs(prev, rows) ? prev : rows;
}

export const sameRefs = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** `prev` when it has the same keys with the same value references as `next`, else `next`. */
export function keepMap<K, V>(prev: ReadonlyMap<K, V>, next: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  if (prev.size !== next.size) return next;
  for (const [k, v] of next) if (prev.get(k) !== v || !prev.has(k)) return next;
  return prev;
}
