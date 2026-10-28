/**
 * What perception requires, in its own vocabulary. The host's ModelRuntime runs models. Storage satisfies
 * FeatureStore (raw feature bytes by FrameRef). Video satisfies FrameImages, and compose passes it in as is.
 */
import type { Result, ResultAsync } from "neverthrow";
import type { RGB } from "../pixels/index.ts";
import type { Clock, HostFailure, Logger, ModelRuntime } from "../ports/index.ts";
import type { ClipKey, FrameAccessError, FrameNo, FrameRef, NoKeyframe } from "../video/pure.ts";

/** Stored feature files of FEATURE_BYTES each. A missing file gives null or false. */
export interface FeatureStore {
  /**
   * The file's bytes, which then belong to the caller. The store never reuses or changes them, so perception keeps
   * a view over them as the frame's Features without a copy.
   */
  read(ref: FrameRef): ResultAsync<Uint8Array | null, HostFailure>;
  write(ref: FrameRef, bytes: Uint8Array): ResultAsync<void, HostFailure>;
  has(ref: FrameRef): ResultAsync<boolean, HostFailure>;
  remove(ref: FrameRef): ResultAsync<void, HostFailure>;
  /** A clip's stored feature files with their sizes and modification times. The disk budget starts from this list. */
  list(
    clip: ClipKey,
  ): ResultAsync<readonly { readonly ref: FrameRef; readonly bytes: number; readonly mtime: number }[], HostFailure>;
}

/** The keyframes to encode. Says which exist, where their features are filed, and what their pixels are. */
export interface FrameImages {
  liveFrames(): readonly FrameNo[];
  ref(i: FrameNo): Result<FrameRef, NoKeyframe>;
  image(i: FrameNo): ResultAsync<RGB, FrameAccessError>;
}

export type PerceptionPorts = {
  readonly runtime: ModelRuntime;
  readonly features: FeatureStore;
  readonly frames: FrameImages;
  /** Timing logs. */
  readonly clock: Clock;
  readonly logger: Logger;
};
