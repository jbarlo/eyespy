/** A zustand vanilla store with reset(), which restores its initial state (a fresh value from `initial`). */
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

export type Slice<S> = StoreApi<S> & { readonly reset: () => void };

export function slice<S>(initial: () => S): Slice<S> {
  const store = createStore<S>()(() => initial());
  return { ...store, reset: () => store.setState(initial(), true) };
}

/** Set membership as new values. */
export const withItem = <T>(s: ReadonlySet<T>, x: T): ReadonlySet<T> => new Set([...s, x]);
export const withoutItems = <T>(s: ReadonlySet<T>, gone: (x: T) => boolean): ReadonlySet<T> =>
  new Set([...s].filter((x) => !gone(x)));
