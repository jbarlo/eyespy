/**
 * User settings kept in browser preferences; a detector URL parameter overrides the stored detector. The app writes a
 * preference only when the user changes it. "Keep features on disk" is on unless the profile chose "0".
 */
import type { Prefs, Query } from "./ports.ts";
import { slice } from "./slice.ts";
import type { Detector } from "./types.ts";

/** The settings that are preferences. Each has help text in the UI. */
export type Preferences = {
  readonly persistFeatures: boolean;
  readonly featureDiskMB: number | null;
  readonly featureCacheMB: number;
  readonly detector: Detector;
};

export type SettingsState = Preferences & {
  readonly open: boolean;
  /** navigator.storage.persist()'s answer this page load; null until asked. */
  readonly persisted: boolean | null;
};

export const PREF = {
  persistFeatures: "persistFeatures",
  featureDiskMB: "featureDiskMB",
  featureCacheMB: "featureCacheMB",
  detector: "detector",
  session: "session",
} as const;

/** In-memory feature cache sizes offered (MB). */
export const FEATURE_CACHE_CHOICES = [1024, 2048, 4096] as const;
const DEFAULT_FEATURE_CACHE_MB = 2048;

export const asFeatureCacheMB = (v: string | number | null): number => {
  const n = Number(v);
  return FEATURE_CACHE_CHOICES.find((c) => c === n) ?? DEFAULT_FEATURE_CACHE_MB;
};

/**
 * Disk budgets offered per session, in MB; null means unlimited. The default leaves room for a long clip's features
 * without letting one session fill the disk.
 */
export const FEATURE_DISK_CHOICES = [1024, 2048, 4096, 8192, 16384, null] as const;
const DEFAULT_FEATURE_DISK_MB = 4096;
const UNLIMITED = "unlimited";

/** A stored or chosen budget if it is one of the choices ("unlimited" or null means unlimited), else the default. */
export const asFeatureDiskMB = (v: string | number | null): number | null => {
  if (v === UNLIMITED) return null;
  const n = v === null ? NaN : Number(v);
  return FEATURE_DISK_CHOICES.find((c) => c !== null && c === n) ?? DEFAULT_FEATURE_DISK_MB;
};
/** How a budget is kept in preferences (and sent to the engine). */
export const featureDiskPref = (mb: number | null): string => (mb === null ? UNLIMITED : String(mb));

export const createSettingsStore = (prefs: Prefs, query: Query) =>
  slice<SettingsState>(() => ({
    persistFeatures: prefs.get(PREF.persistFeatures) !== "0",
    featureDiskMB: asFeatureDiskMB(prefs.get(PREF.featureDiskMB)),
    featureCacheMB: asFeatureCacheMB(prefs.get(PREF.featureCacheMB)),
    detector: (query.get("detector") ?? prefs.get(PREF.detector)) === "fp16" ? "fp16" : "fp32",
    open: false,
    persisted: null,
  }));
