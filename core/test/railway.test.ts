import assert from "node:assert/strict";
import { test } from "node:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { Lru, parallel, parseJson, push, sequence, sha1Hex, toArray } from "../src/railway/index.ts";

/** A fake host call that resolves after `ms`, counting how many are in flight. */
function host() {
  const s = { inFlight: 0, max: 0, started: [] as number[], settled: [] as number[] };
  const call = <U>(k: number, value: U, ms = 1, fail = false): ResultAsync<U, string> => {
    s.inFlight++;
    s.max = Math.max(s.max, s.inFlight);
    s.started.push(k);
    return ResultAsync.fromSafePromise(new Promise<void>((r) => setTimeout(r, ms))).andThen(() => {
      s.inFlight--;
      s.settled.push(k);
      return fail ? errAsync(`fail ${k}`) : okAsync(value);
    });
  };
  return { s, call };
}

const xs = Array.from({ length: 100 }, (_, i) => i);

test("sequence: one call at a time, in order, results in order ", async () => {
  const { s, call } = host();
  const r = await sequence(xs, (x, k) => call(k, x * 2, 0));
  assert.deepEqual(
    r._unsafeUnwrap(),
    xs.map((x) => x * 2),
  );
  assert.equal(s.max, 1);
  assert.deepEqual(s.started, xs);
});

test("sequence: stops at the first Err; later steps never start", async () => {
  const { s, call } = host();
  const r = await sequence(xs, (x, k) => call(k, x, 0, k === 40));
  assert.equal(r._unsafeUnwrapErr(), "fail 40");
  assert.deepEqual(s.started, xs.slice(0, 41));
});

test("sequence / parallel: empty input, undefined results", async () => {
  assert.deepEqual((await sequence([], () => okAsync(1)))._unsafeUnwrap(), []);
  assert.deepEqual((await parallel([], () => okAsync(1)))._unsafeUnwrap(), []);
  const none = (await parallel([1, 2, 3], () => okAsync(undefined)))._unsafeUnwrap();
  assert.deepEqual(none, [undefined, undefined, undefined]);
  assert.deepEqual((await sequence([1, 2], () => okAsync(undefined)))._unsafeUnwrap(), [undefined, undefined]);
});

test("parallel: at most `limit` calls in flight, results in input order whatever finishes first", async () => {
  const { s, call } = host();
  // later items finish sooner, so completion order differs from input order
  const r = await parallel(xs, (x, k) => call(k, `v${x}`, 1 + ((100 - k) % 7)), 8);
  assert.deepEqual(
    r._unsafeUnwrap(),
    xs.map((x) => `v${x}`),
  );
  assert.equal(s.max, 8);
  assert.notDeepEqual(s.settled, xs);
  const small = host();
  await parallel([1, 2, 3], (x, k) => small.call(k, x), 8);
  assert.equal(small.s.max, 3);
});

test("parallel: an Err is the result only once every started call has settled", async () => {
  const { s, call } = host();
  const r = await parallel(xs, (x, k) => call(k, x, k === 5 ? 1 : 3, k === 5 || k === 50), 4);
  assert.equal(r._unsafeUnwrapErr(), "fail 5", "the failing lane that comes first (lane 1 of 4)");
  assert.equal(s.inFlight, 0, "nothing still running after the result");
  // the failing lanes (1, 5, 9, ... and 2, 6, ..., 50, ...) stopped at their Err; the other two ran to their end
  assert.ok(!s.started.includes(9) && !s.started.includes(54));
  assert.ok(s.started.includes(99) && s.started.includes(96));
});

test("sequence: a 100k-step list resolves, results in order", async () => {
  const n = 100_000;
  const r = (
    await sequence(
      Array.from({ length: n }, (_, i) => i),
      (x) => okAsync(x),
    )
  )._unsafeUnwrap();
  assert.equal(r.length, n);
  assert.ok(r.every((x, i) => x === i));
});

test("parseJson: values as unknown, the parser's message on bad text", () => {
  assert.deepEqual(parseJson('{"a": [1, null]}')._unsafeUnwrap(), { a: [1, null] });
  assert.equal(typeof parseJson("{")._unsafeUnwrapErr(), "string");
  assert.ok(parseJson("").isErr());
});

test("sha1Hex: the FIPS 180 test vectors", async () => {
  assert.equal(await sha1Hex(new TextEncoder().encode("abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(await sha1Hex(new Uint8Array()), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
});

test("Lru: get refreshes, has does not; set drops the least recently used beyond capacity", () => {
  const c = new Lru<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1); // b is now the oldest
  assert.ok(c.has("b"));
  c.set("c", 3);
  assert.deepEqual([c.has("a"), c.has("b"), c.has("c"), c.size], [true, false, true, 2]);
  c.set("a", 9); // replacing an entry refreshes it
  c.set("d", 4);
  assert.deepEqual([c.get("a"), c.has("c"), c.get("d")], [9, false, 4]);
  c.delete("a");
  assert.equal(c.size, 1);
});

test("Stack: push shares the tail; toArray is bottom first", () => {
  const a = push(push(null, 1), 2);
  const b = push(a, 3);
  const c = push(a, 4);
  assert.deepEqual(toArray(b), [1, 2, 3]);
  assert.deepEqual(toArray(c), [1, 2, 4]);
  assert.equal(b?.rest, c?.rest);
  assert.deepEqual(toArray(null), []);
});
