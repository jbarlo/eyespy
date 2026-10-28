import assert from "node:assert/strict";
import { test } from "node:test";
import { createDetections } from "../../src/detections/index.ts";
import {
  bestView,
  compareDetIds,
  compareDetections,
  covered,
  frameOf,
  groups,
  isHeatmapRef,
  ordinalOf,
  ranked,
  rle,
  runLabel,
  unrle,
} from "../../src/detections/pure.ts";
import { at } from "../../src/invariant/index.ts";
import { similarity } from "../../src/perception/pure.ts";
import { det, emb, errv, frame, ids, instance, okv, run } from "./helpers.ts";

test("pure: unrle inverts rle; runs past the size are cut off", () => {
  for (const m of [Uint8Array.of(1, 1, 0, 1), Uint8Array.of(0, 0), new Uint8Array(0), Uint8Array.of(0, 1, 1, 1, 0)])
    assert.deepEqual(unrle(rle(m), m.length), m);
  assert.deepEqual([...unrle([1, 5], 3)], [0, 1, 1]);
});

test("pure: bestView over any score/area shape (the web's mask-less rows)", () => {
  const rows = [
    { id: "a", score: 0.9, area: 4 },
    { id: "b", score: 0.5, area: 36 },
    { id: "c", score: 0.5, area: 36 },
  ];
  assert.equal(bestView(rows)?.id, "b");
});

test("pure: isHeatmapRef accepts plain file names only", () => {
  assert.ok(isHeatmapRef("0003-0123456789.png"));
  for (const bad of ["", ".", "..", "sem/x.png", "a\\b.png"]) assert.equal(isHeatmapRef(bad), false, bad);
});

const empty = () => createDetections({ detections: [], runs: [], reserved: new Map() });

test("mint: ids from the frame counter, in instance order; one run per (frame, prompt, region)", () => {
  const d = empty();
  const m = okv(
    d.mint({
      run: run(2, "jar"),
      t: 1.5,
      instances: [instance([0, 0, 10, 10], 0.9), instance([20, 0, 30, 5], 0.6)],
      embs: [emb(0), emb(1)],
      presence: 0.8,
      heatmap: null,
    }),
  );
  assert.deepEqual(ids(m.detections), ["2.0", "2.1"]);
  assert.deepEqual(
    m.detections.map((x) => [x.frame, x.t, x.prompt, x.region, x.area]),
    [
      [2, 1.5, "jar", null, 100],
      [2, 1.5, "jar", null, 50],
    ],
  );
  assert.deepEqual(m.run, { frame: 2, prompt: "jar", region: null, ids: ["2.0", "2.1"], presence: 0.8, heatmap: null });
  assert.deepEqual(errv(d.mint({ ...newRun(2, "jar"), instances: [] })), { kind: "run-exists", run: run(2, "jar") });
  // a region run of the same prompt is a separate run, and its ids continue
  const r = okv(d.mint(newRun(2, "jar", [0, 0, 50, 50])));
  assert.deepEqual(ids(r.detections), ["2.2"]);
  assert.equal(runLabel(r.run), "jar@0,0,50,50");
  assert.deepEqual(ids(d.byFrame(frame(2))), ["2.0", "2.1", "2.2"]);
  // an empty run takes no id and leaves no counter
  okv(d.mint({ ...newRun(3, "mug"), instances: [], embs: [] }));
  assert.deepEqual([...d.counters([frame(2), frame(3)])], [[2, 3]]);
  assert.deepEqual(d.prompts(), ["jar"], "prompts of detections, not of runs");
});

function newRun(f: number, prompt: string, region: readonly [number, number, number, number] | null = null) {
  return {
    run: run(f, prompt, region),
    t: f,
    instances: [instance([0, 0, 10, 10])],
    embs: [emb(0)],
    presence: 0.5,
    heatmap: null,
  };
}

test("load: counters continue above every id and every reserved counter", () => {
  const d = createDetections({
    detections: [det("0.3"), det("0.1"), det("1.0")],
    runs: [],
    reserved: new Map([
      [frame(1), 5],
      [frame(4), 2],
    ]),
  });
  assert.deepEqual(
    [...d.counters([frame(0), frame(1), frame(2), frame(4)])],
    [
      [0, 4],
      [1, 5],
      [4, 2],
    ],
  );
  assert.deepEqual(ids(okv(d.mint(newRun(4, "jar"))).detections), ["4.2"]);
  assert.deepEqual(ids(d.all()), ["0.3", "0.1", "1.0", "4.2"], "insertion order: loaded, then minted");
});

