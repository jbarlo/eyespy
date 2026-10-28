/** Small helpers every module shares. It imports nothing else in core. */
import { okAsync, Result, ResultAsync } from "neverthrow";
import type { Stack } from "./internal/stack.kernel.ts";
import { push, toArray } from "./internal/stack.kernel.ts";

export type { Stack } from "./internal/stack.kernel.ts";
export { push, toArray } from "./internal/stack.kernel.ts";
export { Lru } from "./internal/lru.cache.ts";

/**
 * Runs `f` over `xs` one at a time and stops at the first Err. Results come in input order. Use it where order
 * matters (memory, one model, drawText calls that must arrive in order). Results go on a cons list, because
 * spreading an accumulator on each step is O(n²).
 */
export const sequence = <T, U, E>(
  xs: readonly T[],
  f: (x: T, k: number) => ResultAsync<U, E>,
): ResultAsync<readonly U[], E> =>
  xs
    .reduce<ResultAsync<Stack<U>, E>>(
      (acc, x, k) => acc.andThen((done) => f(x, k).map((u) => push(done, u))),
      okAsync(null),
    )
    .map(toArray);

/** How many host calls `parallel` keeps in flight by default. */
const PARALLEL_LIMIT = 8;

/**
 * Runs `f` over `xs` with up to `limit` calls in flight, for independent host IO. Results come in input order. It
 * settles only once every started call has settled. Each lane takes every limit-th item and stops at its first
 * Err. The other lanes run to their end, and the result is the Err of the first failing lane by lane order, not
 * item order. Use it only where a partial run is safe to repeat.
 */
export const parallel = <T, U, E>(
  xs: readonly T[],
  f: (x: T, k: number) => ResultAsync<U, E>,
  limit = PARALLEL_LIMIT,
): ResultAsync<readonly U[], E> => {
  const n = Math.max(1, Math.min(Math.trunc(limit), xs.length));
  const indexed = xs.map((x, k) => ({ x, k }));
  const lanes = Array.from({ length: n }, (_, w) => indexed.filter(({ k }) => k % n === w));
  const rows = Array.from({ length: Math.ceil(xs.length / n) }, (_, r) => r);
  // Item k is row k / n of lane k % n. Read the lanes back row by row, using slices because U may be undefined.
  return ResultAsync.combine(lanes.map((lane) => sequence(lane, ({ x, k }) => f(x, k)))).map((done) =>
    rows.flatMap<U>((r) => done.flatMap<U>((lane) => lane.slice(r, r + 1))),
  );
};

/** Parses JSON text to `unknown`, with the parser's message as the error. Callers zod-parse it and word the error. */
export const parseJson: (text: string) => Result<unknown, string> = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  (e) => (e instanceof Error ? e.message : String(e)),
);

/** Lower-case hex SHA-1 of `bytes` (40 characters). */
export const sha1Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
};
