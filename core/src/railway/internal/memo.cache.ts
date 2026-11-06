/**
 * An async memo. It keeps the first successful result per key for the instance's lifetime. It does not keep a
 * failure, so the next call retries. Concurrent calls for one key share the pending result.
 */
import type { ResultAsync } from "neverthrow";

export class Memo<K, V, E> {
  private readonly m = new Map<K, ResultAsync<V, E>>();

  get(k: K, make: () => ResultAsync<V, E>): ResultAsync<V, E> {
    const hit = this.m.get(k);
    if (hit) return hit;
    const r = make().mapErr((e) => {
      this.m.delete(k);
      return e;
    });
    this.m.set(k, r);
    return r;
  }
}
