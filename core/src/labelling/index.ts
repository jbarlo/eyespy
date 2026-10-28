/**
 * The labelling module holds what a person or LLM decided. That means objects that group detections, the reject
 * set, ownership, and undo/redo over the op log. An op runs its checks in a fixed order that is part of the API.
 * This module never imports detections as a value. It goes through DetectionLookup.
 */
export type { Commit, DetectionLookup, LabelLog } from "./ports.ts";
export type {
  Diff,
  HistoryState,
  HistoryView,
  ObjectId,
  Objects,
  OpEntry,
  OpEntrySansDiff,
  Owner,
  ReplayFailure,
} from "./pure.ts";
export type { Labelling, LabellingError, LabellingOptions, ObjectMatch, ObjectSummary } from "./types.ts";
export { createLabelling } from "./internal/labelling.ts";
