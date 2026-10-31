/**
 * An answer worked out once, from a promise that never rejects. Calls before it settles share the promise, and calls
 * after get the value itself, synchronously.
 */
export function once<T>(fn: () => Promise<T>): () => T | Promise<T> {
  let known: { readonly value: T } | null = null;
  let pending: Promise<T> | null = null;
  return () => {
    if (known) return known.value;
    pending ??= fn().then((value) => {
      known = { value };
      return value;
    });
    return pending;
  };
}
