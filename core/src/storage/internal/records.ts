/**
 * The record files (dets.json, dets/<id>.npz, runs.json, objects.json), decoded into the domain's shapes and
 * encoded back to the same bytes.
 */
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import type { DetId, Detection, RunRecord } from "../../detections/pure.ts";
import { isDetId, runLabel } from "../../detections/pure.ts";
import type { Obj, Objects, Owner } from "../../labelling/pure.ts";
import { REJECT, REJECT_LABEL, isOwner } from "../../labelling/pure.ts";
import { isAppearance } from "../../perception/pure.ts";
import { f16ToF32, f32ToF16, maskArea, type Box } from "../../pixels/index.ts";
import type { FrameNo } from "../../video/pure.ts";
import { isFrameNo } from "../../video/pure.ts";
import type { StorageError } from "../types.ts";
import { asHeatmapRef } from "./keys.ts";
import { issues } from "./json.ts";
import type { NpyArray } from "./npz.kernel.ts";
import { packbits, readNpz, unpackbits, writeNpz } from "./npz.kernel.ts";

const bad = (file: string, message: string): StorageError => ({ kind: "bad-record", file, message });

const detId = z.custom<DetId>((v) => typeof v === "string" && isDetId(v), "not a detection id (frame.n)");
const frameNo = z.custom<FrameNo>((v) => typeof v === "number" && isFrameNo(v), "not a frame number");
const box = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const DetMetaSchema = z.object({
  id: detId,
  frame: frameNo,
  t: z.number(),
  run: z.string(),
  prompt: z.string(),
  score: z.number(),
  box,
});
export type DetMeta = z.infer<typeof DetMetaSchema>;

const parse = <T>(schema: z.ZodType<T>, file: string, v: unknown): Result<T, StorageError> => {
  const r = schema.safeParse(v);
  return r.success ? ok(r.data) : err(bad(file, issues(r.error)));
};

export const decodeDetIndex = (v: unknown): Result<readonly DetMeta[], StorageError> =>
  parse(z.array(DetMetaSchema), "dets.json", v);

const REGION = /^(\d+),(\d+),(\d+),(\d+)$/;
const regionOf = (s: string): Box | null => {
  const m = REGION.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
};

/** Splits a run label into its prompt and region. */
const parseLabel = (label: string): { readonly prompt: string; readonly region: Box | null } => {
  const at = label.lastIndexOf("@");
  const region = at < 0 ? null : regionOf(label.slice(at + 1));
  return region === null ? { prompt: label, region: null } : { prompt: label.slice(0, at), region };
};

/** A detection's region from its `run` string, or an error message if the string isn't a run label of its prompt. */
const detRegion = (m: DetMeta): Result<Box | null, string> => {
  if (m.run === m.prompt) return ok(null);
  const region = m.run.startsWith(`${m.prompt}@`) ? regionOf(m.run.slice(m.prompt.length + 1)) : null;
  return region === null
    ? err(`run ${JSON.stringify(m.run)} is not a run of prompt ${JSON.stringify(m.prompt)}`)
    : ok(region);
};

/** A detection from its dets.json entry and npz bytes. mask is |u1 packbits, emb is <f2. */
export function decodeDetection(m: DetMeta, npz: Uint8Array): Result<Detection, StorageError> {
  const file = `dets/${m.id}.npz`;
  const region = detRegion(m);
  if (region.isErr()) return err(bad("dets.json", `${m.id}: ${region.error}`));
  const z0 = readNpz(npz);
  if (z0.isErr()) return err(bad(file, z0.error));
  const arrays = z0.value;
  const zMask = arrays.get("mask");
  const zEmb = arrays.get("emb");
  if (!zMask || !(zMask.data instanceof Uint8Array)) return err(bad(file, "no mask (|u1)"));
  if (!zEmb) return err(bad(file, "no emb"));
  const [x0, y0, x1, y1] = m.box;
  const n = Math.max(0, y1 - y0) * Math.max(0, x1 - x0);
  if (zMask.data.length * 8 < n) return err(bad(file, `mask has ${zMask.data.length * 8} bits, box needs ${n}`));
  if (!(zEmb.data instanceof Uint16Array)) return err(bad(file, `emb dtype ${zEmb.dtype} not supported`));
  const emb = f16ToF32(zEmb.data);
  if (!isAppearance(emb)) return err(bad(file, `emb has ${emb.length} values`));
  const mask = unpackbits(zMask.data, n);
  return ok({
    id: m.id,
    frame: m.frame,
    t: m.t,
    prompt: m.prompt,
    region: region.value,
    score: m.score,
    box: m.box,
    mask,
    area: maskArea(mask),
    emb,
  });
}

