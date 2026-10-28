/**
 * The session's public API, with ops grouped by intent. Each op is `(ctx, req) => ResultAsync<reply, SessionError>`.
 * Reply shapes are public API (manifest, status, data.*, find replies), so their keys and key order are fixed.
 */
import type { ResultAsync } from "neverthrow";
import type { DetectionsError } from "../detections/index.ts";
import type { DetId, HeatmapRef } from "../detections/pure.ts";
import type {
  HistoryState,
  HistoryView,
  LabellingError,
  ObjectId,
  ObjectMatch,
  ObjectSummary,
  OpEntrySansDiff,
  Owner,
} from "../labelling/index.ts";
import type { CacheStats, PerceptionError, Provenance } from "../perception/index.ts";
import type { Box } from "../pixels/index.ts";
import type { Clock, HostFailure, Logger, Timers } from "../ports/index.ts";
import type { RenderError } from "../render/index.ts";
import type { VideoError } from "../video/index.ts";
import type { ClipKey, FrameNo } from "../video/pure.ts";
import type { SessionDeps, SessionMeta } from "./ports.ts";
import type { Config, ConfigKey, Ctx } from "./pure.ts";

export type SessionOptions = {
  /** Logs how long each detect-and-record took, per stage. */
  readonly profile?: boolean;
};

/** Failures the session itself detects. Module errors join the union as they are. Kinds are unique across modules. */
type SessionOwnError =
  | { readonly kind: "unknown-setting"; readonly key: string; readonly known: readonly ConfigKey[] }
  | { readonly kind: "unknown-settings"; readonly keys: readonly string[] }
  | { readonly kind: "bad-setting-value"; readonly value: string }
  | { readonly kind: "no-frames" }
  | { readonly kind: "region-too-small"; readonly w: number; readonly h: number; readonly min: number }
  | { readonly kind: "missing-heatmap"; readonly ref: HeatmapRef }
  | { readonly kind: "shutting-down" };

export type SessionError =
  SessionOwnError | VideoError | PerceptionError | DetectionsError | LabellingError | RenderError | HostFailure;

type Op<Req, Reply> = (ctx: Ctx, req: Req) => ResultAsync<Reply, SessionError>;

export type DetSummary = {
  readonly id: DetId;
  readonly frame: FrameNo;
  readonly t: number;
  readonly prompts: readonly string[];
  /** Rounded to 3 decimals. */
  readonly score: number;
  readonly box: Box;
  readonly area: number;
  readonly object?: Owner;
};
type Scored = DetSummary & { readonly sim: number };
/** A stored image, as the host's store locates it. That is a path in Node and a URL in a browser. */
export type Locator = string;

export type StatusReply = {
  readonly root: string;
  readonly clips: readonly { readonly path: string; readonly key: ClipKey; readonly keyframes: number }[];
  readonly keyframes: number;
  readonly encoded: number;
  readonly prompts: readonly string[];
  readonly detections: number;
  readonly objects: number;
  readonly rejected: number;
  readonly todo: number;
  readonly assigned: number;
};
/**
 * `video` is the clip to add, a video file or, in Node, a folder of frames. `fps` is a folder of frames' rate. Omit it
 * for photos.
 */
export type AddReq = { readonly video: string; readonly fps?: number | null };
export type AddReply = {
  readonly clip: string;
  readonly keyframes: number;
  readonly first: FrameNo;
  readonly captured: string | null;
  readonly revived: boolean;
};
export type ClipsListReq = { readonly all?: boolean | null };
export type ClipInfo = {
  readonly key: ClipKey;
  readonly path: string;
  readonly name: string;
  readonly captured: string | null;
  readonly keyframes: number;
  readonly frames: readonly [FrameNo | null, FrameNo | null];
  readonly encoded: number;
  readonly detections: number;
  readonly objects: number;
  readonly frame_bytes: number;
  readonly feature_bytes: number;
  readonly removed?: number;
};
export type ClipsListReply = { readonly clips: readonly ClipInfo[] };
export type ClipsRemoveReq = { readonly clip: string };
export type ClipsRemoveReply = {
  readonly removed: string;
  readonly key: ClipKey;
  readonly frames: readonly [FrameNo, FrameNo];
  readonly detections: number;
  readonly stripped: number;
  readonly deleted: readonly ObjectId[];
};
export type ConfigReq = { readonly key?: string | null; readonly value?: string | number | null };
export type ConfigReply = { readonly config: Config; readonly defaults: Config };
/** `clip` limits `clear` to that clip's keyframes. It takes a path, name or key, as clips.remove does. */
export type FeaturesReq = {
  readonly persist?: boolean | null;
  readonly clear?: boolean | null;
  readonly clip?: string | null;
  /** Sets this engine's disk budget for stored features, in MB or "unlimited". A lower budget evicts at once. */
  readonly diskMB?: number | "unlimited" | null;
};
export type FeaturesReply = CacheStats & { readonly cleared: number; readonly evicted: number };

