import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { hostFailure, type HostFailure } from "../../src/ports/index.ts";
import { createVideo, type Clip, type FrameRef, type FrameStore, type Video } from "../../src/video/index.ts";
import { FakeClock, FakeCodec, FakeLogger, FakeVideo, WORLD } from "../fakes/index.ts";
import type { Scene } from "../fakes/scene.ts";

export class MemFrames implements FrameStore {
  readonly files = new Map<string, Uint8Array>();
  /** Methods that fail (host failure) while listed. */
  failing = new Set<"read" | "write" | "has">();
  reads = 0;

  static key = (r: FrameRef) => `${r.clipKey}/${String(r.index).padStart(3, "0")}`;
  private run<T>(op: "read" | "write" | "has", f: () => T): ResultAsync<T, HostFailure> {
    return this.failing.has(op) ? errAsync(hostFailure("store", op, new Error(`${op} failed`))) : okAsync(f());
  }
  read(ref: FrameRef) {
    this.reads++;
    return this.run("read", () => this.files.get(MemFrames.key(ref)) ?? null);
  }
  write(ref: FrameRef, jpeg: Uint8Array) {
    return this.run("write", () => void this.files.set(MemFrames.key(ref), jpeg));
  }
  has(ref: FrameRef) {
    return this.run("has", () => this.files.has(MemFrames.key(ref)));
  }
}

export type Wired = {
  video: Video;
  source: FakeVideo;
  frames: MemFrames;
  codec: FakeCodec;
  clock: FakeClock;
  logger: FakeLogger;
};

export function wire(
  clips: readonly Clip[] = [],
  frames = new MemFrames(),
  imageCacheSize?: number,
  scene: Scene = WORLD,
): Wired {
  const source = new FakeVideo(scene);
  const codec = new FakeCodec();
  const clock = new FakeClock();
  const logger = new FakeLogger();
  const video = createVideo(
    { source, frames, decoder: codec, clock, logger },
    { clips, ...(imageCacheSize ? { imageCacheSize } : {}) },
  );
  return { video, source, frames, codec, clock, logger };
}
