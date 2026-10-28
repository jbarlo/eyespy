/** A small LRU over a Map, whose insertion order puts the least recently used first. It is a cache, so it mutates. */
export class Lru<K, V> {
  private readonly m = new Map<K, V>();
  constructor(readonly capacity: number) {}

  /** Returns the value and marks it most recently used. */
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  /** Whether `k` is held. Does not mark it as used. */
  has(k: K): boolean {
    return this.m.has(k);
  }
  get size(): number {
    return this.m.size;
  }
  delete(k: K): void {
    this.m.delete(k);
  }
  /** Stores as most recently used, then drops the least recently used beyond `capacity`. */
  set(k: K, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    for (const first of this.m.keys()) {
      if (this.m.size <= this.capacity) break;
      this.m.delete(first);
    }
  }
}
