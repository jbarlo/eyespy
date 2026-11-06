/** Tracking in the app: off without the flag, Find queues it, the selection goes first, and how it reads. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMaskReads } from "../src/state/track-masks.cache.ts";
import { rleBox, trackingPhase, unsureAt, type TrackMasks, type TrackRow } from "../src/state/tracking.ts";
import { sessionHandlers, settle, setup } from "./fakes.ts";

const track = (over: Partial<TrackRow> = {}): TrackRow =>
  ({
    id: "t1",
    det: "0.2",
    clip: "c1",
    seed_at: 0,
    state: "active",
    failure: null,
    priority: 0,
    forward: 3,
    reverse: 0,
    done: 4,
    total: 10,
    parked: false,
    skipped: 0,
    seen: { first: 0, last: 3, count: 4 },
    finished: false,
    ...over,
  }) as TrackRow;

const handlers = (tracks: readonly TrackRow[], calls: string[]) =>
  sessionHandlers({
    "track.status": () => ({ paused: false, tracks, waiting: 0 }),
    "track.proposals": () => ({ groups: [], waiting: 0, left_out: [], weak_covers: 0 }),
    "track.frames": () => ({ clip: "c1", frames: [], cuts: [] }),
    "track.auto": (i) => {
      calls.push(`auto ${JSON.stringify(i)}`);
      return { paused: false, tracks, waiting: 1 };
    },
    "track.prioritise": (i) => {
      calls.push(`prioritise ${JSON.stringify(i)}`);
      return { paused: false, tracks, waiting: 0 };
    },
    "track.start": (i) => {
      calls.push(`start ${JSON.stringify(i)}`);
      return { paused: false, tracks, waiting: 0 };
    },
    find: () => ({ hits: [] }),
  });

test("without the flag no tracking op is ever called", async () => {
  const { app, engine } = setup();
  await app.actions.openSession({ opfs: "s1" });
  app.actions.select(["0.2"]);
  await app.actions.find("jar", "frame");
  await settle();
  assert.deepEqual(
    engine.calls.filter((c) => c.path.startsWith("track.")),
    [],
  );
  assert.equal(app.tracking, false);
});

test("a Find queues auto tracking of its keyframes at the shown threshold", async () => {
  const calls: string[] = [];
  const { app } = setup({ tracking: true, handlers: handlers([], calls) });
  await app.actions.openSession({ opfs: "s1" });
  await app.actions.find("jar", "0-1");
  await settle();
  assert.deepEqual(calls, ['auto {"frames":"0,1","threshold":0.5}']);
});

test("selecting a detection on a queued track raises it, and one with no track starts it", async () => {
  const calls: string[] = [];
  const tracks = [track({ priority: 1, id: "t9", det: "5.0" as TrackRow["det"] }), track()];
  const { app } = setup({ tracking: true, handlers: handlers(tracks, calls) });
  await app.actions.openSession({ opfs: "s1" });
  await settle();
  app.actions.select(["0.2"]);
  await settle();
  assert.deepEqual(calls, ['prioritise {"ids":["t1"]}']);
  calls.length = 0;
  app.actions.select(["0.3"]);
  await settle();
  assert.deepEqual(calls, ['start {"ids":["0.3"],"first":true}']);
});

test("a stopped track isn't restarted by selecting it, and stopping everything stops new tracks too", async () => {
  const calls: string[] = [];
  const { app } = setup({ tracking: true, handlers: handlers([track({ state: "cancelled" })], calls) });
  await app.actions.openSession({ opfs: "s1" });
  await settle();
  app.actions.select(["0.2"]);
  await settle();
  app.actions.select(["0.3"]);
  await settle();
  assert.deepEqual(calls, []);
});

test("the phase says what the queue is doing", () => {
  const grids = new Map();
  const st = (tracks: readonly TrackRow[], paused = false, waiting = 0) => ({ paused, tracks, waiting });
  assert.equal(trackingPhase(null, grids).kind, "off");
  assert.equal(trackingPhase(st([]), grids).kind, "off");
  assert.deepEqual(trackingPhase(st([track()]), grids), { kind: "preparing", clip: "c1", read: 4, frames: 10 });
  assert.equal(trackingPhase(st([track()], true), grids).kind, "paused");
  const over = track({ id: "t2", finished: true, reverse: 0, forward: 9, done: 10 });
  assert.equal(trackingPhase(st([track(), over]), grids).kind, "running");
  assert.equal(trackingPhase(st([over]), grids).kind, "finished");
  assert.equal(trackingPhase(st([over, track({ state: "cancelled" })]), grids).kind, "stopped");
  assert.equal(trackingPhase(st([over], false, 2), grids).kind, "running");
});

test("rleBox and what looks unsure", () => {
  // 4 wide: row 1 columns 1 and 2, row 2 column 1
  assert.deepEqual(rleBox([5, 2, 2, 1], 4), [1, 1, 3, 3]);
  assert.equal(rleBox([16], 4), null);
  const proposals = {
    groups: [{ tracks: [{ track: "t1", converged_with: [{ track: "t2", frames: 3, first: 4, last: 6 }] }] }],
  } as never;
  assert.equal(unsureAt(null, "t1", 5, 1.5), "score");
  assert.equal(unsureAt(proposals, "t1", 5, 8), "overlap");
  assert.equal(unsureAt(proposals, "t1", 7, 8), null);
});

test("mask reads: dragging reads only the latest place, and a complete place comes from memory", async () => {
  const reads: number[] = [];
  const shown: number[] = [];
  const m = (at: number): TrackMasks => ({ clip: "c", at, t: at, keyframe: null, masks: [], parked: ["t1"] }) as never;
  const r = createMaskReads(
    async (_c, at) => {
      reads.push(at);
      return m(at);
    },
    (x) => shown.push(x.at),
  );
  r.want("c", 1, 1);
  r.want("c", 2, 1);
  r.want("c", 3, 1);
  await settle();
  assert.deepEqual(reads, [1, 3]);
  assert.deepEqual(shown, [3]);
  r.want("c", 3, 1);
  assert.equal(reads.length, 2);
  r.want("c", 3, 2); // a new track has reached it
  await settle();
  assert.deepEqual(reads, [1, 3, 3]);
});
