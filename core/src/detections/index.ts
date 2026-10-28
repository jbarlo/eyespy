/**
 * The detections module holds what the models saw: immutable detections with stable "frame.n" ids, and the runs
 * that produced them. It has no ports and does no IO. The session persists it. Per-frame counters never go down.
 */
export type { DetId, Detection, HeatmapRef, Run, RunRecord } from "./pure.ts";
export type { Detections, DetectionsError } from "./types.ts";
export { createDetections } from "./internal/detections.ts";
