import type { Result, ResultAsync } from "neverthrow";
import type { DetId, Detection, RunRecord } from "../detections/pure.ts";
import type { LabelLog } from "../labelling/ports.ts";
import type { Objects, OpEntry } from "../labelling/pure.ts";
import type { FeatureStore } from "../perception/ports.ts";
import type { HostFailure } from "../ports/index.ts";
import type {
  DetectionStore,
  HeatmapStore,
  MetaStore,
  OutputSink,
  SessionMeta,
  StoredFrames,
} from "../session/ports.ts";
import type { FrameStore } from "../video/ports.ts";
import type { ClipKey, FrameRef } from "../video/pure.ts";

export type StorageError =
  | HostFailure
  | { readonly kind: "no-session"; readonly root: string }
  | { readonly kind: "bad-session-json"; readonly message: string }
  | { readonly kind: "unsupported-version"; readonly version: number }
  /** A record file (dets.json, runs.json, objects.json, a det npz) that doesn't parse or lacks a field. */
  | { readonly kind: "bad-record"; readonly file: string; readonly message: string }
  | { readonly kind: "missing-detection-file"; readonly id: DetId };

/** Video's FrameStore plus the size and locator the session reports. */
export type FrameFiles = FrameStore & StoredFrames;

/** Perception's FeatureStore plus the file size the session reports. */
export type FeatureFiles = FeatureStore & {
  readonly size: (ref: FrameRef) => ResultAsync<number | null, HostFailure>;
};

/** Everything in the folder, decoded into the domain's shapes, which the modules are created from. */
export type SessionRecords = {
  readonly meta: SessionMeta;
  /** next_obj from session.json, or 1 if it has none. */
  readonly nextObj: number;
  /** In dets.json order, with masks unpacked and embeddings as float32. */
  readonly detections: readonly Detection[];
  readonly runs: readonly RunRecord[];
  readonly objects: Objects;
  /** ops.jsonl, parsed. */
  readonly history: readonly OpEntry[];
};

/**
 * The session folder as typed facades. Each implements one consumer's port, so compose passes them through as
 * they are. One instance owns session.json. It writes the session part (MetaStore) and labelling's next_obj
 * (LabelLog) together.
 */
export interface SessionFolder {
  readonly root: string;
  /** Reads and decodes everything. Returns `no-session` if session.json is missing. Opening never creates one. */
  open(): ResultAsync<SessionRecords, StorageError>;
  readonly meta: MetaStore;
  readonly frames: FrameFiles;
  readonly features: FeatureFiles;
  readonly detections: DetectionStore;
  readonly labels: LabelLog;
  readonly heatmaps: HeatmapStore;
  readonly outputs: OutputSink;
  /** Deletes clips/<key>/ and everything under it. */
  removeClipFiles(key: ClipKey): ResultAsync<void, HostFailure>;
}

export type ParseMetaText = (text: string) => Result<SessionMeta & { readonly nextObj: number | null }, StorageError>;
