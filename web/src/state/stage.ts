/**
 * The mounted canvas as a handle. The Stage registers itself here so keyboard shortcuts and automation
 * (window.eyespyStage) reach it without a module-level singleton. Null while no Stage is mounted.
 */
import { slice } from "./slice.ts";

/** Redraw counters: draws, last/max/total ms, and the last frame drawn with its image loaded (a live object). */
export type StageStats = {
  draws: number;
  last: number;
  max: number;
  total: number;
  bitmapFrame: number;
};

export type StageHandle = {
  /** Screen (client) coordinates of a frame pixel, for tests and computer-use agents. */
  readonly toClient: (x: number, y: number) => { readonly x: number; readonly y: number };
  readonly zoom: (factor: number, cx?: number, cy?: number) => void;
  readonly fit: () => void;
  readonly stats: StageStats;
};

export type StageState = { readonly handle: StageHandle | null };

export const createStageStore = () => slice<StageState>(() => ({ handle: null }));
