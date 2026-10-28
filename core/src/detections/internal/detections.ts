/** The Detections instance. mint and drop replace its maps instead of changing them. */
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import { at, got, invariant } from "../../invariant/index.ts";
import { maskIou } from "../../pixels/index.ts";
import type { FrameNo } from "../../video/pure.ts";
import type { DetId, Detection, Run, RunRecord } from "../pure.ts";
import { bestView, detId, fromInstance, isDetId, ordinalOf, runLabel } from "../pure.ts";
import type {
  CreateDetections,
  Detections,
  DetectionsError,
  DetectionsOptions,
  Dropped,
  Minted,
  NewRun,
  RunFilter,
} from "../types.ts";

/** The run index key. It never leaves the instance. */
const runKey = (r: Run): string => `${r.frame}|${runLabel(r)}`;

/** Frame order, then runLabel by UTF-16 code units (the data.runs order). */
const compareRuns = (a: RunRecord, b: RunRecord): number => {
  if (a.frame !== b.frame) return a.frame - b.frame;
  const la = runLabel(a),
    lb = runLabel(b);
  return la < lb ? -1 : la > lb ? 1 : 0;
};

/** Consecutive runs of equal keys, in order. */
const chunks = <T>(xs: readonly T[], same: (a: T, b: T) => boolean): readonly (readonly T[])[] => {
  const starts = xs.flatMap((x, i) => (i === 0 || !same(at(xs, i - 1), x) ? [i] : []));
  return starts.map((s, k) => xs.slice(s, starts[k + 1] ?? xs.length));
};

/** Detections by frame, each list in input order. A stable sort and one pass avoid the O(F·N) of a filter per frame. */
const byFrameIndex = (dets: readonly Detection[]): ReadonlyMap<FrameNo, readonly Detection[]> =>
  new Map(
    chunks(
      dets.toSorted((a, b) => a.frame - b.frame),
      (a, b) => a.frame === b.frame,
    ).map((c) => [at(c, 0).frame, c]),
  );

/** Counters from the ids themselves (n + 1), raised to the reserved ones where those are higher. */
const initialCounters = (
  dets: readonly Detection[],
  reserved: ReadonlyMap<FrameNo, number>,
): ReadonlyMap<FrameNo, number> => {
  const fromIds = byFrameIndex(dets);
  const frames = [...new Set([...fromIds.keys(), ...reserved.keys()])];
  return new Map(
    frames.map((f) => [
      f,
      Math.max(0, reserved.get(f) ?? 0, ...(fromIds.get(f) ?? []).map((d) => ordinalOf(d.id) + 1)),
    ]),
  );
};

class DetectionIndex implements Detections {
  private ids: ReadonlyMap<DetId, Detection>;
  private frames: ReadonlyMap<FrameNo, readonly Detection[]>;
  private runIndex: ReadonlyMap<string, RunRecord>;
  private next: ReadonlyMap<FrameNo, number>;

  constructor(opts: DetectionsOptions) {
    this.ids = new Map(opts.detections.map((d) => [d.id, d]));
    this.frames = byFrameIndex([...this.ids.values()]);
    this.runIndex = new Map(opts.runs.map((r) => [runKey(r), r]));
    this.next = initialCounters(opts.detections, opts.reserved);
  }

  mint(n: NewRun): Result<Minted, DetectionsError> {
    const { run } = n;
    if (this.runIndex.has(runKey(run))) return err({ kind: "run-exists", run });
    invariant(
      n.instances.length === n.embs.length,
      () => `mint: ${n.instances.length} instances, ${n.embs.length} embs`,
    );
    const first = this.next.get(run.frame) ?? 0;
    const fresh = n.instances.map((inst, k): Detection => ({
      id: detId(run.frame, first + k),
      frame: run.frame,
      t: n.t,
      prompt: run.prompt,
      region: run.region,
      ...fromInstance(inst),
      emb: at(n.embs, k),
    }));
    const record: RunRecord = {
      frame: run.frame,
      prompt: run.prompt,
      region: run.region,
      ids: fresh.map((d) => d.id),
      presence: n.presence,
      heatmap: n.heatmap,
    };
    this.ids = new Map([...this.ids, ...fresh.map((d) => [d.id, d] as const)]);
    this.frames = new Map([...this.frames, [run.frame, [...this.byFrame(run.frame), ...fresh]]]);
    this.runIndex = new Map([...this.runIndex, [runKey(run), record]]);
    if (fresh.length) this.next = new Map([...this.next, [run.frame, first + fresh.length]]);
    return ok({ detections: fresh, run: record });
  }

