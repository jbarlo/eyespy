/** Object identity, op-log shapes and the pure undo/redo functions. Any code may import these as values. */
export * from "./model.ts";
export {
  /** @internal */ applyDiff,
  /** @internal */ diffObjects,
  /** @internal */ invertDiff,
} from "./internal/diff.ts";
export { /** @internal */ historyView, /** @internal */ stacks } from "./internal/history.ts";
export { describeOp } from "./internal/describe.ts";
