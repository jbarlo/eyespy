/**
 * The undo/redo stacks, folded from the op log so they survive restarts. Undo logs {"op": "undo", "of": <seq>,
 * "diff": <what it applied>} and redo logs {"op": "redo", ...}. A line without a diff (`clip_remove`, or a malformed
 * or hand-edited line) is a barrier, and nothing before it can be undone.
 *
 * The instance folds one O(1) `step` per entry over persistent stacks as entries arrive. Refolding the whole log on
 * each call with array copies would be O(n²).
 */
import type { HistoryState, HistoryView, OpEntry, Stacks } from "../model.ts";
import type { Stack } from "../../railway/index.ts";
import { push, toArray } from "../../railway/index.ts";

export type StackState = {
  /** Seqs of undoable entries, top first. */
  readonly undo: Stack<number>;
  readonly redo: Stack<number>;
  /** Every matched undo (true) or redo (false) by seq, newest first. The newest for a seq says whether it is undone. */
  readonly toggles: Stack<readonly [number, boolean]>;
};

const NO_STACKS: StackState = { undo: null, redo: null, toggles: null };

/**
 * The stacks `s` after entry `e`. An undo or redo line that doesn't match its stack's top, or has no `of`, clears
 * both stacks like any barrier. A new undoable entry clears the redo stack.
 */
export const step = (s: StackState, e: OpEntry): StackState => {
  if (e.op === "undo" || e.op === "redo") {
    const isUndo = e.op === "undo";
    const from = isUndo ? s.undo : s.redo;
    const to = isUndo ? s.redo : s.undo;
    const of = e.of;
    if (typeof of !== "number" || from === null || from.top !== of)
      return { undo: null, redo: null, toggles: s.toggles };
    const toggles = push(s.toggles, [of, isUndo] as const);
    const popped = from.rest,
      pushed = push(to, of);
    return isUndo ? { undo: popped, redo: pushed, toggles } : { undo: pushed, redo: popped, toggles };
  }
  return { undo: e.diff ? push(s.undo, e.seq) : null, redo: null, toggles: s.toggles };
};

export const fold = (entries: readonly OpEntry[]): StackState => entries.reduce(step, NO_STACKS);

const undoneOf = (s: StackState): ReadonlySet<number> =>
  new Set([...new Map(toArray(s.toggles))].flatMap(([seq, undone]) => (undone ? [seq] : [])));

const brief = (entries: readonly OpEntry[], top: Stack<number>) => {
  const e = top === null ? undefined : entries[top.top];
  return e === undefined ? null : { seq: e.seq, op: e.op };
};

/** The entries at the tops of the stacks `s`. */
export const stateOf = (entries: readonly OpEntry[], s: StackState): HistoryState => ({
  undo: brief(entries, s.undo),
  redo: brief(entries, s.redo),
});

/** The op log for data.history, oldest first and without diffs. `undone` marks entries that are currently reverted. */
export const viewOf = (entries: readonly OpEntry[], s: StackState): HistoryView => {
  const undone = undoneOf(s);
  const ops = entries.map(({ diff, ...e }) => ({
    ...e,
    undoable: !!diff && e.op !== "undo" && e.op !== "redo",
    undone: undone.has(e.seq),
    objects: diff ? Object.keys(diff) : [],
  }));
  return { ops, ...stateOf(entries, s) };
};

/** Undo/redo stacks (seqs of undoable entries, top last) and the set of entries currently undone. */
export const stacks: Stacks = (entries) => {
  const s = fold(entries);
  return { undo: toArray(s.undo), redo: toArray(s.redo), undone: undoneOf(s) };
};

export const historyView = (entries: readonly OpEntry[]): HistoryView => viewOf(entries, fold(entries));