/**
 * dets/<id>.npz holds mask (packbits of the box-sized mask), emb (float16) and dino, an int64 scalar that is always 2.
 * The reader checks mask and emb only.
 */
export const encodeDetection = (d: Detection, ms: number): Uint8Array => {
  const arrays: ReadonlyArray<readonly [string, NpyArray]> = [
    ["mask", { dtype: "|u1", shape: [Math.ceil(d.mask.length / 8)], data: packbits(d.mask) }],
    ["emb", { dtype: "<f2", shape: [d.emb.length], data: f32ToF16(d.emb) }],
    ["dino", { dtype: "<i8", shape: [], data: BigInt64Array.of(2n) }],
  ];
  return writeNpz(arrays, ms);
};

const round3 = (x: number): number => Math.round(x * 10 ** 3) / 10 ** 3;

/** dets.json entries, with keys in the order id, frame, t, run, prompt, score (3 decimals), box. */
export const encodeDetIndex = (ds: readonly Detection[]): readonly object[] =>
  ds.map((d) => ({
    id: d.id,
    frame: d.frame,
    t: d.t,
    run: runLabel(d),
    prompt: d.prompt,
    score: round3(d.score),
    box: d.box,
  }));

const RunSchema = z.object({
  ids: z.array(detId),
  presence: z.number(),
  sem: z.string().nullable(),
});
const RunsSchema = z.record(z.string(), RunSchema);

export function decodeRuns(v: unknown): Result<readonly RunRecord[], StorageError> {
  return parse(RunsSchema, "runs.json", v).andThen((runs) =>
    Result.combine(
      Object.entries(runs).map(([key, r]): Result<RunRecord, StorageError> => {
        const k = key.indexOf("|");
        const frame = k > 0 && /^\d+$/.test(key.slice(0, k)) ? Number(key.slice(0, k)) : NaN;
        if (!isFrameNo(frame)) return err(bad("runs.json", `bad run key ${JSON.stringify(key)}`));
        const heatmap = r.sem === null ? null : asHeatmapRef(r.sem);
        if (r.sem && heatmap === null) return err(bad("runs.json", `bad heatmap name ${JSON.stringify(r.sem)}`));
        return ok({ frame, ...parseLabel(key.slice(k + 1)), ids: r.ids, presence: r.presence, heatmap });
      }),
    ),
  );
}

/** runs.json as {"frame|label": {ids, presence, sem}}, in the given order. */
export const encodeRuns = (runs: readonly RunRecord[]): object =>
  Object.fromEntries(
    runs.map((r) => [`${r.frame}|${runLabel(r)}`, { ids: r.ids, presence: r.presence, sem: r.heatmap }] as const),
  );

const owner = z.custom<Owner>((v) => typeof v === "string" && isOwner(v), "not an object id (o<n> or x)");
const ObjectsSchema = z.record(owner, z.object({ label: z.string(), members: z.array(detId) }));

/** objects.json in file order. A missing reject set (a new session has no objects.json) is added at the end. */
export const decodeObjects = (v: unknown): Result<Objects, StorageError> =>
  parse(ObjectsSchema, "objects.json", v).map((o) => {
    const m = new Map<Owner, Obj>(Object.entries(o).flatMap(([k, x]) => (isOwner(k) ? [[k, x] as const] : [])));
    return m.has(REJECT) ? m : new Map([...m, [REJECT, { label: REJECT_LABEL, members: [] }]]);
  });

export const encodeObjects = (o: Objects): object =>
  Object.fromEntries([...o].map(([k, x]) => [k, { label: x.label, members: x.members }] as const));
