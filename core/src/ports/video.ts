/**
 * How a clip's frames are timed, as the host opened it.
 * - `video`: a continuous video the host samples at any rate.
 * - `rate`: `count` frames at `fps` a second, from a folder of frames the user extracted and added with its frame
 *   rate. Frame i is at i / fps seconds.
 * - `stills`: `count` frames without times, from a folder of photos. A frame's "time" is its position in the
 *   folder (0, 1, 2, ...).
 */
export type Timing =
  | { readonly kind: "video" }
  | { readonly kind: "rate"; readonly fps: number; readonly count: number }
  | { readonly kind: "stills"; readonly count: number };

/** An opened clip, with its upright size after rotation, its capture time if the host knows it, and its timing. */
export type ClipFormat = {
  readonly w: number;
  readonly h: number;
  readonly captured: string | null;
  readonly timing: Timing;
};

/** The rate the user gave for a folder of frames when naming the clip, or null for photos or a video. */
export type OpenOptions = { readonly fps: number | null };

/**
 * The frames of a clip the user named, such as a video file or a folder of frames. Keyframes are picked and cut
 * from these. The core never sees a container, codec or decoder.
 */
export interface ClipSource {
  /** Resolves a user-supplied reference to its canonical form, an absolute path in Node. */
  resolve(ref: string): string;
  exists(ref: string): Promise<boolean>;
  /**
   * The clip's content key, 12 lowercase hex digits that depend only on the content, so moving or renaming the clip
   * keeps it. A video file's key comes from its bytes, and a folder's from its frames.
   */
  key(ref: string): Promise<string>;
  /** Opens the clip for reading. Callers use the reads below only on a ref opened in this process. */
  open(ref: string, opts: OpenOptions): Promise<ClipFormat>;
  /**
   * The clip sampled `fps` times a second, never above a `rate` clip's own fps. Each sample is upright 8-bit luma
   * scaled to w×h, and the samples are concatenated. Sample n is the clip at n / fps seconds.
   */
  grayStream(ref: string, fps: number, w: number, h: number): Promise<Uint8Array>;
  /** The full-resolution upright frame at time t, or at position t for a `stills` clip, as JPEG bytes. */
  frameJpeg(ref: string, t: number): Promise<Uint8Array>;
}
