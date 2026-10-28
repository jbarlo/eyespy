/**
 * The cache for page-side assets, with deduplicated keyed loads. `dispose` runs exactly once for every value that
 * leaves the cache, and for a value whose load finishes after its entry left, so a reset never leaks an ImageBitmap or
 * object URL. A failed load leaves no entry, so the next request retries it.
 */
import type { ResultAsync } from "neverthrow";

export type AssetCache<K, V> = {
  /** The value if loaded (marks it recently used); never starts a load. */
  readonly peek: (key: K) => V | undefined;
  /** Load (once) and resolve to the value, or null if the load failed or the entry left before it finished. */
  readonly load: (key: K) => Promise<V | null>;
  /** Loaded or loading. */
  readonly has: (key: K) => boolean;
  readonly delete: (key: K) => void;
  /** Drop every entry whose key `keep` rejects. */
  readonly prune: (keep: (key: K) => boolean) => void;
  readonly reset: () => void;
  readonly size: () => number;
  readonly subscribe: (fn: () => void) => () => void;
  /** Bumped on every change (for useSyncExternalStore). */
  readonly version: () => number;
};

type CacheOptions<K, V, E> = {
  readonly load: (key: K) => ResultAsync<V, E>;
  readonly dispose?: (value: V) => void;
  /** A key's identity in the cache (defaults to the key itself; give one for object keys). */
  readonly id?: (key: K) => unknown;
  /** LRU bound on loaded values (loads in flight are never evicted and don't count). */
  readonly max?: number;
  /** One load at a time, in request order, to keep the main thread free. */
  readonly serial?: boolean;
  readonly onError?: (key: K, error: E) => void;
};

type Entry<K, V> = { readonly key: K; value: V | undefined; promise: Promise<V | null> | null };

export function createCache<K, V, E>(o: CacheOptions<K, V, E>): AssetCache<K, V> {
  const entries = new Map<unknown, Entry<K, V>>();
  const listeners = new Set<() => void>();
  let version = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const dispose = o.dispose ?? (() => {});
  const idOf = o.id ?? ((key: K): unknown => key);

  const changed = () => {
    version++;
    for (const l of listeners) l();
  };
  const touch = (id: unknown, e: Entry<K, V>) => {
    entries.delete(id);
    entries.set(id, e);
  };
  const remove = (id: unknown): boolean => {
    const e = entries.get(id);
    if (!e) return false;
    entries.delete(id);
    if (e.value !== undefined) dispose(e.value);
    return true;
  };
  /** Makes room for one more loaded value by dropping the least recently used ones. */
  const evict = () => {
    if (o.max === undefined) return;
    const loaded = [...entries].filter(([, e]) => e.value !== undefined);
    for (const [id] of loaded.slice(0, Math.max(0, loaded.length - o.max + 1))) remove(id);
  };

  function load(key: K): Promise<V | null> {
    const id = idOf(key);
    const have = entries.get(id);
    if (have) {
      touch(id, have);
      return have.promise ?? Promise.resolve(null);
    }
    const entry: Entry<K, V> = { key, value: undefined, promise: null };
    const run = async (): Promise<V | null> => {
      if (entries.get(id) !== entry) return null; // left the cache while queued
      const r = await o.load(key);
      if (r.isErr()) {
        if (entries.get(id) === entry) entries.delete(id);
        o.onError?.(key, r.error);
        return null;
      }
      if (entries.get(id) !== entry) {
        dispose(r.value);
        return null;
      }
      entry.value = r.value;
      changed();
      return r.value;
    };
    evict();
    entries.set(id, entry);
    const promise = o.serial ? queue.then(run) : run();
    if (o.serial) queue = promise;
    entry.promise = promise;
    return promise;
  }

  return {
    peek: (key) => {
      const id = idOf(key);
      const e = entries.get(id);
      if (e?.value === undefined) return undefined;
      touch(id, e);
      return e.value;
    },
    load,
    has: (key) => entries.has(idOf(key)),
    delete: (key) => {
      if (remove(idOf(key))) changed();
    },
    prune: (keep) => {
      const gone = [...entries].filter(([, e]) => !keep(e.key));
      for (const [id] of gone) remove(id);
      if (gone.length) changed();
    },
    reset: () => {
      const had = entries.size > 0;
      for (const id of [...entries.keys()]) remove(id);
      if (had) changed();
    },
    size: () => entries.size,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    version: () => version,
  };
}
