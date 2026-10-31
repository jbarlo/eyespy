/**
 * Clip and frame identity, plus the small pure helpers hosts share. Brands come from validating, never from
 * casting, so any FrameNo or ClipKey has passed `isFrameNo` or `isClipKey`.
 */
import { err, ok, Result, ResultAsync } from "neverthrow";
import { invariant } from "../invariant/index.ts";
import type { Shape } from "../pixels/index.ts";
import type { HostFailure } from "../ports/index.ts";
import { hostFailure } from "../ports/index.ts";
import { sha1Hex } from "../railway/index.ts";

/** Global keyframe index over every clip of the session. Removed clips are included and keep their indices. */
export type FrameNo = number & { readonly brand: "video.FrameNo" };
/** A clip key, from `contentKeyOf` for a video file and `framesKey` for a folder of frames. */
export type ClipKey = string & { readonly brand: "video.ClipKey" };

export const isFrameNo = (n: number): n is FrameNo => Number.isInteger(n) && n >= 0;
export const isClipKey = (s: string): s is ClipKey => /^[0-9a-f]{12}$/.test(s);

/**
 * A keyframe's place in its clip as tags and text print it: "photo <position>" for a photo of a `stills` clip,
 * else "<t>s" to one decimal.
 */
export const placeOf = (f: { readonly t: number; readonly photo?: boolean }): string =>
  f.photo ? `photo ${f.t}` : `${f.t.toFixed(1)}s`;

/** A frame as the session folder files it, by clip and the keyframe's index within the clip. */
export type FrameRef = { readonly clipKey: ClipKey; readonly index: number };

/** A removed clip's tombstone. `at` is seconds since the epoch to 3 decimals (session.json `removed`). */
type Tombstone = { readonly at: number };

/**
 * What a clip's keyframe times mean.
 * - `video`: seconds into a video file.
 * - `rate`: seconds into a folder of frames at `fps`.
 * - `stills`: positions in a folder of photos (0, 1, 2, ...).
 */
export type ClipTiming =
  { readonly kind: "video" } | { readonly kind: "rate"; readonly fps: number } | { readonly kind: "stills" };

export type Clip = {
  readonly path: string;
  readonly key: ClipKey;
  /** Keyframe times in seconds to 2 decimals, or positions for `stills` (see `timing`). */
  readonly times: readonly number[];
  readonly timing: ClipTiming;
  readonly shape: Shape;
  readonly captured: string | null;
  /** The keyframe_thresh the clip was picked with, or null if session.json doesn't record it. */
  readonly keyframeThresh: number | null;
  /** Set while the clip is removed. */
  readonly removed: Tombstone | null;
  /**
   * Per-frame detection counters to continue from (session.json `next_n`). Removing the clip records them, so a
   * revived frame never reissues an id that ops.jsonl or an exported manifest already used. Revival keeps them.
   */
  readonly reserved: ReadonlyMap<FrameNo, number>;
};

export type FrameSlot = { readonly clip: Clip; readonly index: number; readonly t: number };

/** `frame` is any number the caller had. It is not a keyframe of this session, or it belongs to a removed clip. */
export type NoKeyframe = { readonly kind: "no-keyframe"; readonly frame: number };
type MissingFrameFile = { readonly kind: "missing-frame-file"; readonly frame: FrameNo };
/** Reads a frame image. Perception's and render's frame ports use this shape, so compose passes video in as is. */
export type FrameAccessError = NoKeyframe | MissingFrameFile | HostFailure;

/** A part of a frame spec that isn't `N` or `N-M` with N <= M (`"abc"`, `"1.5"`, `"-1"`, `"1-"`, `"2-0"`, `""`). */
export type FrameSpecError = { readonly kind: "bad-frame-spec"; readonly part: string };

/** Frames of a spec such as "3-10,15" within [0, n). A number is one frame, and empty or null is every frame. */
export type ParseFrameSpec = (
  spec: string | number | null | undefined,
  n: number,
) => Result<readonly FrameNo[], FrameSpecError>;

const SPEC_PART = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/;