test("get/has: malformed and unknown ids are no-detection", () => {
  const d = createDetections({ detections: [det("0.0")], runs: [], reserved: new Map() });
  assert.equal(okv(d.get("0.0")).id, "0.0");
  for (const id of ["0.1", "x", "", "0.0.0", "o1"]) {
    assert.deepEqual(errv(d.get(id)), { kind: "no-detection", id });
    assert.equal(d.has(id), false);
  }
});

test("runs sorted by frame then label, filtered by label", () => {
  const d = createDetections({
    detections: [det("1.0"), det("0.0")],
    runs: [
      { ...run(1, "jar"), ids: [], presence: 0.2, heatmap: null },
      { ...run(0, "jar", [1, 2, 30, 40]), ids: [], presence: 0.4, heatmap: null },
      { ...run(0, "jar"), ids: [], presence: 0.3, heatmap: null },
      { ...run(0, "box"), ids: [], presence: 0.3, heatmap: null },
    ],
    reserved: new Map(),
  });
  assert.deepEqual(
    d.runs().map((r) => [r.frame, runLabel(r)]),
    [
      [0, "box"],
      [0, "jar"],
      [0, "jar@1,2,30,40"],
      [1, "jar"],
    ],
  );
  assert.deepEqual(
    d.runs({ prompt: "jar", frames: new Set([frame(0)]) }).map(runLabel),
    ["jar"],
    "a prompt filter leaves region runs out",
  );
});

test("drop: detections and runs of the frames go, counters stay, revival continues the numbering", () => {
  const d = empty();
  okv(
    d.mint({
      ...newRun(6, "mug"),
      instances: [instance([0, 0, 4, 4]), instance([5, 5, 9, 9])],
      embs: [emb(0), emb(1)],
    }),
  );
  okv(d.mint(newRun(7, "mug")));
  okv(d.mint(newRun(8, "mug")));
  const dropped = d.drop([frame(6), frame(7)]);
  assert.deepEqual(ids(dropped.detections), ["6.0", "6.1", "7.0"]);
  assert.deepEqual(
    dropped.runs.map((r) => r.frame),
    [6, 7],
  );
  assert.deepEqual(
    [...dropped.counters],
    [
      [6, 2],
      [7, 1],
    ],
  );
  assert.deepEqual(ids(d.all()), ["8.0"]);
  assert.equal(d.run(run(6, "mug")), undefined);
  // after a revive the same run mints again, and its ids continue where the frame left off
  assert.deepEqual(ids(okv(d.mint(newRun(6, "mug"))).detections), ["6.2"]);
  // a new instance with the tombstone's counters, as on reopen, does the same
  const reopened = createDetections({ detections: [], runs: [], reserved: dropped.counters });
  assert.deepEqual(ids(okv(reopened.mint(newRun(7, "mug"))).detections), ["7.1"]);
});

test("aliases / expand / collapse: same-frame overlap above aliasIou, any run", () => {
  const a = det("0.0", { box: [0, 0, 10, 10], score: 0.9 });
  const b = det("0.1", { box: [0, 0, 10, 9], score: 0.95, prompt: "container" }); // IoU 0.9
  const c = det("0.2", { box: [0, 0, 10, 5], score: 0.99, prompt: "lid", region: [0, 0, 50, 50] }); // IoU 0.5
  const other = det("1.0", { box: [0, 0, 10, 10] }); // same box, other frame
  const d = createDetections({ detections: [a, b, c, other], runs: [], reserved: new Map() });
  assert.deepEqual(ids(d.aliases(a, 0.7)), ["0.1"]);
  assert.deepEqual(ids(d.aliases(a, 0.4)), ["0.1", "0.2"], "a region-search hit aliases a find hit");
  assert.deepEqual(okv(d.expand(["0.1", "0.0", "1.0"], 0.7)), ["0.1", "0.0", "1.0"]);
  assert.deepEqual(okv(d.expand(["0.0"], 0.4)), ["0.0", "0.1", "0.2"]);
  assert.deepEqual(errv(d.expand(["0.0", "9.9", "bad"], 0.7)), { kind: "no-detection", id: "9.9" });
  // the best score of each alias group, in frame order
  assert.deepEqual(ids(d.collapse([other, a, b, c], 0.7)), ["0.2", "0.1", "1.0"]);
  assert.deepEqual(ids(d.collapse([other, a, b, c], 0.4)), ["0.2", "1.0"]);
  assert.deepEqual(ids(d.collapse([a], 0.7)), ["0.0"], "aliases outside the input still exist, the input keeps a");
});

test("byFrame: each frame's detections in input order, whatever order the frames come in", () => {
  const input = [det("3.1"), det("1.0"), det("3.0"), det("2.0"), det("1.1"), det("3.2")];
  const d = createDetections({ detections: input, runs: [], reserved: new Map() });
  assert.deepEqual(ids(d.byFrame(frame(3))), ["3.1", "3.0", "3.2"]);
  assert.deepEqual(ids(d.byFrame(frame(1))), ["1.0", "1.1"]);
  assert.deepEqual(ids(d.byFrame(frame(2))), ["2.0"]);
  assert.deepEqual(ids(d.byFrame(frame(4))), []);
  assert.deepEqual(ids(d.all()), ids(input));
});

