import type { Result } from "neverthrow";
import type { Appearance, Instance } from "../perception/pure.ts";
import type { FrameNo } from "../video/pure.ts";
import type { DetId, Detection, HeatmapRef, Run, RunRecord } from "./pure.ts";

export type DetectionsOptions = {
  /** As loaded, in file order (dets.json). */
  readonly detections: readonly Detection[];
  readonly runs: readonly RunRecord[];
  /** Per-frame counters to continue from (the clips' `reserved`). The ids themselves also raise the floor. */
  readonly reserved: ReadonlyMap<FrameNo, number>;
};

export type DetectionsError =
  { readonly kind: "no-detection"; readonly id: string } | { readonly kind: "run-exists"; readonly run: Run };

/** A finished detector call to record. It has instances in frame coordinates and their embeddings in the same order. */
export type NewRun = {
  readonly run: Run;
  /** The frame's time. */
  readonly t: number;
  /** In Detected order. Each one gets the next id, in this order. */
  readonly instances: readonly Instance[];
  readonly embs: readonly Appearance[];
  readonly presence: number;
  readonly heatmap: HeatmapRef | null;
};
export type Minted = { readonly detections: readonly Detection[]; readonly run: RunRecord };

/** What `drop` removed, so the session can delete files and tombstone counters. */
export type Dropped = {
  /** Insertion order. */
  readonly detections: readonly Detection[];
  /** Frame order, then runLabel order. */
  readonly runs: readonly RunRecord[];
  /** next_n for each dropped frame with a counter (the tombstone's `reserved`), as before the drop. */
  readonly counters: ReadonlyMap<FrameNo, number>;
};

/** `prompt` matches the run's runLabel, so "jar" leaves out region runs like "jar@x0,y0,x1,y1", as data.runs does. */
export type RunFilter = { readonly frames?: ReadonlySet<FrameNo> | null; readonly prompt?: string | null };

/** The instance holds state, but every value it returns is immutable. `all()` gives loaded order, then minted order. */
export interface Detections {
  /** The only place that allocates ids, as `frame.n` from the frame's counter. Err if the run is already recorded. */
  mint(n: NewRun): Result<Minted, DetectionsError>;
  run(key: Run): RunRecord | undefined;
  /** Frame order, then prompt (runLabel) order. */
  runs(filter?: RunFilter): readonly RunRecord[];
  /**
   * Every run in record order: loaded, then minted. Persisting runs in this order keeps runs.json's key order.
   */
  recorded(): readonly RunRecord[];
  /** Takes any string. A malformed or unknown id gives `no-detection`. */
  get(id: string): Result<Detection, DetectionsError>;
  has(id: string): boolean;
  all(): readonly Detection[];
  /** Insertion order. */
  byFrame(i: FrameNo): readonly Detection[];
  /** Insertion order. */
  inFrames(frames: ReadonlySet<FrameNo>): readonly Detection[];
  /** Distinct prompts, sorted. */
  prompts(): readonly string[];
  size(): number;
  /** next_n per frame, for frames that have a counter (ids minted or reserved). */
  counters(frames: readonly FrameNo[]): ReadonlyMap<FrameNo, number>;
  /** Removes every detection and run of these frames (a removed clip). It keeps the counters for revival. */
  drop(frames: readonly FrameNo[]): Dropped;
  /**
   * Same-frame detections that cover the same region (mask IoU > aliasIou), whichever run found them. A region
   * search hit on top of a find hit is the same region, so assigning one assigns the other too.
   */
  aliases(d: Detection, aliasIou: number): readonly Detection[];
  /** The ids plus their aliases, deduplicated, in order of first appearance. An unknown id gives `no-detection`. */
  expand(ids: readonly string[], aliasIou: number): Result<readonly DetId[], DetectionsError>;
  /** The best-scoring detection of each same-frame alias group, sorted by frame, then by score descending. */
  collapse(dets: readonly Detection[], aliasIou: number): readonly Detection[];
  /** `bestView` as a method, so labelling can reach it through its DetectionLookup port. */
  bestView(dets: readonly Detection[]): Detection | null;
}

export type CreateDetections = (opts: DetectionsOptions) => Detections;
