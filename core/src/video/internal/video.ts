/** The Video instance: the timeline (which add and remove replace), the image LRU, and the add and remove steps. */
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type { RGB, Shape } from "../../pixels/index.ts";
import type { ClipFormat, HostFailure, OpenOptions } from "../../ports/index.ts";
import { hostFailure } from "../../ports/index.ts";
import type { VideoPorts } from "../ports.ts";
import type { Clip, ClipKey, ClipTiming, FrameAccessError, FrameNo, FrameRef, FrameSlot, NoKeyframe } from "../pure.ts";
import { isClipKey, isFrameNo, parseFrameSpec } from "../pure.ts";
import { invariant } from "../../invariant/index.ts";
import type { AddedClip, RemovedClip, Video, VideoError, VideoOptions } from "../types.ts";
import { Lru } from "./images.cache.ts";
import { keyframeRate, pickKeyframes } from "./keyframes.ts";
import type { Timeline } from "./timeline.ts";
import {
  appended,
  find,
  framesAt,
  isLive,
  liveClips,
  positionOf,
  slot,
  tagOf,
  timeline,
  withClip,
} from "./timeline.ts";

const DEFAULT_IMAGE_CACHE = 3;
const frameNo = (n: number): FrameNo => {
  invariant(isFrameNo(n), () => `${n} is not a frame number`);
  return n;
};
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The clip's timing as session.json records it. The frame count is the folder's, not the clip's. */
const timingOf = (f: ClipFormat): ClipTiming =>
  f.timing.kind === "rate" ? { kind: "rate", fps: f.timing.fps } : { kind: f.timing.kind };
/** The rate to open a stored clip at, which is the rate it was added at, so its times mean the same frames. */
const openOptions = (t: ClipTiming): OpenOptions => ({ fps: t.kind === "rate" ? t.fps : null });

export class VideoImpl implements Video {
  private tl: Timeline;
  private readonly images: Lru<FrameNo, RGB>;

  constructor(
    private readonly ports: VideoPorts,
    opts: VideoOptions,
  ) {
    this.tl = timeline(opts.clips);
    this.images = new Lru(Math.max(1, opts.imageCacheSize ?? DEFAULT_IMAGE_CACHE));
  }

  clips(): readonly Clip[] {
    return this.tl.clips;
  }
  liveClips(): readonly Clip[] {
    return liveClips(this.tl);
  }
  findClip(ref: string): Result<Clip, VideoError> {
    const resolved = Result.fromThrowable(
      () => this.ports.source.resolve(ref),
      () => ref,
    )().unwrapOr(ref);
    return find(this.tl, ref, resolved);
  }
  clipFrames(key: ClipKey): readonly FrameNo[] {
    return framesAt(this.tl, positionOf(this.tl, key));
  }
  reserved(): ReadonlyMap<FrameNo, number> {
    // Ascending by counter, so for a frame in several clips (a hand-edited session) the highest is set last.
    return new Map(this.tl.clips.flatMap((c) => [...c.reserved]).toSorted(([, a], [, b]) => a - b));
  }
  live(i: number): i is FrameNo {
    return isLive(this.tl, i);
  }
  frames(spec?: string | number | null): Result<readonly FrameNo[], VideoError> {
    return parseFrameSpec(spec, this.tl.slots.length).map((fs) => fs.filter((i) => isLive(this.tl, i)));
  }
  liveFrames(): readonly FrameNo[] {
    return this.tl.slots.map((_, i) => i).filter((i) => isLive(this.tl, i));
  }
  slot(i: FrameNo): Result<FrameSlot, NoKeyframe> {
    return slot(this.tl, i);
  }
  ref(i: FrameNo): Result<FrameRef, NoKeyframe> {
    return slot(this.tl, i).map((s) => ({ clipKey: s.clip.key, index: s.index }));
  }
  t(i: FrameNo): Result<number, NoKeyframe> {
    return slot(this.tl, i).map((s) => s.t);
  }
  shape(i: FrameNo): Result<Shape, NoKeyframe> {
    return slot(this.tl, i).map((s) => s.clip.shape);
  }
  tag(i: FrameNo): Result<string, NoKeyframe> {
    return slot(this.tl, i).map((s) => tagOf(this.tl, s, i));
  }

  image(i: FrameNo): ResultAsync<RGB, FrameAccessError> {
    const cached = this.images.get(i);
    if (cached) return okAsync(cached);
    return this.ref(i)
      .asyncAndThen((ref) => this.ports.frames.read(ref))
      .andThen((bytes) =>
        bytes === null
          ? errAsync<RGB, FrameAccessError>({ kind: "missing-frame-file", frame: i })
          : ResultAsync.fromPromise(this.ports.decoder.decode(bytes), (e) => hostFailure("codec", "decode", e)),
      )
      .map((img) => {
        this.images.set(i, img);
        return img;
      });
  }
  forget(frames: readonly FrameNo[]): void {
    for (const i of frames) this.images.delete(i);
  }

  addClip(
    ref: string,
    opts: { readonly keyframeThresh: number; readonly fps?: number | null },
  ): ResultAsync<AddedClip, VideoError> {
    const src = this.ports.source;
    return Result.fromThrowable(
      () => src.resolve(ref),
      (e): VideoError => hostFailure("video", "resolve", e),
    )().asyncAndThen((path) =>
      ResultAsync.fromPromise(src.exists(path), (e) => hostFailure("video", "exists", e))
        .andThen((exists) => (exists ? this.key(path) : errAsync<ClipKey, VideoError>({ kind: "no-such-file", path })))
        .andThen((key): ResultAsync<AddedClip, VideoError> => {
          const k = positionOf(this.tl, key);
          const old = this.tl.clips[k];
          if (old && old.removed === null) return errAsync({ kind: "clip-already-present", path });
          return old
            ? this.revive(k, old, path)
            : this.addNew(key, path, opts.keyframeThresh, { fps: opts.fps ?? null });
        }),
    );
  }

