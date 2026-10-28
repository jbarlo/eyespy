/** What video requires, in its own vocabulary. Storage satisfies FrameStore and the host's codec ImageDecoder. */
import type { ResultAsync } from "neverthrow";
import type { RGB } from "../pixels/index.ts";
import type { ClipSource, Clock, HostFailure, Logger } from "../ports/index.ts";
import type { FrameRef } from "./pure.ts";

/** Keyframe JPEGs of the session folder, by FrameRef. A missing file gives null or false. */
export interface FrameStore {
  read(ref: FrameRef): ResultAsync<Uint8Array | null, HostFailure>;
  write(ref: FrameRef, jpeg: Uint8Array): ResultAsync<void, HostFailure>;
  has(ref: FrameRef): ResultAsync<boolean, HostFailure>;
}

interface ImageDecoder {
  decode(jpeg: Uint8Array): Promise<RGB>;
}

export type VideoPorts = {
  readonly source: ClipSource;
  readonly frames: FrameStore;
  readonly decoder: ImageDecoder;
  /** For tombstone times. */
  readonly clock: Clock;
  readonly logger: Logger;
};
