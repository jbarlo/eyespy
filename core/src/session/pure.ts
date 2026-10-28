/** Settings and the per-request context. CLI flags, `cfg` and `eyespy config` all come from CONFIG_META. */
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";

/** The settings and their defaults. */
export const DEFAULT_CONFIG = {
  keyframe_thresh: 0.4,
  score_floor: 0.3,
  threshold: 0.5,
  nms_iou: 0.7,
  alias_iou: 0.7,
  group_sim: 0.65,
  group_window: 8,
  presence: 0.5,
  active: 0.5,
  idle_minutes: 30,
} as const;
export type ConfigKey = keyof typeof DEFAULT_CONFIG;
export type Config = Readonly<Record<ConfigKey, number>>;

export type ConfigMeta = {
  /** An integer setting. A fractional value is truncated toward zero (coerce). */
  readonly int: boolean;
  /** One line for `eyespy config` and the CLI flag help. */
  readonly doc: string;
  /** A short name for UIs such as the web app's settings. */
  readonly label: string;
  /**
   * The explanation for someone who doesn't know the models. It says what the setting does, what changing it costs
   * and when you'd change it. The web app shows it in the tooltip and info popover next to `doc`, so the two must
   * agree.
   */
  readonly help: string;
};
export const CONFIG_META: Readonly<Record<ConfigKey, ConfigMeta>> = {
  keyframe_thresh: {
    int: false,
    doc: "keyframe spacing as fraction of frame moved; applies to clips added later",
    label: "Keyframe spacing",
    help:
      "How much of the picture must change before the next keyframe is taken (0.4 = 40% of the frame has moved). " +
      "Lower gives more keyframes: finer coverage, but each one costs a GPU encode and memory or " +
      "disk for its image features. Only videos added after the change use it.",
  },
  score_floor: {
    int: false,
    doc: "cache detections above this; applies to runs made later",
    label: "Detection floor",
    help:
      "Detections scoring below this are thrown away when a search runs. Lower keeps more weak candidates, which " +
      "the score threshold can then reveal, at the cost of more noise. Only searches run after the change use it.",
  },
  threshold: {
    int: false,
    doc: "default score filter for find/show/dets/todo",
    label: "Score threshold",
    help:
      "The confidence (0-1) a detection needs to be shown, triaged and counted. Lower shows more, including more " +
      "false hits; higher shows fewer, surer ones. Changing it re-runs nothing.",
  },
  nms_iou: {
    int: false,
    doc: "within one run, overlapping masks are the same hit; applies to runs made later",
    label: "Duplicate overlap",
    help:
      "Within one search on one keyframe, masks overlapping more than this (intersection over union) count as the " +
      "same hit and only the best is kept. Lower merges more. Only searches run after the change use it.",
  },
  alias_iou: {
    int: false,
    doc: "across runs on one frame, overlapping masks are aliases of one region",
    label: "Alias overlap",
    help:
      'Masks from different prompts on the same keyframe that overlap more than this are one region (aliases): "jar" ' +
      'and "lid" hits on the same thing are assigned together and shown once. Lower links more.',
  },
  group_sim: {
    int: false,
    doc: "todo --groups: appearance similarity needed to link",
    label: "Look-alike similarity",
    help:
      "How alike two detections must look (DINOv2 appearance similarity, 0-1) to land in the same triage group. " +
      "Higher gives smaller, purer groups (more decisions); lower gives bigger groups that may mix different things.",
  },
  group_window: {
    int: true,
    doc: "todo --groups: max keyframe gap between linked detections",
    label: "Look-alike window",
    help:
      "Triage links look-alikes at most this many keyframes apart. Larger links sightings across longer gaps, and " +
      "makes it likelier that two similar but different things end up in one group.",
  },
  presence: {
    int: false,
    doc: 'find: frames whose presence score passes this count as "concept present"',
    label: "Presence score",
    help:
      "Besides masks, SAM 3 scores whether the prompt is in the keyframe at all; keyframes above this count as " +
      "\"present\" in a search's summary. Raise it if a prompt is reported where it isn't.",
  },
  active: {
    int: false,
    doc: "semantic: heatmap value above which a pixel counts as activated",
    label: "Heatmap activation",
    help:
      "In the semantic heatmap, pixels above this value count as matching the prompt (the CLI's heatmap tint and " +
      "the activated area it reports). Display only: no detections change.",
  },
  idle_minutes: {
    int: true,
    doc: "server exits after this long without requests (once encoding is done)",
    label: "Server idle timeout",
    help:
      "CLI only: the background server exits after this many idle minutes once encoding is done, which frees its " +
      "GPU memory; the next command starts it again. The browser app has no server and ignores it.",
  },
};
export const isConfigKey = (k: string): k is ConfigKey => Object.hasOwn(DEFAULT_CONFIG, k);
/** Every setting, in DEFAULT_CONFIG order. */
export const CONFIG_KEYS: readonly ConfigKey[] = Object.keys(DEFAULT_CONFIG).filter(isConfigKey);
export const coerce = (k: ConfigKey, v: number): number => (CONFIG_META[k].int ? Math.trunc(v) : v);

/**
 * A request's `cfg` overrides as settings, with int settings truncated as when saved. `unknown-settings` names
 * every key that isn't a setting, sorted.
 */
export const parseOverrides = (
  cfg: Readonly<Record<string, number>> | undefined,
): Result<Partial<Config>, { readonly kind: "unknown-settings"; readonly keys: readonly string[] }> => {
  const given = Object.entries(cfg ?? {});
  const unknown = given.map(([k]) => k).filter((k) => !isConfigKey(k));
  if (unknown.length) return err({ kind: "unknown-settings", keys: unknown.toSorted() });
  return ok(Object.fromEntries(given.flatMap(([k, v]) => (isConfigKey(k) ? [[k, coerce(k, v)] as const] : []))));
};

/** Per-request context. Its effective config is the session config plus the request's `cfg` overrides. */
export type Ctx = { readonly cfg: Config };
