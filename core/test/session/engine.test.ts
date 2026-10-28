import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Result } from "neverthrow";
import { ResultAsync, errAsync, ok, okAsync } from "neverthrow";
import { hostFailure } from "../../src/ports/index.ts";
import { createEngine } from "../../src/session/index.ts";
import type { Session, SessionError } from "../../src/session/index.ts";
import { DEFAULT_CONFIG } from "../../src/session/pure.ts";
import { isFrameNo, type FrameNo } from "../../src/video/pure.ts";
import { openEngine } from "../compose.ts";
import { FakeClock, FakeLogger, FakeTimers, KITCHEN, MemStore, fakeHost } from "../fakes/index.ts";

const fno = (n: number): FrameNo => {
  assert.ok(isFrameNo(n));
  return n;
};

const REAL = fileURLToPath(new URL("../fixtures/session-real", import.meta.url));

test("background: frames that can't be read are given up on (logged once each), so pending empties", async () => {
  const o = await openEngine(fakeHost({ store: MemStore.fromDir(REAL) }), {}, { settle: false });
  try {
    await o.settle(); // would time out if the loop retried them forever
    const failed = o.host.logger.lines.filter((l) => l.startsWith("background:"));
    const live = (await o.caller.status({})).keyframes;
    assert.equal(failed.length, live);
    assert.match(failed[0] ?? "", /missing-frame-file/);
  } finally {
    o.close();
  }
});

test("calls run one at a time in submission order; each gets its own Ctx", async () => {
  const o = await openEngine();
  try {
    await o.caller.add({ video: KITCHEN });
    const order: string[] = [];
    const call = (name: string, cfg?: Record<string, number>) =>
      o.engine.call(cfg, (s, ctx) => {
        order.push(`${name} ${ctx.cfg.threshold}`);
        return okAsync(s.config().threshold);
      });
    const [a, b, c] = await Promise.all([call("a"), call("b", { threshold: 0.9 }), call("c")]);
    assert.deepEqual(order, ["a 0.5", "b 0.9", "c 0.5"]);
    assert.deepEqual(
      [a, b, c].map((r) => r._unsafeUnwrap()),
      [0.5, 0.5, 0.5],
      "overrides are never saved",
    );
    const bad = await o.engine.call({ zeta: 1, alpha: 2 }, () => okAsync(1));
    assert.deepEqual(bad._unsafeUnwrapErr(), { kind: "unknown-settings", keys: ["alpha", "zeta"] });
  } finally {
    o.close();
  }
});

test("shutdown: onExit once; later calls are `shutting-down`", async () => {
  const o = await openEngine();
  o.engine.shutdown();
  o.engine.shutdown();
  assert.equal(o.exited(), true);
  const r = await o.engine.call(undefined, () => okAsync(1));
  assert.deepEqual(r._unsafeUnwrapErr(), { kind: "shutting-down" });
});

// The tests below run createEngine over a stub session on fake timers.

type Stub = {
  /** What the next background unit returns (default: Ok(false), nothing to do). */
  next: () => ResultAsync<boolean, SessionError>;
  pending: FrameNo[];
  units: number;
};

function stubEngine(idleMinutes = 30) {
  const st: Stub = { next: () => okAsync(false), pending: [], units: 0 };
  const session = {
    background: () => {
      st.units++;
      return st.next();
    },
    pending: () => st.pending,
    config: () => DEFAULT_CONFIG,
    needsAppearanceMigration: () => false,
  } as unknown as Session;
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const logger = new FakeLogger();
  let exits = 0;
  const engine = createEngine(session, { clock, logger, timers }, { idleMinutes, onExit: () => exits++ });
  return { st, engine, timers, logger, exited: () => exits };
}

/** Let the actor's loop run to its next await on a timer. */
const flush = () => new Promise((r) => setImmediate(r));
const hostDown = () => errAsync<boolean, SessionError>(hostFailure("runtime", "run", new Error("device lost")));

test("back-off: a host failure retries after 1 s, doubling to 60 s; a unit that succeeds resets it", async () => {
  const { st, engine, timers } = stubEngine();
  try {
    st.next = hostDown;
    st.units = 0;
    engine.call(undefined, () => okAsync(0)); // wakes the loop
    await flush();
    for (let k = 0; k < 8; k++) {
      timers.advance(timers.afters.at(-1) ?? 0);
      await flush();
    }
    assert.deepEqual(timers.afters, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    assert.equal(st.units, 9, "one unit per retry, none in between");
    // one unit succeeds with more to do and the next fails, so the delay drops back to the first one
    let ok = true;
    st.next = () => (ok ? ((ok = false), okAsync(true)) : hostDown());
    timers.advance(60_000);
    await flush();
    assert.equal(timers.afters.at(-1), 1000);
  } finally {
    engine.shutdown();
  }
});

test("back-off: queued requests still run while the retry waits", async () => {
  const { st, engine, timers } = stubEngine();
  try {
    st.next = hostDown;
    await engine.call(undefined, () => okAsync(0));
    await flush();
    const pendingRetry = timers.afters.length;
    assert.ok(pendingRetry >= 1);
    const r = await engine.call(undefined, () => okAsync("ran"));
    assert.equal(r._unsafeUnwrap(), "ran", "no timer advanced");
  } finally {
    engine.shutdown();
  }
});

test("background: a frame that can't be read is skipped without backing off", async () => {
  const { st, engine, timers } = stubEngine();
  try {
    let bad = 2;
    st.next = () => (bad-- > 0 ? errAsync({ kind: "missing-frame-file", frame: fno(bad) }) : okAsync(false));
    await engine.call(undefined, () => okAsync(0));
    await flush();
    assert.deepEqual(timers.afters, []);
    assert.equal(bad, -1, "both bad frames and the final idle unit ran");
  } finally {
    engine.shutdown();
  }
});

test("idle exit: after idle_minutes without requests, once encoding is done and nothing is in flight", async () => {
  const { st, engine, timers, logger, exited } = stubEngine(1);
  st.pending = [fno(0)];
  timers.advance(5 * 60_000);
  assert.equal(exited(), 0, "frames still to encode");
  st.pending = [];
  // a request in flight (its job waits on `release`) keeps it alive however long it takes
  let release = () => {};
  const held = engine.call(
    undefined,
    () => new ResultAsync(new Promise<Result<number, SessionError>>((r) => (release = () => r(ok(1))))),
  );
  await flush();
  timers.advance(5 * 60_000);
  assert.equal(exited(), 0, "a request in flight");
  release();
  await held;
  timers.advance(30_000);
  assert.equal(exited(), 0, "the request just finished: idle starts over");
  timers.advance(60_000);
  assert.equal(exited(), 1);
  assert.match(logger.lines.at(-1) ?? "", /^idle for 2 min, exiting$/);
  assert.equal(timers.pending, 0, "shutdown cancels the idle check");
});