/**
 * Parts come in order, ranges are inclusive, and duplicates stay ("1-3,3" gives 1,2,3,3). Out-of-range frames are
 * dropped without an error ("0-99", "99"). "1-" and "2-0" are errors rather than one frame or none, because the
 * agent likely meant "onwards" or a range and a quiet answer would hide the mistake. An empty part (`"0,,1"`)
 * reports the whole spec, so the message names something.
 */
export const parseFrameSpec: ParseFrameSpec = (spec, n) => {
  const all = Array.from({ length: Math.max(0, n) }, (_, i) => i).filter(isFrameNo);
  if (spec === undefined || spec === null || spec === "") return ok(all);
  const text = String(spec);
  const parts = text.split(",").map((part) => {
    const m = SPEC_PART.exec(part);
    const a = m?.[1] === undefined ? NaN : Number.parseInt(m[1], 10);
    const b = m?.[2] === undefined ? a : Number.parseInt(m[2], 10);
    return m && a <= b
      ? ok({ a, b })
      : err<{ a: number; b: number }, FrameSpecError>({
          kind: "bad-frame-spec",
          part: part.trim() === "" ? text : part,
        });
  });
  return Result.combine(parts).map((ranges) =>
    ranges.flatMap(({ a, b }) => all.slice(Math.min(a, all.length), Math.min(b + 1, all.length))),
  );
};

/** Bytes hashed for the content key, from the first and last MiB. @internal */
export const CONTENT_KEY_RANGE = 1 << 20;
/** sha1(size + head + tail)[:12], with size as decimal text. */
export type ContentKey = (size: number, head: Uint8Array, tail: Uint8Array) => Promise<ClipKey>;
/** A video file's bytes, as `contentKeyOf` reads them. */
type ByteSource = {
  /** File size in bytes. */
  size(ref: string): Promise<number>;
  /** Bytes [start, end) of the file. Fewer bytes come back at the end of the file. */
  readRange(ref: string, start: number, end: number): Promise<Uint8Array>;
};
/** `contentKey` over a file's `size` and `readRange`. */
export type ContentKeyOf = (src: ByteSource, ref: string) => ResultAsync<ClipKey, HostFailure>;

/** @internal */
export const contentKey: ContentKey = async (size, head, tail) => {
  const prefix = new TextEncoder().encode(String(size));
  const all = new Uint8Array(prefix.length + head.length + tail.length);
  all.set(prefix, 0);
  all.set(head, prefix.length);
  all.set(tail, prefix.length + head.length);
  const key = (await sha1Hex(all)).slice(0, 12);
  invariant(isClipKey(key), () => `sha1 hex ${key} is not a clip key`);
  return key;
};

/**
 * The head is [0, min(MiB, size)). The tail is the same length, ending at the end of the file. For a small file,
 * both are the whole file.
 */
export const contentKeyOf: ContentKeyOf = (src, ref) => {
  const read = (start: number, end: number) =>
    ResultAsync.fromPromise(src.readRange(ref, start, end), (e) => hostFailure("video", "readRange", e));
  return ResultAsync.fromPromise(src.size(ref), (e) => hostFailure("video", "size", e)).andThen((size) => {
    const n = Math.min(CONTENT_KEY_RANGE, size);
    const tailStart = Math.max(0, size - CONTENT_KEY_RANGE);
    return read(0, n).andThen((head) =>
      read(tailStart, tailStart + n).andThen((tail) => ResultAsync.fromSafePromise(contentKey(size, head, tail))),
    );
  });
};

/** Why a folder isn't a clip. Either nothing in it is a frame, or something in it isn't one. */
export type FramesFolderError =
  | { readonly kind: "no-frames" }
  /** The first few files, sorted, that are neither JPEG or PNG frames nor hidden. */
  | { readonly kind: "not-frames"; readonly names: readonly string[] };

const FRAME_FILE = /\.(?:jpe?g|png)$/i;

/**
 * Natural order. Runs of digits compare by value ("2" < "10"), then by length ("01" after "1"). Everything else
 * compares by UTF-16 code unit. @internal
 */
