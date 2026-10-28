import type { ResultAsync } from "neverthrow";
import type { Mask, RGB } from "../pixels/index.ts";
import type { HostFailure, RuntimeInfo } from "../ports/index.ts";
import type { FrameAccessError, FrameNo } from "../video/pure.ts";
import type { PerceptionPorts } from "./ports.ts";
import type { Appearance, Detected, DetectorPrecision, Features } from "./pure.ts";

export type PerceptionOptions = {
  readonly detector: DetectorPrecision;
  /** RAM for vision features in MB, with room for at least two frames. Defaults to DEFAULT_CACHE_MB. */
  readonly featureCacheMB?: number;
  /** Also save features in the store. Defaults to true. `setPersist` changes it at runtime. */
  readonly persistFeatures?: boolean;
  /**
   * Disk budget for stored feature files in MB. The default null means unlimited. `setDiskBudget` changes it at
   * runtime.
   */
  readonly featureDiskMB?: number | null;
  /**
   * The format stamp of the stored feature files (session.json `features`). If it is not this module's
   * FEATURE_FORMAT, the files are ignored. `scanStore` then finds nothing, and frames are encoded and their files
   * overwritten.
   */
  readonly storedFeatureFormat: string | null;
  /** Log detect's timings per stage through the Logger, timed with the Clock. */
  readonly profile?: boolean;
};

/** Where the detector's MASK_SIZE² output lands: the image's size and, for a region crop, its offset in the frame. */
export type DetectTarget = {
  readonly w: number;
  readonly h: number;
  readonly offset?: { readonly x: number; readonly y: number };
};
export type DetectOptions = {
  /** Keeps instances scoring above this (config score_floor). */
  readonly scoreFloor: number;
  /** Within one call, masks overlapping above this IoU count as one hit (config nms_iou). */
  readonly nmsIou: number;
};

export type ModelFile = { readonly file: string; readonly sha256: string };
/** The manifest's `models` and `runtime`, in the public reply shape. */
export type Provenance = {
  readonly models: {
    readonly segmentation: {
      readonly name: string;
      readonly format: string;
      readonly export: string;
      readonly source_weights_sha256: string;
      readonly vision: ModelFile;
      readonly text: ModelFile;
      readonly detector: ModelFile;
      readonly feature_cache: string;
    };
    readonly appearance: ModelFile & { readonly name: string; readonly export: string; readonly dim: number };
  };
  readonly runtime: RuntimeInfo;
};

export type CacheStats = {
  readonly persist: boolean;
  /** Feature files in the store, over live frames. */
  readonly stored: number;
  readonly keyframes: number;
  readonly inMemory: number;
  readonly bytesPerFrame: number;
  /** Bytes of the stored feature files this instance knows of. `scanStore` lists them and later writes add to it. */
  readonly storedBytes: number;
  /** The disk budget in MB, or null for unlimited. */
  readonly diskMB: number | null;
};

export type PerceptionError =
  | HostFailure
  | FrameAccessError
  /** A named model output is unusable, so the ONNX export is not the one this code expects. */
  | { readonly kind: "model-output-missing"; readonly model: string; readonly output: string }
  | { readonly kind: "bad-tokenizer"; readonly message: string };

/**
 * What the models can do. The instance holds state: models loaded on first use, the text-feature cache, the
 * feature LRU and the encoded set. Every value it returns is immutable.
 */
export interface Perception {
  /** Vision features of any image, without caching. Region search uses it for crops. */
  encode(img: RGB): ResultAsync<Features, PerceptionError>;
  /** A keyframe's features, from RAM, the store or a fresh encode. */
  features(i: FrameNo): ResultAsync<Features, PerceptionError>;
  /** Whether features exist in RAM or in the trusted store. */
  encoded(i: FrameNo): boolean;
  /** Live frames not yet encoded, minus the failed ones. */
  pending(): readonly FrameNo[];
  /**
   * One unit of background work. It encodes the first pending frame, or else loads stored features into the RAM
   * cache while it has room. Returns false when idle.
   */
  encodeNext(): ResultAsync<boolean, PerceptionError>;
  /**
   * Puts the live clips' stored feature files on the disk budget's books and evicts down to the budget. If the
   * store is trusted (`storedFeatureFormat` is FEATURE_FORMAT), it also marks live frames that have a stored file
   * as encoded without reading them, and returns how many, else 0. Call it once after opening, before background
   * work.
   */
  scanStore(): ResultAsync<number, PerceptionError>;
  /**
   * Drops all state of these frames (RAM, encoded, failed) for a removed clip. The session deletes the clip's files.
   */
  forget(frames: readonly FrameNo[]): void;
  /** One detector call, for find and region search. */
  detect(
    features: Features,
    prompt: string,
    target: DetectTarget,
    opts: DetectOptions,
  ): ResultAsync<Detected, PerceptionError>;
  /** DINOv2 signature per region. */
  embed(img: RGB, regions: readonly Mask[]): ResultAsync<readonly Appearance[], PerceptionError>;
  /** DINOv2 signature of a whole image, such as a region-search crop. */
  embedCrop(img: RGB): ResultAsync<Appearance, PerceptionError>;
  /** Turns persisting on or off at runtime. `stats().persist` reports it. */
  setPersist(on: boolean): void;
  /**
   * Deletes the stored feature files of live frames, or only of `frames` (one clip's) if given. Frames still in RAM
   * stay encoded. Returns how many files it deleted.
   */
  clearStored(frames?: readonly FrameNo[]): ResultAsync<number, PerceptionError>;
  /**
   * Changes the disk budget, in MB or null for unlimited. A lower budget evicts the least recently used unheld
   * files at once. Returns how many files it evicted.
   */
  setDiskBudget(mb: number | null): ResultAsync<number, PerceptionError>;
  /**
   * Protects these frames' stored files from eviction while a search over them runs. The frame a `features` call
   * is loading is always held. Returns a release function that is safe to call more than once.
   */
  hold(frames: readonly FrameNo[]): () => void;
  stats(): ResultAsync<CacheStats, PerceptionError>;
  provenance(): ResultAsync<Provenance, PerceptionError>;
  readonly formats: { readonly features: string };
}

export type CreatePerception = (ports: PerceptionPorts, opts: PerceptionOptions) => Perception;