  /**
   * The same content key means the same clip, so indices, times, shape, timing and `reserved` stay. A folder of
   * frames opens at the rate it was first added at, whatever rate is asked now. The open is only for the host's
   * decode check.
   */
  private revive(k: number, old: Clip, path: string): ResultAsync<AddedClip, VideoError> {
    return this.open(path, openOptions(old.timing))
      .andThen(() => this.extract(old.key, path, old.times))
      .map(() => {
        const clip: Clip = { ...old, path, removed: null };
        this.tl = withClip(this.tl, k, clip);
        const first = this.firstOf(k);
        this.ports.logger.log(`re-added ${path}: ${clip.times.length} keyframes at #${first} (removed earlier)`);
        return { clip, first, revived: true };
      });
  }

  private addNew(key: ClipKey, path: string, thresh: number, open: OpenOptions): ResultAsync<AddedClip, VideoError> {
    return this.open(path, open).andThen((format) =>
      this.keyframeTimes(path, format, thresh)
        .andThen((times) => this.extract(key, path, times).map(() => times))
        .map((times) => {
          const { w, h, captured } = format;
          const clip: Clip = {
            path,
            key,
            times,
            timing: timingOf(format),
            shape: [h, w],
            captured,
            keyframeThresh: thresh,
            removed: null,
            reserved: new Map(),
          };
          const first = this.tl.slots.length;
          this.tl = appended(this.tl, clip);
          this.ports.logger.log(`added ${path}: ${times.length} keyframes from #${first}`);
          return { clip, first: this.firstOf(this.tl.clips.length - 1), revived: false };
        }),
    );
  }

  private key(path: string): ResultAsync<ClipKey, HostFailure> {
    return ResultAsync.fromPromise(this.ports.source.key(path), (e) => hostFailure("video", "key", e)).andThen((key) =>
      isClipKey(key)
        ? okAsync(key)
        : errAsync(hostFailure("video", "key", new Error(`${key} is not a clip key (12 hex digits)`))),
    );
  }

  private open(path: string, opts: OpenOptions) {
    return ResultAsync.fromPromise(this.ports.source.open(path, opts), (e) => hostFailure("video", "open", e));
  }

  /**
   * Every photo of a `stills` folder, at positions 0 to n-1, since photos aren't a motion sequence. Otherwise the
   * picker runs over the grey stream and returns its sample times, as for a video. The host's frameJpeg finds the
   * frame at or after each time.
   */
  private keyframeTimes(path: string, f: ClipFormat, thresh: number): ResultAsync<readonly number[], HostFailure> {
    const { timing } = f;
    if (timing.kind === "stills") return okAsync(Array.from({ length: timing.count }, (_, i) => i));
    return pickKeyframes(this.ports.source, path, f, thresh, keyframeRate(timing));
  }

  /** Stores the JPEG of each keyframe not stored yet, one at a time. */
  private extract(clipKey: ClipKey, path: string, times: readonly number[]): ResultAsync<void, HostFailure> {
    const { frames, source } = this.ports;
    return times.reduce<ResultAsync<void, HostFailure>>(
      (acc, t, index) =>
        acc.andThen(() => {
          const ref: FrameRef = { clipKey, index };
          return frames
            .has(ref)
            .andThen((has) =>
              has
                ? okAsync(undefined)
                : ResultAsync.fromPromise(source.frameJpeg(path, t), (e) =>
                    hostFailure("video", "frameJpeg", e),
                  ).andThen((jpeg) => frames.write(ref, jpeg)),
            );
        }),
      okAsync(undefined),
    );
  }

  /**
   * First global index of the clip at k. A clip without keyframes, which only a hand-edited session.json can have,
   * would start at the next one.
   */
  private firstOf(k: number): FrameNo {
    const [first] = framesAt(this.tl, k);
    return first ?? frameNo(this.tl.firsts[k] ?? 0);
  }

  removeClip(key: ClipKey, reserved: ReadonlyMap<FrameNo, number>): Result<RemovedClip, VideoError> {
    const k = positionOf(this.tl, key);
    const c = this.tl.clips[k];
    if (!c) return err({ kind: "no-clip", ref: key });
    if (c.removed !== null) return err({ kind: "clip-already-removed", path: c.path });
    const fr = framesAt(this.tl, k);
    const [first] = fr;
    const last = fr[fr.length - 1];
    if (first === undefined || last === undefined) return err({ kind: "clip-no-keyframes", path: c.path });
    const inClip = new Set(fr);
    const merged = new Map(
      [...c.reserved, ...reserved]
        .filter(([f]) => inClip.has(f))
        .map(([f]): [FrameNo, number] => [f, Math.max(c.reserved.get(f) ?? 0, reserved.get(f) ?? 0)]),
    );
    const clip: Clip = { ...c, removed: { at: round3(this.ports.clock.now() / 1000) }, reserved: merged };
    this.tl = withClip(this.tl, k, clip);
    this.forget(fr);
    return ok({ clip, frames: [first, last] });
  }
}