export const naturalCompare = (a: string, b: string): number => {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  const first = Array.from({ length: Math.min(ta.length, tb.length) }, (_, i) =>
    compareRuns(ta[i] ?? "", tb[i] ?? ""),
  ).find((c) => c !== 0);
  return first ?? ta.length - tb.length;
};

const compareRuns = (x: string, y: string): number => {
  if (x === y) return 0;
  if (!/^\d/.test(x) || !/^\d/.test(y)) return x < y ? -1 : 1;
  const vx = BigInt(x);
  const vy = BigInt(y);
  return vx === vy ? x.length - y.length : vx < vy ? -1 : 1;
};

/**
 * The frames of a folder, from the names of its regular files. Every .jpg, .jpeg or .png (any case) is a frame, in
 * natural order ("frame2" before "frame10"). Hidden files (".DS_Store") are ignored. Any other file is an error, so
 * a stray file never becomes a frame, and the error for a folder of the wrong files names them.
 */
export const frameFiles = (names: readonly string[]): Result<readonly string[], FramesFolderError> => {
  const visible = names.filter((n) => !n.startsWith("."));
  const others = visible.filter((n) => !FRAME_FILE.test(n)).toSorted(naturalCompare);
  if (others.length) return err({ kind: "not-frames", names: others.slice(0, 3) });
  const frames = visible.toSorted(naturalCompare);
  return frames.length ? ok(frames) : err({ kind: "no-frames" });
};

/** The user-facing sentence for a folder that isn't a clip. */
export const describeFramesError = (dir: string, e: FramesFolderError): string =>
  e.kind === "no-frames"
    ? `no frames in ${dir} (a clip is a folder of JPEG or PNG images)`
    : `${dir} has files that aren't JPEG or PNG frames: ${e.names.join(", ")} (a clip is a folder of images only)`;

/** A frame file and the hex SHA-1 of its bytes. */
export type FrameDigest = { readonly name: string; readonly sha1: string };

/**
 * The content key of a folder of frames, the first 12 hex digits of the sha1 of its `sha1sum`-style manifest. The
 * manifest has one "<sha1 hex>  <name>\n" line per frame, in `frameFiles` order, with names lacking the folder. The
 * frames' names, order and bytes make the key. The folder's own name and place don't.
 */
export const framesKey = async (frames: readonly FrameDigest[]): Promise<ClipKey> => {
  const manifest = frames.map((f) => `${f.sha1}  ${f.name}\n`).join("");
  const key = (await sha1Hex(new TextEncoder().encode(manifest))).slice(0, 12);
  invariant(isClipKey(key), () => `sha1 hex ${key} is not a clip key`);
  return key;
};

// A `rate` folder of `count` frames, with frame k at k / fps, is read the way the browser reads a video. Grey
// samples are those ffmpeg's `fps` filter picks, and keyframes are those an accurate seek finds. A folder holding
// every frame of a video therefore gives the keyframes the video gives.

const clampFrame = (k: number, count: number) => Math.min(Math.max(0, k), Math.max(0, count - 1));

/**
 * The keyframe at time t, given to 2 decimals as clips record times. It is the first frame at or after t, as an
 * accurate seek finds. t is taken as t - 0.005, the most rounding can have added, so a frame's own rounded time
 * finds it again up to 100 fps.
 */
export const frameAt = (t: number, fps: number, count: number): number =>
  clampFrame(Math.ceil((t - 0.005) * fps - 1e-9), count);

/**
 * Grey sample n of a folder sampled at `rate` <= fps, as ffmpeg's fps filter and the browser's grey stream pick it.
 * It is the last frame whose time rounds to slot n (k · rate / fps < n + 0.5), or else the latest earlier one.
 */
export const sampleAt = (n: number, rate: number, fps: number, count: number): number =>
  clampFrame(Math.ceil(((n + 0.5) * fps) / rate - 1e-9) - 1, count);

/** How many grey samples a folder has at `rate`. Its last frame lasts until count / fps. */
export const sampleCount = (rate: number, fps: number, count: number): number =>
  Math.max(1, Math.round((count * rate) / fps));
