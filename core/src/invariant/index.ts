/** Checks for programmer bugs. Each helper throws an InvariantError when its check fails. */

/** Only the helpers below throw this. */
class InvariantError extends Error {
  override name = "InvariantError";
}

export function invariant(cond: unknown, msg: string | (() => string)): asserts cond {
  if (!cond) throw new InvariantError(typeof msg === "string" ? msg : msg());
}

/** `a[k]` for an index known to be in range. */
export function at<T>(a: ArrayLike<T>, k: number): T {
  const v = a[k];
  if (v === undefined) throw new InvariantError(`index ${k} out of range (length ${a.length})`);
  return v;
}

/** `m.get(k)` for a key known to be present. */
export function got<K, V>(m: ReadonlyMap<K, V>, k: K): V {
  const v = m.get(k);
  if (v === undefined) throw new InvariantError(`missing key ${String(k)}`);
  return v;
}