export type FrameSpecReq = { readonly frames?: string | null };
/**
 * Frames, as a frame spec, whose stored features a search protects from disk-budget eviction besides its own.
 * Absent means none. A client that sweeps one frame per call passes its whole scope, so the sweep keeps what is
 * stored.
 */
type HoldReq = { readonly hold?: string | null };
export type SheetReply = {
  readonly image: Locator;
  readonly frames: readonly { readonly frame: FrameNo; readonly t: number }[];
};
export type FindReq = FrameSpecReq &
  HoldReq & {
    readonly prompt: string;
    readonly crops?: boolean | null;
    readonly threshold?: number | null;
  };
export type FindReply = {
  readonly prompt: string;
  readonly seconds: number;
  /** Per frame, rounded to 3 decimals. */
  readonly presence: Readonly<Record<number, number>>;
  readonly present: readonly FrameNo[];
  readonly image: Locator | null;
  readonly hits: readonly DetSummary[];
};
export type SearchReq = {
  readonly frame: number;
  readonly box: Box;
  readonly prompt?: string | null;
  readonly similar?: boolean | null;
  readonly k?: number | null;
  readonly threshold?: number | null;
};
export type SearchReply = {
  readonly frame: FrameNo;
  readonly box: Box;
  readonly prompt: string | null;
  readonly presence: number | null;
  readonly hits: readonly DetSummary[];
  readonly similar: readonly Scored[];
};
export type SemanticReq = FrameSpecReq & HoldReq & { readonly prompt: string; readonly uncovered?: boolean | null };
export type SemanticReply = {
  readonly prompt: string;
  readonly image: Locator;
  /** Activated area fraction per frame, rounded to 4 decimals. */
  readonly area: Readonly<Record<number, number>>;
  readonly presence: Readonly<Record<number, number>>;
};

export type ShowReq = FrameSpecReq & {
  readonly crops?: boolean | null;
  readonly threshold?: number | null;
  readonly objects?: boolean | null;
  readonly rejects?: boolean | null;
};
export type HitsReply = { readonly image: Locator | null; readonly hits: readonly DetSummary[] };
export type CropReq = { readonly id: string };
export type CropReply = DetSummary & { readonly image: Locator };
export type SimilarReq = { readonly id: string; readonly k?: number | null; readonly threshold?: number | null };
export type SimilarReply = {
  readonly query: DetSummary;
  readonly image: Locator | null;
  readonly matches: readonly Scored[];
};
export type DetsReq = FrameSpecReq & {
  readonly crops?: boolean | null;
  readonly threshold?: number | null;
  readonly prompt?: string | null;
};
export type GapsReply = { readonly image: Locator };

