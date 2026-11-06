/** What session requires beyond the modules it wires. */
import type { ResultAsync } from "neverthrow";
import type { Detections } from "../detections/index.ts";
import type { DetId, Detection, HeatmapRef, RunRecord } from "../detections/pure.ts";
import type { Labelling } from "../labelling/index.ts";
import type { Perception } from "../perception/index.ts";
import type { Gray, RGB } from "../pixels/index.ts";
import type { Clock, HostFailure, HostInfo, Logger } from "../ports/index.ts";
import type { Renderer } from "../render/index.ts";
import type { Tracking } from "../tracking/index.ts";
import type { TrackStore } from "../tracking/ports.ts";
import type { Video } from "../video/index.ts";
import type { Clip, ClipKey, FrameNo, FrameRef } from "../video/pure.ts";
import type { Config } from "./pure.ts";

/** session.json as the session sees it, without labelling's `next_obj`. */
export type SessionMeta = {
  readonly version: number;
  /** Overrides of DEFAULT_CONFIG. */
  readonly config: Partial<Config>;
  readonly clips: readonly Clip[];
  readonly formats: {
    /** FEATURE_FORMAT once this code has encoded features. */
    readonly features: string | null;
    /** TRUNK_FORMAT once this code has stored trunks. */
    readonly trunks?: string;
    /** TRACK_FORMAT once this code has saved tracks. */
    readonly tracks?: string;
    /** ASSOC_FORMAT once this code has saved association results. */
    readonly assoc?: string;
  };
};

export interface MetaStore {
  /** Replaces the session part of session.json atomically. next_obj stays as it is. */
  write(meta: SessionMeta): ResultAsync<void, HostFailure>;
}

export interface DetectionStore {
  /** Writes the detection's npz file. */
  writeDetection(d: Detection): ResultAsync<void, HostFailure>;
  /** Deletes the npz and the derived mask PNG, if any. */
  removeDetection(id: DetId): ResultAsync<void, HostFailure>;
  /** Writes dets.json and runs.json from the current state, with every detection's meta and every run. */
  writeIndex(detections: readonly Detection[], runs: readonly RunRecord[]): ResultAsync<void, HostFailure>;
  /** Locator of a detection's stored mask PNG, or null if none has been written yet. */
  maskImage(id: DetId): ResultAsync<string | null, HostFailure>;
  /** Stores a detection's mask PNG and returns its locator. Detections are immutable, so this happens once. */
  writeMaskImage(id: DetId, png: Uint8Array): ResultAsync<string, HostFailure>;
}

export interface HeatmapStore {
  /** Stores a run's heatmap PNG. The ref names it from (frame, prompt). */
  write(frame: FrameNo, prompt: string, png: Uint8Array): ResultAsync<HeatmapRef, HostFailure>;
  read(ref: HeatmapRef): ResultAsync<Uint8Array | null, HostFailure>;
  remove(ref: HeatmapRef): ResultAsync<void, HostFailure>;
  locate(ref: HeatmapRef): string;
}

export interface OutputSink {
  /** Writes out/<name>.jpg and returns the locator replies carry as `image`. */
  writeImage(name: string, jpeg: Uint8Array): ResultAsync<string, HostFailure>;
}

/**
 * The codec methods the session itself uses. It writes outputs as JPEG and heatmaps and masks as PNG, and reads
 * heatmaps back.
 */
interface PictureCodec {
  encodeJpeg(img: RGB, quality: number): Promise<Uint8Array>;
  encodePng(img: Gray): Promise<Uint8Array>;
  decodeGray(bytes: Uint8Array): Promise<Gray>;
}

type SessionModules = {
  readonly video: Video;
  readonly perception: Perception;
  readonly detections: Detections;
  readonly labelling: Labelling;
  readonly render: Renderer;
  /** Null with tracking off, as on every production path. */
  readonly tracking: Tracking | null;
};

/** Keyframe JPEGs as replies report them. Video reads and writes them through its own FrameStore. */
export interface StoredFrames {
  /** Size of the stored JPEG, or null for none (clips.list `frame_bytes`). */
  size(ref: FrameRef): ResultAsync<number | null, HostFailure>;
  /** How clients refer to the stored JPEG (data.frames `image`). */
  locate(ref: FrameRef): string;
  /** The same for a tracking frame that isn't a keyframe, with `index` its place on the grid (track.frames `image`). */
  locateTrack(ref: FrameRef): string;
}

/** The bytes of what tracking stores for a clip (clips.list `tracking`). */
export type TrackingBytes = { readonly frames: number; readonly trunks: number; readonly tracks: number };

type SessionStores = {
  readonly meta: MetaStore;
  readonly detections: DetectionStore;
  readonly heatmaps: HeatmapStore;
  readonly outputs: OutputSink;
  readonly frameFiles: StoredFrames;
  /** Size of a keyframe's stored feature file, or null for none (clips.list `feature_bytes`). */
  featureBytes(ref: FrameRef): ResultAsync<number | null, HostFailure>;
  readonly tracks: TrackStore;
  trackingBytes(clip: ClipKey, tracks: readonly string[]): ResultAsync<TrackingBytes, HostFailure>;
  /** Deletes clips/<key>/ with its frame JPEGs, features, trunks and tracks. */
  removeClipFiles(key: ClipKey): ResultAsync<void, HostFailure>;
};

type SessionHost = {
  readonly codec: PictureCodec;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly info: HostInfo;
  /** The session root as users see it (status.root). */
  readonly root: string;
};

export type SessionDeps = {
  readonly modules: SessionModules;
  readonly stores: SessionStores;
  readonly host: SessionHost;
};
