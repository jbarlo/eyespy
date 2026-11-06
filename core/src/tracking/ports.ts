/** What tracking requires. The host's ModelRuntime runs the graphs. Storage satisfies TrackStore. */
import type { ResultAsync } from "neverthrow";
import type { Clock, HostFailure, Logger, ModelRuntime } from "../ports/index.ts";
import type { ClipKey } from "../video/pure.ts";
import type { AssocData, TrackDirection, TrackIndex, TrackMask, TrackedFrame } from "./pure.ts";

export type TrackingPorts = {
  readonly runtime: ModelRuntime;
  readonly clock: Clock;
  readonly logger: Logger;
};

/** Where one track's files live: its clip, so that removing the clip removes them, and its id. */
export type TrackPlace = { readonly clip: ClipKey; readonly track: string };

/** What a seed leaves on disk. The rest of a TrackSeed is in the index. */
export type StoredSeed = { readonly tokens: Float32Array; readonly pointer: Float32Array };

/**
 * Saved tracks. Everything but the index is data that nothing reads until the index names it. A unit therefore writes
 * its data first and the index after, as a find writes detections and then dets.json. A crash between the two leaves
 * files the next run writes again.
 */
export interface TrackStore {
  /** The index, empty if none was ever written, or null if the file doesn't parse. */
  readIndex(): ResultAsync<TrackIndex | null, HostFailure>;
  /** Replaces the index atomically. */
  writeIndex(index: TrackIndex): ResultAsync<void, HostFailure>;
  /** What association decided, empty if none was written or the file doesn't parse, as it can be made again. */
  readAssoc(): ResultAsync<AssocData, HostFailure>;
  writeAssoc(assoc: AssocData): ResultAsync<void, HostFailure>;
  writeSeed(at: TrackPlace, seed: StoredSeed): ResultAsync<void, HostFailure>;
  readSeed(at: TrackPlace): ResultAsync<StoredSeed | null, HostFailure>;
  writeMask(at: TrackPlace, frame: number, mask: TrackMask): ResultAsync<void, HostFailure>;
  readMask(at: TrackPlace, frame: number): ResultAsync<TrackMask | null, HostFailure>;
  /** A leg's recent frames as of its last frame `frame`. Older files stay until `removeMemory`. */
  writeMemory(
    at: TrackPlace,
    direction: TrackDirection,
    frame: number,
    recent: readonly TrackedFrame[],
  ): ResultAsync<void, HostFailure>;
  readMemory(
    at: TrackPlace,
    direction: TrackDirection,
    frame: number,
  ): ResultAsync<readonly TrackedFrame[] | null, HostFailure>;
  removeMemory(at: TrackPlace, direction: TrackDirection, frame: number): ResultAsync<void, HostFailure>;
}