export type ObjNewReq = { readonly label: string; readonly ids: readonly string[] };
export type ObjIdsReq = { readonly obj: string; readonly ids: readonly string[] };
export type ObjMergeReq = { readonly into: string; readonly from: string };
export type ObjLabelReq = { readonly obj: string; readonly label: string };
export type ObjReq = { readonly obj: string };
export type ObjDeleteReply = { readonly deleted: ObjectId };
export type ObjShowReq = ObjReq & FrameSpecReq & { readonly offset?: number | null };
export type ObjShowReply = ObjectSummary & {
  readonly total: number;
  readonly offset: number;
  readonly image: Locator | null;
  readonly hits: readonly DetSummary[];
};
export type ObjSuggestReq = ObjReq & { readonly k?: number | null; readonly threshold?: number | null };
export type ObjSuggestReply = {
  readonly query: ObjectSummary;
  readonly image: Locator | null;
  readonly matches: readonly Scored[];
};
export type ObjMatchReq = { readonly ids: readonly string[]; readonly k?: number | null };
export type ObjMatchReply = {
  readonly ids: readonly string[];
  readonly current: readonly Owner[];
  readonly matches: readonly ObjectMatch[];
};
export type RejectReq = { readonly ids?: readonly string[] | null; readonly prompt?: string | null };
export type RejectReply = { readonly rejected: readonly DetId[] };
export type TodoReq = FrameSpecReq & {
  readonly crops?: boolean | null;
  readonly threshold?: number | null;
  readonly prompt?: string | null;
  readonly limit?: number | null;
  readonly groups?: boolean | null;
  readonly offset?: number | null;
};
type TodoGroup = { readonly group: string; readonly ids: readonly DetId[]; readonly frames: string };
export type TodoReply =
  | ({ readonly total: number } & HitsReply)
  | {
      readonly total: number;
      readonly groups_total: number;
      readonly image: Locator | null;
      readonly groups: readonly TodoGroup[];
    };
export type UndoReply = { readonly undone: OpEntrySansDiff } & HistoryState;
export type RedoReply = { readonly redone: OpEntrySansDiff } & HistoryState;

export type DataFrame = {
  readonly frame: FrameNo;
  readonly t: number;
  readonly clip: string;
  readonly clipKey: ClipKey;
  readonly w: number;
  readonly h: number;
  readonly encoded: boolean;
  readonly image: Locator;
};
export type DataFramesReply = { readonly frames: readonly DataFrame[] };
export type MaskFormat = "rle" | "png" | "none";
export type DataDetsReq = FrameSpecReq & {
  readonly prompt?: string | null;
  readonly threshold?: number | null;
  readonly mask?: MaskFormat | null;
  readonly aliases?: boolean | null;
};
export type DataMask =
  | { readonly format: "rle"; readonly w: number; readonly h: number; readonly counts: readonly number[] }
  | { readonly format: "png"; readonly w: number; readonly h: number; readonly image: Locator };
type DataDet = DetSummary & {
  readonly prompt: string;
  /** The runLabel, "prompt" or "prompt@x0,y0,x1,y1". */
  readonly run: string;
  readonly rejected: boolean;
  readonly mask: DataMask | null;
  readonly aliases?: readonly DetId[];
};
export type DataDetsReply = { readonly dets: readonly DataDet[] };
export type DataRunsReq = FrameSpecReq & { readonly prompt?: string | null };
type DataRun = {
  readonly frame: FrameNo;
  /** The runLabel. Region runs end in "@box". */
  readonly prompt: string;
  /** Rounded to 4 decimals. */
  readonly presence: number;
  readonly ids: readonly DetId[];
  readonly semantic: Locator | null;
};
export type DataRunsReply = { readonly runs: readonly DataRun[] };
export type DataObjectsReply = { readonly objects: readonly ObjectSummary[]; readonly rejected: readonly DetId[] };

export type ManifestReq = { readonly crops?: boolean | null };
type ManifestClip = {
  readonly path: string;
  readonly captured: string | null;
  readonly keyframes: number;
  readonly first: FrameNo;
  readonly keyframe_thresh: number | null;
};
/** `meta` also spreads the host's HostInfo entries, such as the code revision, at its top level. */
export type ManifestReply = {
  readonly meta: {
    readonly clips: readonly ManifestClip[];
    readonly keyframes: number;
    readonly config: Config;
  } & Provenance &
    Readonly<Record<string, unknown>>;
  readonly items: readonly { readonly label: string; readonly count: number }[];
  readonly objects: readonly ObjectSummary[];
  readonly image: Locator | null;
};

