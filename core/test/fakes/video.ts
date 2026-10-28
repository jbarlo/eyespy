/**
 * ClipSource over a Scene. Relative refs resolve under /videos/. The grey stream is noise panning `pan` px per
 * frame, so the real keyframe picker yields a predictable number of keyframes. File bytes derive from the scene
 * `key`, not the path, so a moved file keeps its content key.
 */
import { createHash } from "node:crypto";
import type { ClipFormat, ClipSource, OpenOptions } from "../../src/ports/index.ts";
import { contentKeyOf } from "../../src/video/pure.ts";
import { fakeJpeg } from "./codec.ts";
import { renderFrame, type Scene, type SceneClip } from "./scene.ts";

/** Deterministic noise (xorshift32). */
function noise(n: number, seed: number): Uint8Array {
  let x = seed >>> 0 || 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

const fileSeed = (key: string) => {
  let x = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return x;
};
/** Synthetic file size: over 2 MiB so the content key's head and tail don't overlap; varies per clip. */
export const fakeFileSize = (key: string): number => (5 << 19) + (fileSeed(key) % 4096);
/** Bytes [start, end) of a clip's synthetic file. */
export function fakeFileBytes(key: string, start: number, end: number): Uint8Array {
  const seed = fileSeed(key);
  const e = Math.min(end, fakeFileSize(key));
  const out = new Uint8Array(Math.max(0, e - start));
  for (let i = 0; i < out.length; i++) out[i] = Math.imul((start + i) ^ seed, 2654435761) >>> 24;
  return out;
}
/** The content key the video module derives from a fake clip's bytes. */
export function fakeContentKey(key: string): string {
  const size = fakeFileSize(key);
  const mib = 1 << 20;
  return createHash("sha1")
    .update(String(size))
    .update(fakeFileBytes(key, 0, Math.min(mib, size)))
    .update(fakeFileBytes(key, Math.max(0, size - mib), size))
    .digest("hex")
    .slice(0, 12);
}

export class FakeVideo implements ClipSource {
  /** open calls (path, options), in order. */
  opened: [string, OpenOptions][] = [];
  /** frameJpeg calls (path, time), in order. */
  extracted: [string, number][] = [];
  /** grayStream calls (path), in order. */
  streamed: string[] = [];
  /** grayStream rates (fps), in order. */
  rates: number[] = [];

  constructor(readonly scene: Scene) {}

  private clip(ref: string): { clip: SceneClip; no: number } {
    const path = this.resolve(ref);
    const k = this.scene.clips.findIndex((c) => c.path === path);
    const clip = this.scene.clips[k];
    if (!clip) throw new Error(`fake video: no clip ${ref}`);
    return { clip, no: k + 1 };
  }

  resolve(ref: string): string {
    return ref.startsWith("/") ? ref : `/videos/${ref}`;
  }
  async exists(ref: string): Promise<boolean> {
    const path = this.resolve(ref);
    return this.scene.clips.some((c) => c.path === path);
  }
  async size(ref: string): Promise<number> {
    return fakeFileSize(this.clip(ref).clip.key);
  }
  async readRange(ref: string, start: number, end: number): Promise<Uint8Array> {
    return fakeFileBytes(this.clip(ref).clip.key, start, end);
  }
  async key(ref: string): Promise<string> {
    return (await contentKeyOf(this, ref))._unsafeUnwrap();
  }
  async open(ref: string, opts: OpenOptions): Promise<ClipFormat> {
    const { clip } = this.clip(ref);
    this.opened.push([clip.path, opts]);
    return { w: clip.w, h: clip.h, captured: clip.captured, timing: clip.timing ?? { kind: "video" } };
  }
  async grayStream(ref: string, fps: number, w: number, h: number): Promise<Uint8Array> {
    const { clip, no } = this.clip(ref);
    this.streamed.push(clip.path);
    this.rates.push(fps);
    const n = Math.floor(clip.duration * fps) + 1;
    const tex = noise(w * h, 0x9e3779b9 ^ (no * 7919));
    const out = new Uint8Array(n * w * h);
    for (let i = 0; i < n; i++) {
      const shift = Math.round(i * clip.pan) % w;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) out[i * w * h + y * w + x] = tex[y * w + ((x + shift) % w)] ?? 0;
    }
    return out;
  }
  async frameJpeg(ref: string, t: number): Promise<Uint8Array> {
    const { clip, no } = this.clip(ref);
    this.extracted.push([clip.path, t]);
    return fakeJpeg(renderFrame(this.scene, no, t), 95);
  }
}
