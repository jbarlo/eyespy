/**
 * A persistent stack (cons list). Push, pop and top are O(1) and share the tail. `toArray` loops instead of
 * recursing, because lists can be long enough to overflow the call stack.
 */

/** Top first. Null is the empty stack. */
export type Stack<T> = { readonly top: T; readonly rest: Stack<T> } | null;

export const push = <T>(s: Stack<T>, x: T): Stack<T> => ({ top: x, rest: s });

/** Bottom (oldest) first. */
export const toArray = <T>(s: Stack<T>): readonly T[] => {
  const out: T[] = [];
  for (let c = s; c !== null; c = c.rest) out.push(c.top);
  return out.reverse();
};
