/**
 * Object identity and the shapes storage maps to objects.json and ops.jsonl. They live outside pure.ts so that
 * internal/ can import them without a cycle. The "o<n>" format and the reject id are private to this module and
 * storage.
 */
import type { Result } from "neverthrow";
import type { DetId } from "../detections/pure.ts";
import type { ClipKey, FrameNo } from "../video/pure.ts";

/** "o<n>" from a counter that only goes up (next_obj in session.json), so no id is reused. */
export type ObjectId = string & { readonly brand: "labelling.ObjectId" };
/** The reserved object holding rejected detections. */
export type RejectId = "x";
export const REJECT: RejectId = "x";
export type Owner = ObjectId | RejectId;

export const isObjectId = (s: string): s is ObjectId => /^o\d+$/.test(s);
export const isReject = (s: string): s is RejectId => s === REJECT;
export const isOwner = (s: string): s is Owner => isReject(s) || isObjectId(s);

export type Obj = { readonly label: string; readonly members: readonly DetId[] };
/** objects.json holds every object, including the reject set (label "(not an item)"). Insertion order is file order. */
export type Objects = ReadonlyMap<Owner, Obj>;
export const REJECT_LABEL = "(not an item)";

/**
 * One object's change in an op. `from` and `to` are the label before and after, null for an object the op created
 * or deleted. Both are absent if the object existed throughout with the same label. `add` and `remove` are the
 * members gained and lost.
 */
export type Change = {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly add?: readonly DetId[];
  readonly remove?: readonly DetId[];
};
export type Diff = Readonly<Record<string, Change>>;

/**
 * An op to append to ops.jsonl, as labelling hands it to its LabelLog. `diff` makes it undoable. `changes`
 * (clip_remove) records a change that can't be undone.
 */
export type OpLine =
  | {
      readonly op: "new";
      readonly obj: ObjectId;
      readonly label: string;
      readonly ids: readonly DetId[];
      readonly diff: Diff;
    }
  | { readonly op: "add"; readonly obj: Owner; readonly ids: readonly DetId[]; readonly diff: Diff }
  | { readonly op: "remove"; readonly obj: Owner; readonly ids: readonly DetId[]; readonly diff: Diff }
  | { readonly op: "merge"; readonly into: ObjectId; readonly from: ObjectId; readonly diff: Diff }
  | { readonly op: "label"; readonly obj: Owner; readonly label: string; readonly diff: Diff }
  | { readonly op: "delete"; readonly obj: ObjectId; readonly diff: Diff }
  | { readonly op: "reject"; readonly ids: readonly DetId[]; readonly diff: Diff }
  | { readonly op: "undo"; readonly of: number; readonly diff: Diff }
  | { readonly op: "redo"; readonly of: number; readonly diff: Diff }
  | {
      readonly op: "clip_remove";
      readonly clip: ClipKey;
      readonly path: string;
      readonly frames: readonly [FrameNo, FrameNo];
      readonly deleted: readonly ObjectId[];
      readonly changes: Diff;
    };

/**
 * A parsed ops.jsonl line. `seq` is its index among non-empty lines. A hand-edited or malformed line ({op: "?"})
 * keeps whatever fields it has, so the shape stays open. data.history returns entries as they are.
 */
type OpEntryKnown = {
  readonly seq: number;
  readonly op: string;
  readonly ts?: number;
  readonly of?: number;
  readonly diff?: Diff;
  readonly changes?: Diff;
};
export type OpEntry = OpEntryKnown & { readonly [k: string]: unknown };
/** An entry as replies show it, which is everything but the diff. */
export type OpEntrySansDiff = Omit<OpEntryKnown, "diff"> & { readonly [k: string]: unknown };

type OpBrief = { readonly seq: number; readonly op: string };
/** Top of the undo and redo stacks. */
export type HistoryState = { readonly undo: OpBrief | null; readonly redo: OpBrief | null };
type HistoryOp = OpEntrySansDiff & {
  readonly undoable: boolean;
  readonly undone: boolean;
  /** Objects the diff touched. */
  readonly objects: readonly string[];
};
export type HistoryView = HistoryState & { readonly ops: readonly HistoryOp[] };

/** Why undo or redo can't replay a diff, because the objects changed since. The wording lives in api. */
export type ReplayFailure =
  | { readonly kind: "exists"; readonly obj: string }
  | { readonly kind: "gone"; readonly obj: string }
  | { readonly kind: "label-mismatch"; readonly obj: string; readonly actual: string; readonly expected: string }
  | { readonly kind: "members-missing"; readonly obj: string; readonly ids: readonly string[] }
  | { readonly kind: "members-present"; readonly obj: string; readonly ids: readonly string[] }
  /** A diff key that is not an object id (a hand-edited or corrupt ops.jsonl). */
  | { readonly kind: "not-an-object"; readonly obj: string };

export type DiffObjects = (before: Objects, after: Objects) => Diff;
export type InvertDiff = (d: Diff) => Diff;
/** The objects with all of `d` applied, or why not. */
export type ApplyDiff = (objects: Objects, d: Diff) => Result<Objects, ReplayFailure>;
export type Stacks = (entries: readonly OpEntry[]) => {
  readonly undo: readonly number[];
  readonly redo: readonly number[];
  readonly undone: ReadonlySet<number>;
};

/** Rounds x to n decimals, half up, in double, for scores and similarities in replies. */
export const round = (x: number, n: number): number => Math.round(x * 10 ** n) / 10 ** n;
