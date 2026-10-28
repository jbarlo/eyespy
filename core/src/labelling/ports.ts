/**
 * What labelling requires, in its own vocabulary. The detections instance satisfies DetectionLookup, and compose
 * passes it in directly because the method names match. Storage satisfies LabelLog.
 */
import type { Result, ResultAsync } from "neverthrow";
import type { DetectionsError } from "../detections/index.ts";
import type { DetId, Detection } from "../detections/pure.ts";
import type { HostFailure } from "../ports/index.ts";
import type { FrameNo } from "../video/pure.ts";
import type { Objects, OpEntry, OpLine } from "./model.ts";

export interface DetectionLookup {
  get(id: string): Result<Detection, DetectionsError>;
  has(id: string): boolean;
  all(): readonly Detection[];
  byFrame(i: FrameNo): readonly Detection[];
  inFrames(frames: ReadonlySet<FrameNo>): readonly Detection[];
  aliases(d: Detection, aliasIou: number): readonly Detection[];
  expand(ids: readonly string[], aliasIou: number): Result<readonly DetId[], DetectionsError>;
  collapse(dets: readonly Detection[], aliasIou: number): readonly Detection[];
  bestView(dets: readonly Detection[]): Detection | null;
}

/** One labelling op to persist. */
export type Commit = {
  readonly objects: Objects;
  /** The counter after this op (next_obj in session.json). */
  readonly nextObj: number;
  readonly line: OpLine;
};

export interface LabelLog {
  /** Persists one op. Returns the appended entry with `seq` set and `ts` taken from storage's clock. */
  commit(c: Commit): ResultAsync<OpEntry, HostFailure>;
}

export type LabellingPorts = { readonly detections: DetectionLookup; readonly log: LabelLog };