test("mint carries the instance's area (counted by perception), not a recount", () => {
  const d = empty();
  const inst = { ...instance([0, 0, 4, 4]), area: 7 };
  const m = okv(d.mint({ run: run(0, "jar"), t: 0, instances: [inst], embs: [emb(0)], presence: 1, heatmap: null }));
  assert.equal(m.detections[0]?.area, 7);
});

test("pure: frameOf/ordinalOf/compareDetIds, bestView, ranked, covered, rle", () => {
  const x = det("10.2");
  assert.equal(frameOf(x.id), 10);
  assert.equal(ordinalOf(x.id), 2);
  assert.deepEqual([det("2.10"), det("10.1"), det("2.9")].map((d) => d.id).sort(compareDetIds), [
    "2.9",
    "2.10",
    "10.1",
  ]);
  assert.deepEqual(ids([det("2.10"), det("10.1"), det("2.9"), det("1.0")].sort(compareDetections)), [
    "1.0",
    "2.9",
    "2.10",
    "10.1",
  ]);
  const small = det("0.0", { score: 1, box: [0, 0, 2, 2] }); // 1·2
  const big = det("0.1", { score: 0.5, box: [0, 0, 6, 6] }); // 0.5·6 = 3
  const tie = det("0.2", { score: 0.5, box: [0, 0, 6, 6] });
  assert.equal(bestView([small, big, tie])?.id, "0.1", "first of equals wins");
  assert.equal(bestView([]), null);
  const q = emb(0);
  const cands = [
    det("0.0", { emb: emb(1) }),
    det("1.0", { emb: emb(0, 1, 0.5) }),
    det("2.0", { emb: emb(0) }),
    det("3.0", { emb: emb(0) }),
  ];
  const top = ranked(cands, q, 3);
  assert.deepEqual(ids(top.map((r) => r.d)), ["2.0", "3.0", "1.0"]);
  assert.deepEqual(
    top.map((r) => r.sim),
    [2, 3, 1].map((i) => similarity(at(cands, i).emb, q)),
    "each with its similarity to q",
  );
  const m = covered([det("0.0", { box: [1, 0, 3, 2] }), det("0.1", { box: [2, 1, 4, 3] })], [3, 4]);
  assert.deepEqual([...m], [0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1]);
  assert.deepEqual(rle(Uint8Array.of(1, 1, 0, 1)), [0, 2, 1, 1]);
  assert.deepEqual(rle(Uint8Array.of(0, 0)), [2]);
  assert.deepEqual(rle(new Uint8Array(0)), [0]);
});

test("groups: average linkage within the window, never two of one frame, descending pair order", () => {
  // 0.0 and 1.1 look the same, 1.0 and 2.0 drift away from them, 3.0 looks different, 20.0 is outside the window
  const g = groups(
    [
      det("0.0", { emb: emb(0) }),
      det("1.0", { emb: emb(0, 1, 0.1) }),
      det("1.1", { emb: emb(0) }), // same frame as 1.0, so it can't join 1.0's group
      det("2.0", { emb: emb(0, 1, 0.2) }),
      det("3.0", { emb: emb(5) }),
      det("20.0", { emb: emb(0) }), // outside the window
    ],
    0.65,
    8,
  );
  assert.deepEqual(
    g.map((x) => ids(x)),
    // 0.0~1.1 (1) links first, then 1.0~2.0 (0.9952) before 0.0~1.0 (0.9950). The groups {0.0, 1.1} and {1.0, 2.0}
    // then share frame 1
    [["0.0", "1.1"], ["1.0", "2.0"], ["3.0"], ["20.0"]],
  );
  // with equal similarities, pairs link in descending (sim, a, b) order, so the later pair wins the contested frame
  const tie = groups([det("0.0"), det("1.0"), det("1.1")], 0.5, 8);
  assert.deepEqual(
    tie.map((x) => ids(x)),
    [["0.0", "1.1"], ["1.0"]],
  );
  assert.deepEqual(groups([], 0.5, 8), []);
  // average linkage doesn't merge a chain where a matches b and b matches c but a doesn't match c.
  // The similarities are equal, so the later pair b, c links first.
  const chain = groups(
    [det("0.0", { emb: emb(0) }), det("1.0", { emb: emb(0, 1, 1) }), det("2.0", { emb: emb(1) })],
    0.7,
    8,
  );
  assert.deepEqual(
    chain.map((x) => ids(x)),
    [["0.0"], ["1.0", "2.0"]],
  );
});
