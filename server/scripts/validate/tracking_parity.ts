/**
 * Runs the tracking module on the real graphs over stored trunks and compares its masks with PyTorch's: upstream's
 * Sam3VideoModel with num_maskmem 3 on the same trunks and seeds, forward and in reverse.
 *
 *   EYESPY_MODELS=scratch/models-tracker server/scripts/validate/gpu.sh server/scripts/validate/tracking_parity.ts \
 *     [--precision fp32|fp16] [--device webgpu|cpu] [--data DIR] [--min 0.99]
 *
 * --data defaults to scratch/tracker, the tracker spike's folder. It holds data/produce/trunk/NNNN.f16 (TRUNK_LEN fp16
 * values), data/produce/det/zucchini/NNNN.u8 (288² masks, one after another) and the PyTorch runs, whose TTTT_J.f32 are
 * 288² logits at step T for seed J: data/run/s3_pt_m3 (forward, from `pt_track.py produce zucchini onnx s3_pt_m3
 * 20,...,43 12,4,6,19 2`) and street/s17_bwd_parity/run/pt_bwd (reverse, from `pt_bwd.py`). Exits 1 if the worst IoU is
 * below --min.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ResultAsync } from "neverthrow";
import { composeTracking } from "eyespy-core/compose";
import { startTrack, type TrackDirection, type TrackMemory } from "eyespy-core/tracking/pure";
import { OrtRuntime } from "../../src/adapters/ort.ts";
import { MODELS, scratch } from "./paths.ts";

const flag = (name: string, fallback: string): string => {
  const k = process.argv.indexOf(`--${name}`);
  return k > 0 ? (process.argv[k + 1] ?? fallback) : fallback;
};
const precision = flag("precision", "fp32") === "fp16" ? "fp16" : "fp32";
const device = flag("device", "webgpu") === "cpu" ? "cpu" : "webgpu";
const DATA = flag("data", scratch("tracker"));
const MIN = Number(flag("min", "0.99"));

const CLIP = "produce";
const PROMPT = "zucchini";
const MASK = 288 * 288;

type Case = {
  readonly name: string;
  readonly direction: TrackDirection;
  /** The frames on the tracking grid, in time order. */
  readonly grid: readonly number[];
  /** The seed's frame, and the seeds as indices into its detector file. */
  readonly seedFrame: number;
  readonly seeds: readonly number[];
  readonly ref: string;
};

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
const CASES: readonly Case[] = [
  {
    name: "forward",
    direction: "forward",
    grid: range(20, 43),
    seedFrame: 20,
    seeds: [12, 4, 6, 19],
    ref: path.join(DATA, "data/run/s3_pt_m3"),
  },
  {
    name: "reverse",
    direction: "reverse",
    grid: range(43, 66),
    seedFrame: 66,
    seeds: [5, 7, 0, 14],
    ref: path.join(DATA, "street/s17_bwd_parity/run/pt_bwd"),
  },
];

const name4 = (f: number) => String(f).padStart(4, "0");
const bytes = (file: string): Buffer => readFileSync(file);
const view = <T>(b: Buffer, make: (buf: ArrayBuffer, off: number, len: number) => T, size: number): T => {
  const copy = new ArrayBuffer(b.length);
  new Uint8Array(copy).set(b);
  return make(copy, 0, b.length / size);
};
const f32File = (file: string) => view(bytes(file), (a, o, l) => new Float32Array(a, o, l), 4);
const trunkOf = (f: number) =>
  view(bytes(path.join(DATA, "data", CLIP, "trunk", `${name4(f)}.f16`)), (a, o, l) => new Uint16Array(a, o, l), 2);

function iou(a: Float32Array, b: Float32Array): number {
  let both = 0,
    either = 0;
  for (let i = 0; i < MASK; i++) {
    const x = (a[i] ?? 0) > 0,
      y = (b[i] ?? 0) > 0;
    if (x && y) both++;
    if (x || y) either++;
  }
  return either ? both / either : 1;
}

