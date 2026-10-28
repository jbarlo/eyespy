/**
 * Synthetic world of moving coloured rectangles. FakeVideo renders frames from it and `sceneDetector` scripts the
 * fake detector from it, so detections, crops and appearance vectors agree.
 *
 * Each frame carries a stamp (clip, time) in solid blocks along its top edge; they survive the SAM resize, so the
 * fake detector learns which frame its features came from without a side channel.
 */
import type { RGB } from "../../src/pixels/index.ts";
import type { Timing } from "../../src/ports/index.ts";
import type { DetectContext, DetectorScript, Rect } from "./runtime.ts";
import { STAMP_BLOCKS, stampBand, stampBytes } from "./stamp.ts";

export type Color = readonly [number, number, number];

export type SceneObject = {
  name: string;
  color: Color;
  /** Detector logit per prompt for this object (score = sigmoid(logit) · sigmoid(presence)). */
  prompts: Readonly<Record<string, number>>;
  /** Pixel rect at the clip's start and end (x0, y0, x1, y1, end exclusive); linear in between. */
  from: Rect;
  to?: Rect;
  /** Visible only within [t0, t1] seconds, or always when omitted. */
  visible?: readonly [number, number];
};

export type SceneClip = {
  /** Canonical (resolved) path, as FakeVideo.resolve returns it. */
  path: string;
  /** Content key (sha1-style 12 hex digits in real sessions). */
  key: string;
  w: number;
  h: number;
  captured: string | null;
  /** Seconds; the grey stream has floor(duration · fps) + 1 frames. */
  duration: number;
  /** Camera pan of the grey stream in px per stream frame (at its 360 px width). It sets the keyframe count. */
  pan: number;
  /** What FakeVideo.open reports (default: a video). */
  timing?: Timing;
  objects: readonly SceneObject[];
};

export type Scene = {
  clips: readonly SceneClip[];
  /** Presence logit per prompt. By default it is positive when some object answers to it on that frame, else negative. */
  presence?: Readonly<Record<string, number>>;
};

const lerp = (a: number, b: number, f: number) => Math.round(a + (b - a) * f);

/** An object's pixel rect at time t, or null when it isn't visible. */
export function objectRect(o: SceneObject, clip: SceneClip, t: number): Rect | null {
  if (o.visible && (t < o.visible[0] || t > o.visible[1])) return null;
  const f = clip.duration > 0 ? Math.min(1, Math.max(0, t / clip.duration)) : 0;
  const to = o.to ?? o.from;
  return [lerp(o.from[0], to[0], f), lerp(o.from[1], to[1], f), lerp(o.from[2], to[2], f), lerp(o.from[3], to[3], f)];
}

/** The frame of clip number `clipNo` (1-based) at time t: textured dark background, objects, stamp band. */
export function renderFrame(scene: Scene, clipNo: number, t: number): RGB {
  const clip = scene.clips[clipNo - 1];
  if (!clip) throw new Error(`scene has no clip ${clipNo}`);
  const { w, h } = clip;
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = 30 + ((x * 7 + y * 13 + clipNo * 5) % 23);
      data.set([v, v + 4, v + 8], (y * w + x) * 3);
    }
  for (const o of clip.objects) {
    const r = objectRect(o, clip, t);
    if (!r) continue;
    for (let y = Math.max(r[1], stampBand(h)); y < Math.min(r[3], h); y++)
      for (let x = Math.max(r[0], 0); x < Math.min(r[2], w); x++) data.set(o.color, (y * w + x) * 3);
  }
  const bytes = stampBytes({ clip: clipNo, t });
  const bw = w / STAMP_BLOCKS;
  for (let y = 0; y < stampBand(h); y++)
    for (let x = 0; x < w; x++) {
      const v = bytes[Math.min(STAMP_BLOCKS - 1, Math.floor(x / bw))]!;
      data.set([v, v, v], (y * w + x) * 3);
    }
  return { w, h, data };
}

/**
 * Detector script for a scene: on a stamped frame, one query per visible object that answers to the prompt (its
 * rect, its logit) and a semantic map lit inside those rects. On an unstamped image (a region-search crop) a prompt
 * that some object in the scene answers to yields one query covering the middle of the crop.
 */
export function sceneDetector(scene: Scene): (q: DetectContext) => DetectorScript {
  return ({ prompt, frame }) => {
    if (!frame) {
      const known = scene.clips.some((c) => c.objects.some((o) => prompt in o.prompts));
      return known
        ? { presence: 3, queries: [{ rect: [0.15, 0.15, 0.85, 0.85], logit: 2 }], semantic: null }
        : { presence: -4, queries: [], semantic: null };
    }
    const clip = scene.clips[frame.clip - 1];
    if (!clip) return { presence: -4, queries: [], semantic: null };
    const queries = [];
    for (const o of clip.objects) {
      const logit = o.prompts[prompt];
      const r = objectRect(o, clip, frame.t);
      if (logit === undefined || !r) continue;
      queries.push({ rect: [r[0] / clip.w, r[1] / clip.h, r[2] / clip.w, r[3] / clip.h] as Rect, logit });
    }
    const presence = scene.presence?.[prompt] ?? (queries.length ? 4 : -4);
    return { presence, queries, semantic: queries.map((q) => q.rect) };
  };
}
