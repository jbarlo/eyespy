import type { Result, ResultAsync } from "neverthrow";
import type { DetectionsError } from "../detections/index.ts";
import type { DetId, Detection } from "../detections/pure.ts";
import type { Appearance } from "../perception/pure.ts";
import type { HostFailure } from "../ports/index.ts";
import type { ClipKey, FrameNo } from "../video/pure.ts";
import type { LabellingPorts } from "./ports.ts";
import type {
  HistoryState,
  HistoryView,
  Obj,
  ObjectId,
  Objects,
  OpEntry,
  OpEntrySansDiff,
  Owner,
  ReplayFailure,
} from "./model.ts";

export type LabellingOptions = {
  /** As loaded, plus the reject set if it was missing. */
  readonly objects: Objects;
  /** ops.jsonl, parsed. */
  readonly history: readonly OpEntry[];
  /** next_obj from session.json. */
  readonly nextObj: number;
};

/** Per-request settings an op needs. Callers always pass them explicitly. */
export type LabelCtx = { readonly aliasIou: number };

export type LabellingError =
  | HostFailure
  | DetectionsError
  | { readonly kind: "no-object"; readonly id: string }
  | { readonly kind: "object-no-members"; readonly id: Owner }
  | { readonly kind: "merge-reject" }
  | { readonly kind: "merge-self" }
  | { readonly kind: "delete-reject" }
  | { readonly kind: "nothing-to-undo" }
  | { readonly kind: "nothing-to-redo" }
  | {
      readonly kind: "cannot-replay";
      readonly op: "undo" | "redo";
      readonly seq: number;
      /** The op being replayed. */
      readonly of: string;
      readonly reason: ReplayFailure;
    };

/** The public reply shape for obj.* ops, data.objects and manifest. */
export type ObjectSummary = {
  readonly id: Owner;
  readonly label: string;
  readonly sightings: number;
  readonly members: readonly DetId[];
  readonly first_t: number | null;
  readonly last_t: number | null;
  readonly best: DetId | null;
  /** Every prompt that found the object, with its best score, sorted by score descending. */
  readonly prompts: Readonly<Record<string, number>>;
};

export type ObjectMatch = {
  readonly obj: ObjectId;
  readonly label: string;
  readonly sim: number;
  readonly closest: DetId;
  readonly closest_sim: number;
  readonly sightings: number;
};

export type UnassignedQuery = {
  readonly threshold: number;
  readonly prompt?: string | null;
  readonly frames?: ReadonlySet<FrameNo> | null;
};

/**
 * Ids added to an object expand to their aliases (ctx.aliasIou), and the object takes them from any other owner. An
 * op that changes nothing commits nothing. It writes no op line, takes no undo slot and keeps the redo stack, but
 * replies as if it had been logged.
 */
export interface Labelling {
  get(id: string): Result<Obj, LabellingError>;
  /** Real objects (not the reject set), in objects.json order. */
  objectIds(): readonly ObjectId[];
  ownerOf(id: DetId): Owner | undefined;
  owners(): ReadonlyMap<DetId, Owner>;
  rejected(): readonly DetId[];
  summary(id: string): Result<ObjectSummary, LabellingError>;
  /** The member with the best view, or null for none. */
  best(id: string): Result<Detection | null, LabellingError>;
  /** Normalised mean appearance of the members. */
  centroid(id: string): Result<Appearance, LabellingError>;
  /**
   * Answers "which object is this?". Ranks objects by how close their centroid, leaving out the query ids and their
   * aliases, is to the mean of `ids`.
   */
  match(ids: readonly string[], k: number, ctx: LabelCtx): Result<readonly ObjectMatch[], LabellingError>;
  /** The work queue of unowned detections scoring at least `threshold`, one per alias cluster, in frame order. */
  unassigned(q: UnassignedQuery, ctx: LabelCtx): readonly Detection[];
  history(): HistoryView;
  historyState(): HistoryState;
  create(
    label: string,
    ids: readonly string[],
    ctx: LabelCtx,
  ): ResultAsync<{ readonly id: ObjectId; readonly added: readonly DetId[] }, LabellingError>;
  add(
    obj: string,
    ids: readonly string[],
    ctx: LabelCtx,
  ): ResultAsync<{ readonly added: readonly DetId[] }, LabellingError>;
  remove(
    obj: string,
    ids: readonly string[],
    ctx: LabelCtx,
  ): ResultAsync<{ readonly removed: readonly DetId[] }, LabellingError>;
  merge(into: string, from: string): ResultAsync<void, LabellingError>;
  relabel(obj: string, label: string): ResultAsync<void, LabellingError>;
  delete(obj: string): ResultAsync<void, LabellingError>;
  reject(ids: readonly string[], ctx: LabelCtx): ResultAsync<{ readonly rejected: readonly DetId[] }, LabellingError>;
  undo(): ResultAsync<{ readonly undone: OpEntrySansDiff } & HistoryState, LabellingError>;
  redo(): ResultAsync<{ readonly redone: OpEntrySansDiff } & HistoryState, LabellingError>;
  /**
   * Removes a clip's detections from every object, rejects included, and deletes objects left empty. The session calls
   * this when it removes a clip.
   */
  stripFrames(clip: {
    readonly key: ClipKey;
    readonly path: string;
    /** Every keyframe of the clip, first to last. */
    readonly frames: readonly [FrameNo, ...FrameNo[]];
  }): ResultAsync<{ readonly stripped: number; readonly deleted: readonly ObjectId[] }, LabellingError>;
}

export type CreateLabelling = (ports: LabellingPorts, opts: LabellingOptions) => Labelling;