const areaOf = (a: Float32Array) => a.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, k) => Math.max(m, Math.abs(v - (b[k] ?? 0))), 0);

const unwrap = async <T, E>(r: ResultAsync<T, E>): Promise<T> => {
  const v = await r;
  if (v.isErr()) throw new Error(JSON.stringify(v.error));
  return v.value;
};

const rt = new OrtRuntime(MODELS, device);
const tracker = composeTracking(
  {
    runtime: rt,
    clock: { now: () => Date.now() },
    logger: { log: (...a) => console.log(...a) },
  },
  { precision },
);

console.log(`models ${MODELS}, ${precision}, ${device}`);
let worst = 1;
for (const c of CASES) {
  const masks = bytes(path.join(DATA, "data", CLIP, "det", PROMPT, `${name4(c.seedFrame)}.u8`));
  const steps = c.direction === "forward" ? c.grid : c.grid.toReversed();
  const frameAt = (f: number) => c.grid.indexOf(f);
  const first = await unwrap(tracker.frame(trunkOf(c.seedFrame)));
  const tracks = new Map<number, TrackMemory>();
  for (const j of c.seeds) {
    const mask = new Uint8Array(masks.subarray(j * MASK, (j + 1) * MASK));
    const seed = await unwrap(tracker.seed(first, mask, frameAt(c.seedFrame), c.grid.length));
    tracks.set(j, startTrack(seed, c.direction));
    const ref = path.join(c.ref, `0000_${j}.ptr.f32`);
    if (existsSync(ref)) console.log(`seed ${j} pointer max|diff| ${maxDiff(seed.pointer, f32File(ref)).toFixed(4)}`);
  }
  const lowest: { step: number; j: number; iou: number; area: number; score: number; pointer: number }[] = [];
  const ious: number[] = [];
  const perSeed = new Map<number, number>();
  const pointerDiff = { max: 0, n: 0 };
  const t0 = Date.now();
  for (let step = 1; step < steps.length; step++) {
    const f = steps[step] ?? 0;
    const frame = await unwrap(tracker.frame(trunkOf(f)));
    for (const j of c.seeds) {
      const r = await unwrap(tracker.propagate(frame, tracks.get(j) as TrackMemory, frameAt(f)));
      tracks.set(j, r.memory);
      const base = path.join(c.ref, `${name4(step)}_${j}`);
      const ref = f32File(`${base}.f32`);
      const v = iou(r.logits, ref);
      ious.push(v);
      perSeed.set(j, Math.min(perSeed.get(j) ?? 1, v));
      const newest = r.memory.recent.at(-1);
      const pointer = newest && existsSync(`${base}.ptr.f32`) ? maxDiff(newest.pointer, f32File(`${base}.ptr.f32`)) : 0;
      pointerDiff.max = Math.max(pointerDiff.max, pointer);
      pointerDiff.n += newest && existsSync(`${base}.ptr.f32`) ? 1 : 0;
      lowest.push({
        step,
        j,
        iou: +v.toFixed(4),
        area: areaOf(ref),
        score: +r.score.toFixed(2),
        pointer: +pointer.toFixed(4),
      });
    }
  }
  const low = Math.min(...ious);
  console.log("lowest", JSON.stringify(lowest.toSorted((a, b) => a.iou - b.iou).slice(0, 6)));
  worst = Math.min(worst, low);
  const mean = ious.reduce((a, b) => a + b, 0) / ious.length;
  console.log(
    `${c.name}: n=${ious.length} worst IoU ${low.toFixed(4)} mean ${mean.toFixed(5)} below ${MIN}: ` +
      `${ious.filter((v) => v < MIN).length}, per seed ${JSON.stringify([...perSeed].map(([j, v]) => [j, +v.toFixed(4)]))}` +
      (pointerDiff.n ? `, pointer max|diff| ${pointerDiff.max.toFixed(4)} over ${pointerDiff.n}` : "") +
      ` (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
}
console.log(`worst IoU ${worst.toFixed(4)}, need ${MIN}`);
process.exit(worst >= MIN ? 0 : 1);