  run(key: Run): RunRecord | undefined {
    return this.runIndex.get(runKey(key));
  }

  runs(filter: RunFilter = {}): readonly RunRecord[] {
    const { frames, prompt } = filter;
    return [...this.runIndex.values()]
      .filter((r) => (!frames || frames.has(r.frame)) && (!prompt || runLabel(r) === prompt))
      .sort(compareRuns);
  }

  recorded(): readonly RunRecord[] {
    return [...this.runIndex.values()];
  }

  get(id: string): Result<Detection, DetectionsError> {
    const d = isDetId(id) ? this.ids.get(id) : undefined;
    return d === undefined ? err({ kind: "no-detection", id }) : ok(d);
  }

  has(id: string): boolean {
    return isDetId(id) && this.ids.has(id);
  }

  all(): readonly Detection[] {
    return [...this.ids.values()];
  }

  byFrame(i: FrameNo): readonly Detection[] {
    return this.frames.get(i) ?? [];
  }

  inFrames(frames: ReadonlySet<FrameNo>): readonly Detection[] {
    return this.all().filter((d) => frames.has(d.frame));
  }

  prompts(): readonly string[] {
    return [...new Set(this.all().map((d) => d.prompt))].sort();
  }

  size(): number {
    return this.ids.size;
  }

  counters(frames: readonly FrameNo[]): ReadonlyMap<FrameNo, number> {
    return new Map(frames.filter((f) => this.next.has(f)).map((f) => [f, got(this.next, f)]));
  }

  drop(frames: readonly FrameNo[]): Dropped {
    const fs = new Set(frames);
    const dropped: Dropped = {
      detections: this.inFrames(fs),
      runs: this.runs({ frames: fs }),
      counters: this.counters(frames),
    };
    this.ids = new Map([...this.ids].filter(([, d]) => !fs.has(d.frame)));
    this.frames = new Map([...this.frames].filter(([f]) => !fs.has(f)));
    this.runIndex = new Map([...this.runIndex].filter(([, r]) => !fs.has(r.frame)));
    return dropped;
  }

  aliases(d: Detection, aliasIou: number): readonly Detection[] {
    return this.byFrame(d.frame).filter((o) => o.id !== d.id && maskIou(d, o) > aliasIou);
  }

  expand(ids: readonly string[], aliasIou: number): Result<readonly DetId[], DetectionsError> {
    const known = ids.flatMap((id) => (isDetId(id) && this.ids.has(id) ? [got(this.ids, id)] : []));
    const missing = ids.find((id) => !this.has(id));
    if (missing !== undefined) return err({ kind: "no-detection", id: missing });
    const all = known.flatMap((d) => [d.id, ...this.aliases(d, aliasIou).map((a) => a.id)]);
    return ok([...new Set(all)]);
  }

  collapse(dets: readonly Detection[], aliasIou: number): readonly Detection[] {
    const sorted = [...dets].sort((a, b) => a.frame - b.frame || b.score - a.score);
    // Aliases share a frame, so collapse each frame on its own.
    return chunks(sorted, (a, b) => a.frame === b.frame).flatMap(
      (frame) =>
        frame.reduce<{ readonly kept: readonly Detection[]; readonly seen: ReadonlySet<DetId> }>(
          (acc, d) =>
            acc.seen.has(d.id)
              ? acc
              : {
                  kept: [...acc.kept, d],
                  seen: new Set([...acc.seen, ...this.aliases(d, aliasIou).map((a) => a.id)]),
                },
          { kept: [], seen: new Set() },
        ).kept,
    );
  }

  bestView(dets: readonly Detection[]): Detection | null {
    return bestView(dets);
  }
}

export const createDetections: CreateDetections = (opts) => new DetectionIndex(opts);
