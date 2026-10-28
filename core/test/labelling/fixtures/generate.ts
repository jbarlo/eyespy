/**
 * Writes session-ops.json, the detections of the session.ops snapshot, so the replay test can rebuild them without
 * a session. Runs the same detection-producing ops in the same order and dumps
 *   base   every detection and run before the first obj op
 *   extra  the runs the extra clip's finds add, in creation order
 *   revive the runs the revived clip's find adds
 * Rerun when the fakes or the snapshot's find ops change (prettier formats the output):
 *   node --import tsx core/test/labelling/fixtures/generate.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { okAsync } from "neverthrow";
import { createCaller } from "../../../src/api/index.ts";
import type { Detection, RunRecord } from "../../../src/detections/index.ts";
import { createDetections } from "../../../src/detections/index.ts";
import { runLabel } from "../../../src/detections/pure.ts";
import { createLabelling } from "../../../src/labelling/index.ts";
import { createPerception } from "../../../src/perception/index.ts";
import { createRenderer } from "../../../src/render/index.ts";
import { createEngine, createSession } from "../../../src/session/index.ts";
import { createSessionFolder } from "../../../src/storage/index.ts";
import { createVideo } from "../../../src/video/index.ts";
import { newHost } from "../../compose.ts";
import { EXTRA } from "../../fakes/index.ts";
import type { FakeHost } from "../../fakes/index.ts";

const b64 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");

function rle(m: Uint8Array): number[] {
  const out: number[] = [];
  let cur = 0,
    n = 0;
  for (const x of m) {
    const v = x ? 1 : 0;
    if (v === cur) n++;
    else {
      out.push(n);
      cur = v;
      n = 1;
    }
  }
  out.push(n);
  return out;
}

const detRecord = (d: Detection) => ({
  id: d.id,
  frame: d.frame,
  t: d.t,
  prompt: d.prompt,
  region: d.region,
  score: d.score,
  box: d.box,
  mask: rle(d.mask),
  emb: b64(d.emb),
});

const key = (r: RunRecord) => `${r.frame}|${runLabel(r)}`;
const runRecord = (r: RunRecord) => ({ key: key(r), ids: r.ids, presence: r.presence, heatmap: r.heatmap });

/**
 * The engine's wiring, kept local so the generator holds the detections instance (in-memory values: full-precision
 * scores and float32 embeddings, which the files round).
 */
async function open(host: FakeHost) {
  const { store, clock, timers, logger, codec, models: runtime, video: source } = host;
  const folder = createSessionFolder({ store, clock });
  const records = (await folder.open())._unsafeUnwrap();
  const video = createVideo({ source, frames: folder.frames, decoder: codec, clock, logger }, { clips: [] });
  const perception = createPerception(
    { runtime, features: folder.features, frames: video, clock, logger },
    { detector: "fp32", persistFeatures: false, featureCacheMB: 640, storedFeatureFormat: null },
  );
  const detections = createDetections({ detections: [], runs: [], reserved: new Map() });
  const labelling = createLabelling(
    { detections, log: folder.labels },
    { objects: records.objects, history: [], nextObj: 1 },
  );
  const session = (
    await createSession(
      {
        modules: { video, perception, detections, labelling, render: createRenderer({ frames: video, text: codec }) },
        stores: {
          meta: folder.meta,
          detections: folder.detections,
          heatmaps: folder.heatmaps,
          outputs: folder.outputs,
          frameFiles: folder.frames,
          featureBytes: (r) => folder.features.size(r),
          removeClipFiles: (k) => folder.removeClipFiles(k),
        },
        host: { codec, clock, logger, info: {}, root: folder.root },
      },
      records.meta,
      {},
    )
  )._unsafeUnwrap();
  const engine = createEngine(session, { clock, logger, timers }, { onExit: () => {} });
  const settle = async () => {
    while ((await engine.call(undefined, (s) => okAsync(s.pending().length)))._unsafeUnwrap())
      await new Promise((r) => setTimeout(r, 2));
  };
  return { caller: createCaller({ engine }), engine, detections, settle };
}

async function main() {
  const o = await open(newHost());
  const c = o.caller;
  const state = () => ({ detections: o.detections.all(), runs: o.detections.recorded() });
  try {
    await c.add({ video: "kitchen.mp4" });
    await c.add({ video: "/videos/pantry.mov" });
    await c.config({ key: "group_sim", value: "0.6" });
    await c.find({ prompt: "jar" });
    await c.find({ prompt: "container", crops: true });
    await c.find({ prompt: "box", frames: "3-5" });
    await c.find({ prompt: "lid", frames: 0 });
    await c.find({ prompt: "Glass  JAR", frames: "0" });
    const regionBox: [number, number, number, number] = [10, 20, 90, 90];
    await c.search({ frame: 1, box: regionBox, prompt: "jar" });
    await c.search({ frame: 4, box: regionBox, prompt: "teapot", similar: false });
    await c.semantic({ prompt: "mug", frames: "0" });
    await o.settle();
    const s = state();
    const base = { detections: s.detections.map(detRecord), runs: s.runs.map(runRecord) };

    const newRuns = async (fn: () => Promise<unknown>) => {
      const before = new Set(state().runs.map(key));
      await fn();
      await o.settle();
      const after = state();
      const byId = new Map(after.detections.map((d) => [d.id, d]));
      return after.runs
        .filter((r) => !before.has(key(r)))
        .map((r) => ({
          ...runRecord(r),
          detections: r.ids.map((id) => {
            const d = byId.get(id);
            if (!d) throw new Error(`no det ${id}`);
            return detRecord(d);
          }),
        }));
    };
    await c.add({ video: EXTRA });
    const extra = await newRuns(async () => {
      await c.find({ prompt: "mug" });
      await c.find({ prompt: "jar", frames: "6-9", threshold: 0.3 });
    });
    await c.clips.remove({ clip: "extra.mp4" });
    await c.add({ video: "extra.mp4" });
    const revive = await newRuns(() => c.find({ prompt: "mug", frames: "6-9" }));
    const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "session-ops.json");
    writeFileSync(out, JSON.stringify({ base, extra, revive }) + "\n");
    console.log(`wrote ${out}: ${base.detections.length} detections, ${extra.length} + ${revive.length} runs`);
  } finally {
    o.engine.shutdown();
  }
}

await main();
