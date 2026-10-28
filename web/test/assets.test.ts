import assert from "node:assert/strict";
import { test } from "node:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { createCache } from "../src/state/assets/cache.ts";
import { cropSquare, jetTint } from "../src/state/assets/imaging.ts";
import { frame, sessionHandlers, setup } from "./fakes.ts";

const deferred = <T>() => {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

test("LRU: evicting beyond max disposes the least recently used value", async () => {
  const disposed: string[] = [];
  const c = createCache<string, string, never>({
    load: (k) => okAsync(`v${k}`),
    dispose: (v) => void disposed.push(v),
    max: 2,
  });
  await c.load("a");
  await c.load("b");
  c.peek("a"); // a is now newer than b
  await c.load("c");
  assert.deepEqual(disposed, ["vb"]);
  assert.equal(c.peek("a"), "va");
  c.reset();
  assert.deepEqual(disposed.sort(), ["va", "vb", "vc"]);
  assert.equal(c.size(), 0);
});

test("a load that finishes after reset/delete is disposed, not cached", async () => {
  const disposed: string[] = [];
  const d = deferred<string>();
  const c = createCache<string, string, never>({
    load: () => ResultAsync.fromSafePromise(d.promise),
    dispose: (v) => void disposed.push(v),
  });
  const p = c.load("k");
  assert.equal(c.has("k"), true);
  c.reset();
  d.resolve("late");
  assert.equal(await p, null);
  assert.deepEqual(disposed, ["late"]);
  assert.equal(c.has("k"), false);
});

test("loads are deduplicated; failures leave no entry and are reported", async () => {
  let n = 0;
  const errors: string[] = [];
  let fail = true;
  const c = createCache<string, number, string>({
    load: () => (n++, fail ? errAsync("nope") : okAsync(n)),
    onError: (_k, e) => void errors.push(e),
  });
  const [a, b] = await Promise.all([c.load("x"), c.load("x")]);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(n, 1);
  assert.deepEqual(errors, ["nope"]);
  assert.equal(c.has("x"), false);
  fail = false;
  assert.equal(await c.load("x"), 2, "retried");
});

test("serial: one load at a time in request order; listeners hear arrivals", async () => {
  const order: string[] = [];
  let running = 0,
    maxRunning = 0;
  const c = createCache<string, string, never>({
    load: (k) =>
      ResultAsync.fromSafePromise(
        (async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 1));
          order.push(k);
          running--;
          return k;
        })(),
      ),
    serial: true,
  });
  let heard = 0;
  c.subscribe(() => heard++);
  await Promise.all(["a", "b", "c"].map((k) => c.load(k)));
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(maxRunning, 1);
  assert.equal(heard, 3);
  assert.equal(c.version(), 3);
});

test("prune keeps only the keys asked for", async () => {
  const disposed: string[] = [];
  const c = createCache<string, string, never>({ load: (k) => okAsync(k), dispose: (v) => void disposed.push(v) });
  await Promise.all(["a", "b", "c"].map((k) => c.load(k)));
  c.prune((k) => k !== "b");
  assert.deepEqual(disposed, ["b"]);
  assert.equal(c.size(), 2);
});

test("more concurrent loads than max all resolve; the next load trims the oldest loaded values", async () => {
  const disposed: string[] = [];
  const c = createCache<string, string, never>({
    load: (k) => ResultAsync.fromSafePromise(new Promise<string>((r) => setTimeout(() => r(`v${k}`), 1))),
    dispose: (v) => void disposed.push(v),
    max: 10,
  });
  const keys = Array.from({ length: 24 }, (_, i) => String(i));
  const got = await Promise.all(keys.map((k) => c.load(k)));
  assert.deepEqual(
    got,
    keys.map((k) => `v${k}`),
    "none evicted while in flight",
  );
  assert.deepEqual(disposed, []);
  await c.load("next");
  assert.equal(c.size(), 10);
  assert.deepEqual(
    disposed,
    keys.slice(0, 15).map((k) => `v${k}`),
  );
});

test("a load in flight survives later loads beyond max", async () => {
  const slow = deferred<string>();
  const c = createCache<string, string, never>({
    load: (k) => (k === "slow" ? ResultAsync.fromSafePromise(slow.promise) : okAsync(k)),
    max: 2,
  });
  const p = c.load("slow");
  for (const k of ["a", "b", "c", "d"]) await c.load(k);
  slow.resolve("late");
  assert.equal(await p, "late");
  assert.equal(c.peek("slow"), "late");
});

test("24 crops at once: none blank, and the Stage's keyframe stays loaded", async () => {
  const frames = Array.from({ length: 30 }, (_, i) => frame(i));
  const { app, img } = setup({ handlers: sessionHandlers({ "data.frames": () => ({ frames }) }) });
  await app.actions.openSession({ opfs: "s1" });
  app.actions.setFrame(0);
  const shown = await app.actions.frameBitmap(0);
  assert.ok(shown);
  const box = [10, 10, 40, 30] as const;
  const dets = Array.from({ length: 24 }, (_, i) => ({ id: `${i + 1}.0`, frame: i + 1, box }));
  const crops = await Promise.all(dets.map((d) => app.actions.cropBitmap(d, 80)));
  assert.equal(crops.filter((b) => b === null).length, 0);
  assert.ok(crops.every((b) => b?.width === 80));
  assert.equal(app.assets.bitmaps.peek(app.select.frameKey(0) ?? ""), shown, "current frame retained");
  assert.equal(shown.width, 10, "and not closed");
  assert.equal(app.assets.bitmaps.size(), 1, "crops never fill the keyframe cache");
  assert.equal(await app.actions.cropBitmap({ id: "1.0", frame: 1, box }, 80), crops[0], "cut once");
  app.assets.reset();
  assert.ok(
    img.made.every((b) => b.closed),
    "reset closes crops too",
  );
});

test("jetTint: core's JET table gives the same pixels as the per-pixel formula", () => {
  const gray = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 256; v++) gray[v * 4] = v;
  const out = jetTint(gray);
  const c = (x: number, k: number) => Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - k))));
  const want = new Uint8ClampedArray(gray.length);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    want.set([c(x, 3), c(x, 2), c(x, 1), Math.round(70 + 185 * x)], v * 4);
  }
  assert.deepEqual(out, want);
});

test("cropSquare: the box's longer side × 1.3 + 8, centred on it", () => {
  assert.deepEqual(cropSquare([10, 10, 40, 30]), { x: 2, y: -3, side: 47 });
});