/** Only the actor (Engine) calls in, one op at a time. */
export interface Session {
  readonly videos: {
    readonly status: Op<Record<never, never>, StatusReply>;
    /** Adds a clip, or revives a tombstone of the same content. */
    readonly add: Op<AddReq, AddReply>;
    readonly list: Op<ClipsListReq, ClipsListReply>;
    /** Removes a clip and its labels, detections and files. There is no undo. */
    readonly remove: Op<ClipsRemoveReq, ClipsRemoveReply>;
    readonly config: Op<ConfigReq, ConfigReply>;
    /** Vision-feature storage settings and counts. */
    readonly features: Op<FeaturesReq, FeaturesReply>;
  };
  readonly find: {
    readonly sheet: Op<FrameSpecReq, SheetReply>;
    /** For each frame, uses the cached run or detects. */
    readonly find: Op<FindReq, FindReply>;
    /** Region search. With a prompt it detects in the region. It can also rank by DINOv2 similarity, or do both. */
    readonly search: Op<SearchReq, SearchReply>;
    readonly semantic: Op<SemanticReq, SemanticReply>;
  };
  readonly look: {
    readonly show: Op<ShowReq, HitsReply>;
    readonly crop: Op<CropReq, CropReply>;
    readonly similar: Op<SimilarReq, SimilarReply>;
    readonly dets: Op<DetsReq, HitsReply>;
    readonly gaps: Op<FrameSpecReq, GapsReply>;
  };
  readonly label: {
    readonly create: Op<ObjNewReq, ObjectSummary>;
    readonly add: Op<ObjIdsReq, ObjectSummary>;
    readonly remove: Op<ObjIdsReq, ObjectSummary>;
    readonly merge: Op<ObjMergeReq, ObjectSummary>;
    readonly relabel: Op<ObjLabelReq, ObjectSummary>;
    readonly delete: Op<ObjReq, ObjDeleteReply>;
    readonly show: Op<ObjShowReq, ObjShowReply>;
    readonly suggest: Op<ObjSuggestReq, ObjSuggestReply>;
    readonly match: Op<ObjMatchReq, ObjMatchReply>;
    /** With `prompt`, also rejects every unowned detection of that prompt, at any score. */
    readonly reject: Op<RejectReq, RejectReply>;
    readonly todo: Op<TodoReq, TodoReply>;
    readonly undo: Op<Record<never, never>, UndoReply>;
    readonly redo: Op<Record<never, never>, RedoReply>;
  };
  /** Raw data for interactive UIs. These ops only read. */
  readonly data: {
    readonly frames: Op<Record<never, never>, DataFramesReply>;
    readonly dets: Op<DataDetsReq, DataDetsReply>;
    readonly runs: Op<DataRunsReq, DataRunsReply>;
    readonly objects: Op<Record<never, never>, DataObjectsReply>;
    readonly history: Op<Record<never, never>, HistoryView>;
  };
  readonly export: {
    readonly manifest: Op<ManifestReq, ManifestReply>;
  };

  /** The saved config. Ctx is built from it plus the request's overrides. */
  config(): Config;
  meta(): SessionMeta;
  /** One unit of background work. False when idle. */
  background(): ResultAsync<boolean, SessionError>;
  pending(): readonly FrameNo[];
}

/** Opens a session over records already loaded. */
export type CreateSession = (
  deps: SessionDeps,
  meta: SessionMeta,
  opts: SessionOptions,
) => ResultAsync<Session, SessionError>;

export interface Engine {
  /**
   * Runs one request on the actor with its per-call `cfg` overrides. Unknown keys fail before queueing. Queries run
   * there too, so a reader never sees a half-applied write.
   */
  call<T>(
    cfg: Readonly<Record<string, number>> | undefined,
    fn: (s: Session, ctx: Ctx) => ResultAsync<T, SessionError>,
  ): ResultAsync<T, SessionError>;
  /** Stops the actor and the idle timer, then fires `onExit`. */
  shutdown(): void;
}

export type EngineOptions = {
  /** Defaults to the session's idle_minutes. */
  readonly idleMinutes?: number;
  readonly onExit: () => void;
};
export type EngineHost = { readonly clock: Clock; readonly logger: Logger; readonly timers: Timers };
/** Puts the single-owner actor in front of the session and exits when idle. */
export type CreateEngine = (session: Session, host: EngineHost, opts: EngineOptions) => Engine;
