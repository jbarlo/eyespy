/** The Stage controller runs against stub canvas/DOM globals and counts its draws (window.eyespyStage.stats). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { TipState } from "../src/ui/stage/controller.ts";
import { createStageController } from "../src/ui/stage/controller.ts";
import { det, rle, sessionHandlers, settle, setup } from "./fakes.ts";
import type { Handlers } from "./fakes.ts";

/** A 2D context whose every method is a no-op and every property is writable. */
const fakeContext = (): unknown =>
  new Proxy(
    {},
    {
      get: (t: Record<string | symbol, unknown>, k) =>
        k in t ? t[k] : k === "measureText" ? () => ({ width: 10 }) : () => {},
      set: (t: Record<string | symbol, unknown>, k, v) => {
        t[k] = v;
        return true;
      },
    },
  );

class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext() {
    return fakeContext();
  }
}
class FakeImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

Object.assign(globalThis, {
  OffscreenCanvas: FakeOffscreenCanvas,
  ImageData: FakeImageData,
  ResizeObserver: FakeResizeObserver,
  devicePixelRatio: 1,
  addEventListener: () => {},
  removeEventListener: () => {},
});

const element = () => ({
  width: 800,
  height: 600,
  clientWidth: 800,
  clientHeight: 600,
  style: {},
  getContext: () => fakeContext(),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  addEventListener: () => {},
  removeEventListener: () => {},
  setPointerCapture: () => {},
});

async function mountStage(handlers: Handlers) {
  const t = setup({ handlers });
  await t.app.actions.openSession({ opfs: "s1" });
  const tip = createStore<TipState>()(() => ({ tip: null }));
  const ctl = createStageController({
    canvas: element() as unknown as HTMLCanvasElement,
    wrap: element() as unknown as HTMLDivElement,
    app: t.app,
    tip,
  });
  await settle(); // the first frame's masks and bitmap arrive
  return { ...t, ctl, stats: ctl.handle.stats };
}

/** The default session with a find that adds one detection on each frame it runs on. */
function findingHandlers(): Handlers {
  const base = sessionHandlers();
  const dataDets = base["data.dets"];
  assert.ok(dataDets);
  const added: ReturnType<typeof det>[] = [];
  return {
    ...base,
    find: (i: { frames: string }) => {
      const d = det(`${i.frames}.9`, { prompt: "lid", score: 0.8 });
      added.push(d);
      return { hits: [d] };
    },
    "data.dets": (i: { mask?: string; frames?: string }) => {
      const r = dataDets(i as never, { path: "data.dets", session: 1 }) as { dets: unknown[] };
      const extra = added.filter((d) => i.mask !== "rle" || String(d.frame) === i.frames);
      const rows = i.mask === "rle" ? extra.map((d) => ({ ...d, mask: rle, aliases: [d.id] })) : extra;
      return { dets: [...r.dets, ...rows] };
    },
  };
}

test("find over 5 frames: the Stage draws only when the current frame's data changes", async () => {
  const { app, stats } = await mountStage(findingHandlers());
  const before = stats.draws;
  const res = await app.actions.find("lid", "all");
  await settle();
  assert.equal(res?.frames, 5);
  assert.equal(app.stores.detections.getState().dets.length, 8 + 5);
  const draws = stats.draws - before;
  // the current frame (0) gets a new detection, so its refresh and its mask load are the only real changes
  assert.ok(draws <= 2, `draws during find: ${draws}`);
});

test("find with nothing new: no draw at all", async () => {
  const { app, stats } = await mountStage(sessionHandlers({ find: () => ({ hits: [] }) }));
  const before = stats.draws;
  await app.actions.find("jar", "all");
  await settle();
  assert.equal(stats.draws - before, 0);
});

test("status poll while encoding: unchanged frames are not replaced and the Stage doesn't redraw", async () => {
  const status = sessionHandlers().status;
  assert.ok(status);
  const encoding = () => ({ ...(status({} as never, { path: "status", session: 1 }) as object), encoded: 2 });
  const { app, clock, stats } = await mountStage(sessionHandlers({ status: encoding }));
  const fr = app.stores.frames.getState().frames;
  const before = stats.draws;
  clock.advance(2500);
  await settle();
  clock.advance(2500);
  await settle();
  assert.equal(app.stores.frames.getState().frames, fr, "same frames reference");
  assert.equal(stats.draws - before, 0);
});

test("a real change on the current frame still draws (selection, layers)", async () => {
  const { app, stats } = await mountStage(sessionHandlers());
  const before = stats.draws;
  app.actions.select(["0.2"]);
  await settle();
  assert.equal(stats.draws - before, 1);
  app.actions.setLayer("rejects", true);
  await settle();
  assert.equal(stats.draws - before, 2);
  app.actions.setLayer("rejects", true); // same value, so nothing to draw
  await settle();
  assert.equal(stats.draws - before, 2);
});

test("a mask load on another frame keeps visible()'s reference", async () => {
  const { app } = setup();
  await app.actions.openSession({ opfs: "s1" });
  await app.actions.loadMasks(0);
  const vis = app.select.visible();
  const fm = app.select.frameMasks();
  await app.actions.loadMasks(5);
  assert.equal(app.select.frameMasks(), fm);
  assert.equal(app.select.visible(), vis);
  await app.actions.loadMasks(0, true); // same masks re-read
  assert.equal(app.select.frameMasks(), fm);
  assert.equal(app.select.visible(), vis);
});

test("a refresh with identical data keeps every reference", async () => {
  const { app } = setup();
  await app.actions.openSession({ opfs: "s1" });
  const d = app.stores.detections.getState();
  const o = app.stores.objects.getState();
  const st = app.stores.engine.getState().status;
  const byFrame = app.select.detsByFrame();
  await app.actions.refresh();
  const d2 = app.stores.detections.getState();
  const o2 = app.stores.objects.getState();
  assert.equal(d2.dets, d.dets);
  assert.equal(d2.runs, d.runs);
  assert.equal(o2.objects, o.objects);
  assert.equal(o2.history, o.history);
  assert.equal(app.stores.engine.getState().status, st);
  assert.equal(app.select.detsByFrame(), byFrame);
});

test("a refresh that adds a detection on one frame keeps the other frames' rows and lists", async () => {
  const handlers = findingHandlers();
  const { app } = setup({ handlers });
  await app.actions.openSession({ opfs: "s1" });
  const before = app.select.detsByFrame();
  const row = app.stores.detections.getState().dets[0];
  await handlers.find?.({ frames: "5" } as never, { path: "find", session: 1 });
  await app.actions.refresh();
  const after = app.select.detsByFrame();
  assert.notEqual(after, before);
  assert.equal(after.get(0), before.get(0), "frame 0's list kept");
  assert.notEqual(after.get(5), before.get(5));
  assert.equal(app.stores.detections.getState().dets[0], row, "unchanged rows kept");
});
