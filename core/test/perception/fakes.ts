import { errAsync, okAsync, err, ok } from "neverthrow";
import type { RGB } from "../../src/pixels/index.ts";
import { createPerception } from "../../src/perception/index.ts";
import type { FeatureStore, FrameImages, Perception, PerceptionOptions } from "../../src/perception/index.ts";
import { FEATURE_FORMAT } from "../../src/perception/pure.ts";
import type { HostFailure } from "../../src/ports/index.ts";
import { isClipKey, isFrameNo, type ClipKey, type FrameNo, type FrameRef } from "../../src/video/pure.ts";
import { FakeClock, FakeLogger, FakeModelRuntime, type FakeRuntimeOptions } from "../fakes/index.ts";
import { noise } from "../fixtures/numerics/lib.ts";

export const fno = (n: number): FrameNo => {
  if (!isFrameNo(n)) throw new Error(`bad frame ${n}`);
  return n;
};
const KEY = "0a1b2c3d4e01";
if (!isClipKey(KEY)) throw new Error("bad clip key");
export const refOf = (i: number): FrameRef => ({ clipKey: KEY, index: i });
const keyOf = (r: FrameRef) => `${r.clipKey}/${r.index}`;

const hostErr = (op: string): HostFailure => ({ kind: "host", port: "store", op, message: "boom" });

export class MemFeatureStore implements FeatureStore {
  readonly files = new Map<string, Uint8Array>();
  /** Modification "times" from a counter that every write and put bumps. Tests may set them. */
  readonly mtimes = new Map<string, number>();
  private tick = 0;
  readonly calls = { read: 0, write: 0, has: 0, remove: 0, list: 0 };
  fail = false;
  read(ref: FrameRef) {
    this.calls.read++;
    return this.fail ? errAsync(hostErr("read")) : okAsync(this.files.get(keyOf(ref)) ?? null);
  }
  write(ref: FrameRef, bytes: Uint8Array) {
    this.calls.write++;
    if (this.fail) return errAsync(hostErr("write"));
    this.files.set(keyOf(ref), bytes.slice());
    this.mtimes.set(keyOf(ref), ++this.tick);
    return okAsync(undefined);
  }
  has(ref: FrameRef) {
    this.calls.has++;
    return this.fail ? errAsync(hostErr("has")) : okAsync(this.files.has(keyOf(ref)));
  }
  remove(ref: FrameRef) {
    this.calls.remove++;
    this.files.delete(keyOf(ref));
    this.mtimes.delete(keyOf(ref));
    return okAsync(undefined);
  }
  put(i: number, bytes: Uint8Array) {
    this.files.set(keyOf(refOf(i)), bytes);
    this.mtimes.set(keyOf(refOf(i)), ++this.tick);
  }
  list(clip: ClipKey) {
    this.calls.list++;
    if (this.fail) return errAsync(hostErr("list"));
    const out = [...this.files]
      .filter(([k]) => k.startsWith(`${clip}/`))
      .map(([k, b]) => ({
        ref: { clipKey: clip, index: Number(k.slice(clip.length + 1)) },
        bytes: b.byteLength,
        mtime: this.mtimes.get(k) ?? 0,
      }));
    return okAsync(out);
  }
  /** Stored frame indices, sorted. */
  frames(): number[] {
    return [...this.files.keys()].map((k) => Number(k.split("/")[1])).sort((a, b) => a - b);
  }
  hasFrame(i: number) {
    return this.files.has(keyOf(refOf(i)));
  }
}

export class FakeFrames implements FrameImages {
  live: number[];
  readonly missing = new Set<number>();
  readonly hostFailing = new Set<number>();
  readonly reads: number[] = [];
  constructor(
    n: number,
    readonly w = 64,
    readonly h = 48,
  ) {
    this.live = Array.from({ length: n }, (_, i) => i);
  }
  img(i: number): RGB {
    return noise(100 + i, this.w, this.h);
  }
  liveFrames() {
    return this.live.map(fno);
  }
  ref(i: FrameNo) {
    return this.live.includes(i) ? ok(refOf(i)) : err({ kind: "no-keyframe" as const, frame: i });
  }
  image(i: FrameNo) {
    this.reads.push(i);
    if (!this.live.includes(i)) return errAsync({ kind: "no-keyframe" as const, frame: i });
    if (this.missing.has(i)) return errAsync({ kind: "missing-frame-file" as const, frame: i });
    if (this.hostFailing.has(i))
      return errAsync({ kind: "host" as const, port: "store" as const, op: "read", message: "eio" });
    return okAsync(this.img(i));
  }
}

export type Rig = {
  p: Perception;
  rt: FakeModelRuntime;
  store: MemFeatureStore;
  frames: FakeFrames;
  clock: FakeClock;
  logger: FakeLogger;
};

export function rig(
  o: {
    frames?: number;
    store?: MemFeatureStore;
    models?: FakeRuntimeOptions;
    rt?: FakeModelRuntime;
  } & Partial<PerceptionOptions> = {},
): Rig {
  const rt = o.rt ?? new FakeModelRuntime(o.models);
  const store = o.store ?? new MemFeatureStore();
  const frames = new FakeFrames(o.frames ?? 3);
  const clock = new FakeClock();
  const logger = new FakeLogger();
  const p = createPerception(
    { runtime: rt, features: store, frames, clock, logger },
    {
      detector: o.detector ?? "fp32",
      featureCacheMB: o.featureCacheMB ?? 640,
      persistFeatures: o.persistFeatures ?? false,
      featureDiskMB: o.featureDiskMB ?? null,
      storedFeatureFormat: o.storedFeatureFormat === undefined ? FEATURE_FORMAT : o.storedFeatureFormat,
      profile: o.profile ?? false,
    },
  );
  return { p, rt, store, frames, clock, logger };
}
