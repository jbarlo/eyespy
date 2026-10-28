/**
 * Pure storage summaries. For the settings dialog, per browser session: image features against everything else, the
 * models cache and the share of the quota. For the Videos panel, per clip and for the open session: keyframe images
 * against features. Stored features are one FEATURE_BYTES file per keyframe, so their size says how many keyframes a
 * drop re-encodes.
 */
import { FEATURE_BYTES } from "eyespy-core/perception/pure";
import type { Clip, SessionUsage, Usage } from "./types.ts";

export type SessionRow = SessionUsage & {
  /** Everything but features: keyframe images, detections, labels, heatmaps. */
  readonly other: number;
  /** Keyframes whose features are stored (re-encoded if dropped). */
  readonly keyframes: number;
  /** The session open in this tab. */
  readonly open: boolean;
};

export type StorageSummary = {
  /** The browser's estimate for the whole site. */
  readonly used: number;
  readonly quota: number;
  /** used / quota; null when the browser reports no quota. */
  readonly share: number | null;
  /** Models and the ONNX runtime wasm (downloaded once, kept by hash). */
  readonly models: number;
  /** Largest first. */
  readonly sessions: readonly SessionRow[];
  readonly sessionsTotal: number;
  /** Features over every session: what dropping them all would free. */
  readonly features: number;
  /** Protected from eviction (navigator.storage.persisted()). */
  readonly persisted: boolean;
};

/**
 * Keyframes whose stored features take this many bytes.
 * @internal
 */
export const keyframesIn = (featureBytes: number): number => Math.round(featureBytes / FEATURE_BYTES);

/** `open` is the OPFS session open in this tab (null for a folder session or none). */
export function summarizeStorage(u: Usage, open: string | null): StorageSummary {
  const sessions = u.sessions
    .map((s) => ({
      ...s,
      other: Math.max(0, s.total - s.features),
      keyframes: keyframesIn(s.features),
      open: s.name === open,
    }))
    .toSorted((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const sum = (f: (s: SessionUsage) => number) => sessions.reduce((n, s) => n + f(s), 0);
  return {
    used: u.usage,
    quota: u.quota,
    share: u.quota > 0 ? u.usage / u.quota : null,
    models: u.models,
    sessions,
    sessionsTotal: sum((s) => s.total),
    features: sum((s) => s.features),
    persisted: u.persisted,
  };
}

export type ClipsStorage = {
  readonly frames: number;
  readonly features: number;
  readonly total: number;
  /** Keyframes whose features are stored. */
  readonly keyframes: number;
};

/** Keyframe images against stored features over clips (one clip, or the whole session's). */
export function clipsStorage(clips: readonly Pick<Clip, "frame_bytes" | "feature_bytes">[]): ClipsStorage {
  const frames = clips.reduce((n, c) => n + c.frame_bytes, 0);
  const features = clips.reduce((n, c) => n + c.feature_bytes, 0);
  return { frames, features, total: frames + features, keyframes: keyframesIn(features) };
}
