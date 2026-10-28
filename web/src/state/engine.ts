/**
 * Engine lifecycle and what it reports. `generation` counts session closes (each open begins with one), for
 * openSession's stale-start check.
 */
import type { EngineEvent, EngineSession } from "./ports.ts";
import { slice } from "./slice.ts";
import type { SessionLocation, Status } from "./types.ts";

type Phase = "starting" | "ready" | "failed";
type Download = {
  readonly loaded: number;
  readonly total: number;
  readonly done: boolean;
  readonly source: "network" | "cache";
};
type Progress = { readonly file: string; readonly stage: string; readonly fraction: number };

export type EngineState = {
  readonly phase: Phase;
  readonly error: string | null;
  readonly session: EngineSession | null;
  readonly generation: number;
  readonly label: string;
  readonly kind: "opfs" | "folder";
  /** Where the open session lives. */
  readonly location: SessionLocation | null;
  readonly status: Status | null;
  readonly config: Readonly<Record<string, number>>;
  readonly downloads: Readonly<Record<string, Download>>;
  /** Video decoding progress (the grey stream keyframes are picked from). */
  readonly progress: Progress | null;
  readonly logs: readonly string[];
};

const LOG_TAIL = 200;

export const createEngineStore = () =>
  slice<EngineState>(() => ({
    phase: "starting",
    error: null,
    session: null,
    generation: 0,
    label: "",
    kind: "opfs",
    location: null,
    status: null,
    config: {},
    downloads: {},
    progress: null,
    logs: [],
  }));

/** The store change an engine event makes (download progress, decoding progress, log tail). */
export function applyEvent(s: EngineState, ev: EngineEvent): Partial<EngineState> {
  switch (ev.kind) {
    case "download":
      return {
        downloads: {
          ...s.downloads,
          [ev.name]: { loaded: ev.loaded, total: ev.total, done: ev.done, source: ev.source },
        },
      };
    case "progress":
      return { progress: ev.fraction >= 1 ? null : { file: ev.file, stage: ev.stage, fraction: ev.fraction } };
    case "log":
      return { logs: [...s.logs.slice(-(LOG_TAIL - 1)), ev.text] };
    case "unsupported": // the can't-decode dialog (notices) shows it
    case "ready":
      return {};
  }
}

/** Log lines that are failures the user should see (an op failed, background work broke). */
export const isFailureLog = (text: string) => / failed:|^background:/.test(text);
