/**
 * What the state layer needs from the outside, in its own words. The composition root plugs the
 * browser adapters in, and node tests plug in fakes. Every call that can fail returns a ResultAsync, so failures arrive
 * here as values and state turns them into notices.
 */
import type { ResultAsync } from "neverthrow";
import type { EngineError, EngineEvent, EngineOps, EyespyApi } from "../engine/port.ts";
import type { AddResult, Detector, SessionLocation, Usage } from "./types.ts";

export type { EngineError, EngineEvent, EyespyApi };

/** One running engine on one session. */
export type EngineSession = {
  readonly info: { readonly root: string; readonly device: string };
  readonly ops: EngineOps;
  /** A stored file's bytes (null when it's gone). */
  readonly file: (key: string) => ResultAsync<Uint8Array | null, EngineError>;
  readonly addFile: (file: File) => ResultAsync<AddResult, EngineError>;
  /** The JSON wrapper published as window.eyespy (the console panel calls ops by name through it). */
  readonly api: EyespyApi;
  readonly dispose: () => void;
};

export type OpenRequest = {
  readonly session: SessionLocation;
  readonly samLicenseAgreed: boolean;
  readonly detector: Detector;
  readonly persistFeatures: boolean;
  readonly featureDiskMB: number | null;
  readonly featureCacheMB: number;
  readonly onEvent: (e: EngineEvent) => void;
};

export type EnginePort = { readonly open: (req: OpenRequest) => ResultAsync<EngineSession, EngineError> };

export type HostError = { readonly kind: "host"; readonly message: string };

export type Prefs = {
  readonly get: (key: string) => string | null;
  readonly set: (key: string, value: string) => void;
};

/** Browser storage outside the open session: preferences, the other OPFS sessions, quota. */
export type BrowserStorage = {
  readonly prefs: Prefs;
  readonly listSessions: () => ResultAsync<readonly string[], HostError>;
  readonly usage: () => ResultAsync<Usage, HostError>;
  /** Delete the stored vision features of every OPFS session except `keep`; resolves to the folders removed. */
  readonly clearFeatures: (keep: string | null) => ResultAsync<number, HostError>;
  /** Delete one OPFS session's stored features (not the open one, whose engine does that). */
  readonly clearSessionFeatures: (name: string) => ResultAsync<number, HostError>;
  /** Delete one OPFS session entirely (not the open one). */
  readonly deleteSession: (name: string) => ResultAsync<void, HostError>;
  /** navigator.storage.persist(): ask the browser not to evict the site's storage; resolves to its answer. */
  readonly persist: () => ResultAsync<boolean, HostError>;
};

export type Query = { readonly get: (key: string) => string | null };

/** Timers, injectable for tests; each returns its cancel function. */
export type Clock = {
  readonly every: (ms: number, fn: () => void) => () => void;
  readonly after: (ms: number, fn: () => void) => () => void;
};

/** Page capabilities: the folder picker (null when the browser has none; resolves null if cancelled), downloads. */
export type Host = {
  readonly pickDirectory: (() => ResultAsync<FileSystemDirectoryHandle | null, HostError>) | null;
  readonly download: (name: string, text: string, type: string) => void;
};
