/**
 * Every explanation the web app shows: a name, a tooltip (`tip`) and optional detail (`more`, the info popover).
 * Session settings come from core's CONFIG_META so the CLI and the app agree. A test fails when a setting, tool,
 * layer or panel has none.
 */
import { DEFAULT_CACHE_MB, FEATURE_BYTES } from "eyespy-core/perception/pure";
import { CONFIG_META } from "eyespy-core/session/pure";
import type { ConfigKey } from "eyespy-core/session/pure";
import type { LayerId, Preferences, ToolId } from "../state/index.ts";

export type Help = { readonly label: string; readonly tip: string; readonly more?: string };

/** MB of image features per keyframe (one stored feature file). */
const FEATURE_MB = Math.round(FEATURE_BYTES / 2 ** 20);
/** Keyframes whose features fit in `mb` of memory (as the engine sizes its cache). */
export const keyframesInMB = (mb: number) => Math.max(2, Math.floor(mb / (FEATURE_BYTES / 2 ** 20)));
/** A disk budget as shown: "4 GB", "unlimited". */
export const budgetLabel = (mb: number | null) => (mb === null ? "unlimited" : `${mb / 1024}\u00a0GB`);
/** Seconds to encode one keyframe, as the low and high ends of the range the help text gives. */
const ENCODE_S = [1, 2] as const;

/** "about 1–2 min" for re-encoding n keyframes. */
export function reencodeTime(n: number): string {
  const [lo, hi] = ENCODE_S.map((s) => s * n);
  if (hi === undefined || lo === undefined || n <= 0) return "nothing";
  if (hi < 90) return `about ${lo}–${hi} s`;
  return `about ${Math.max(1, Math.round(lo / 60))}–${Math.round(hi / 60)} min`;
}

const ENCODE = `about ${ENCODE_S[0]}–${ENCODE_S[1]} s per keyframe on a mid-range GPU`;

/** The default first download in decimal GB (a test checks it against the manifest). */
export const DOWNLOAD_GB = "1.8";

/** The settings kept as browser preferences (Settings dialog). */
export const PREFERENCE_HELP: Readonly<Record<keyof Preferences, Help>> = {
  persistFeatures: {
    label: "Keep image features on disk",
    tip:
      `Saves each keyframe's SAM 3 image features (${FEATURE_MB} MB per keyframe) in browser storage, up to the disk ` +
      "budget, so reopening a session or searching again needs no re-encoding. Off: they stay in memory only and " +
      `are re-encoded after a reload, ${ENCODE}.`,
    more:
      "Image features (embeddings) are what SAM 3's vision encoder makes of a keyframe; every search starts from " +
      "them. Detections, objects and labels are always saved: only features can be recomputed. With this off, " +
      "keyframes that don't fit the in-memory cache are also re-encoded whenever a search needs them again. To save " +
      "space, lowering the disk budget is usually a better trade than turning this off. Features already stored " +
      "are used either way.",
  },
  featureDiskMB: {
    label: "Disk budget per session",
    tip:
      `How much disk one session's stored image features may use (${FEATURE_MB} MB per keyframe; 4 GB holds ` +
      `${keyframesInMB(4096)} keyframes). When a new keyframe would go over it, the features used longest ago are ` +
      "deleted to make room.",
    more:
      `A deleted keyframe is re-encoded (${ENCODE}) the next time a search needs it; detections, objects and labels ` +
      "are never deleted. A search over more keyframes than the budget holds keeps what is stored and re-encodes " +
      "only the keyframes that don't fit, every time: raise it above the session's size if you often search the " +
      "whole session. Applies to the open session at once, to others when opened. CLI: --feature-disk-mb or EYESPY_FEATURE_DISK_MB.",
  },
  featureCacheMB: {
    label: "In-memory feature cache",
    tip:
      `How much image-feature data the engine keeps in memory (${FEATURE_MB} MB per keyframe; 2 GB holds ` +
      `${keyframesInMB(2048)} keyframes). Bigger means fewer re-encodes during searches but more memory for this tab. ` +
      "Applies when the session is reopened.",
    more:
      "A keyframe that drops out of memory is read back from disk when its features are stored, else re-encoded. " +
      "Without features on disk, a search over more keyframes than fit here re-encodes most of them every time. " +
      `Independent of the disk budget. The CLI's equivalent is EYESPY_FEATURE_CACHE_MB (default ${DEFAULT_CACHE_MB} MB).`,
  },
  detector: {
    label: "Detector precision",
    tip:
      "fp32 is full precision; fp16 is half the download, and its scores differ slightly. Applies when the session " +
      "is reopened.",
    more:
      "The detector is the part of SAM 3 that turns a prompt and a keyframe's image features into masks and scores; " +
      "the vision encoder is fp16 either way. Detections already made keep their scores. Same choice as the CLI's " +
      "--detector / EYESPY_DETECTOR.",
  },
};

/** A session setting's help: core's label and explanation, with the CLI's line as the detail. */
export const settingHelp = (key: ConfigKey): Help => {
  const m = CONFIG_META[key];
  return { label: m.label, tip: m.help, more: `CLI: eyespy config ${key} <value>: ${m.doc}.` };
};

/** The canvas tools. */
export const TOOL_HELP: Readonly<Record<ToolId, Help>> = {
  select: { label: "Select", tip: "Click a region to select it, shift-click to add; drag to pan, scroll to zoom." },
  rect: { label: "Rect select", tip: "Drag a box: selects the shown regions inside it (shift adds)." },
  search: {
    label: "Region search",
    tip:
      "Drag a box, then search inside it by prompt or by look (DINOv2). The box is cut out and upscaled, so small " +
      "things become findable.",
    more:
      "It is not a SAM 3 box prompt (this ONNX export has no box input): it finds things by prompt or appearance " +
      `inside the box, not "the thing in this box". Each search encodes the crop again, uncached (${ENCODE}).`,
  },
};

/** The canvas layers (Layers panel). */
export const LAYER_HELP: Readonly<Record<LayerId, Help>> = {
  objects: { label: "Objects", tip: "Detections assigned to an object, one region per object, coloured by object." },
  todo: {
    label: "Todo (unassigned)",
    tip: "Detections above the score threshold that no object has yet, one per alias group: what's left to decide.",
  },
  rejects: { label: "Rejects", tip: "Detections marked not-an-item (X). Hidden from todo and triage." },
  semantic: {
    label: "Semantic heatmap",
    tip: 'SAM 3\'s per-pixel response to the heatmap prompt on this keyframe: where it "sees" the prompt.',
  },
  gaps: {
    label: "Gaps",
    tip: "Darkens everything assigned or rejected, so the parts of the picture nobody has labelled stand out.",
  },
};

/** The side panels, by id. */
export type PanelId = "properties" | "triage" | "objects" | "videos" | "layers" | "frame-dets" | "history" | "console";

export const PANEL_HELP: Readonly<Record<PanelId, Help>> = {
  properties: {
    label: "Properties",
    tip: "Whatever is selected: detections (assign, new object, reject, find similar), an object, or a region search.",
  },
  triage: {
    label: "Triage",
    tip:
      "Steps through unassigned detections in groups of look-alikes close in time, so one decision (assign, new " +
      "object, reject, skip) covers a whole group.",
    more:
      "Groups link detections whose DINOv2 appearance similarity passes the look-alike similarity setting and that " +
      "are at most the look-alike window apart (Settings, session settings). Only detections above the score " +
      "threshold take part. Same as the CLI's eyespy todo --groups.",
  },
  objects: {
    label: "Objects",
    tip: "The things you've labelled. Each object collects its sightings (detections) across keyframes; drag one onto another to merge.",
  },
  videos: {
    label: "Videos",
    tip:
      "The videos in this session, with their keyframes and what they take on disk: keyframe images (kept) and image " +
      "features (can be dropped and re-encoded).",
    more:
      "Clips of the same moment share one keyframe numbering. Removing a video keeps the others' numbers; adding it " +
      "again puts it back where it was. The video file itself is only read, never uploaded.",
  },
  layers: {
    label: "Layers",
    tip: "What the canvas draws, and the score threshold that decides which detections count.",
  },
  "frame-dets": {
    label: "Regions on this frame",
    tip: "The regions drawn on this keyframe as a list, for the keyboard and screen readers.",
  },
  history: {
    label: "History",
    tip: "Every edit, newest first. Undo/redo step through it; removing a video is a barrier nothing before can be undone past.",
  },
  console: {
    label: "Console",
    tip: "Runs any engine op by name with JSON input, the same ops the CLI calls. For debugging and power users.",
  },
};

/** Everything else: concepts, actions, dialogs. */
export const HELP = {
  keyframes: {
    label: "Keyframes",
    tip:
      "The stills eyespy works on: a new one is taken whenever enough of the picture has changed (keyframe spacing). " +
      "Searches, labels and frame numbers all refer to keyframes.",
  },
  encoding: {
    label: "Encoding",
    tip:
      `Each keyframe goes once through SAM 3's vision encoder on your GPU (WebGPU), ${ENCODE}. It runs in the ` +
      "background after a video is added; searches jump the queue.",
  },
  find: {
    label: "Find",
    tip:
      'Searches keyframes for a short text prompt ("jar", "red mug") with SAM 3 and outlines every match with a ' +
      "mask and a score. Results are kept, so the same search again is instant.",
    more:
      `A keyframe whose image features aren't ready yet is encoded first (${ENCODE}). ` +
      "Short noun phrases work best. Each hit is also given a DINOv2 appearance embedding, which powers " +
      "Find similar, Which object is this? and triage.",
  },
  findScope: {
    label: "Frames to search",
    tip: "Every keyframe, only the one shown, or a list such as 0-5,9.",
  },
  heatmap: {
    label: "Heatmap",
    tip:
      "Shows where SAM 3 responds to the prompt on this keyframe, pixel by pixel, over the masks. Helps to see why " +
      "something was or wasn't found; it adds no detections.",
  },
  similar: {
    label: "Find similar",
    tip:
      "Ranks every other detection by how alike it looks to this one (DINOv2 appearance embeddings), whatever its " +
      "prompt. Nothing is re-encoded.",
  },
  suggest: {
    label: "Suggest more sightings",
    tip: "Unassigned detections that look like this object's sightings (DINOv2), best first, to add in one click.",
  },
  whichObject: {
    label: "Which object is this?",
    tip: "Your objects ranked by how alike their sightings look to the selection (DINOv2); A assigns to the top one.",
  },
  reject: {
    label: "Reject",
    tip: "Marks the selection as not an item: hidden from todo and triage, shown in the Rejects layer. Undo brings it back.",
  },
  newObject: {
    label: "New object",
    tip: "Makes an object from the selection with this label. Detections of other prompts on the same spot come along (aliases).",
  },
  addVideo: {
    label: "Add video",
    tip:
      "Picks keyframes from a video and keeps them as images in this session; they are then encoded in the " +
      "background. The video never leaves your machine.",
  },
  removeVideo: {
    label: "Remove video",
    tip:
      "Deletes the video's keyframes and detections and takes its sightings out of objects; can't be undone. Adding " +
      "the same video again restores its keyframes (same numbers), without the detections.",
  },
  export: {
    label: "Export manifest",
    tip:
      "Downloads a JSON file with every object (label, sightings, first and last time seen), item counts per label " +
      "and the models and settings used: the result of your labelling, for other tools. The same as eyespy export.",
  },
  openFolder: {
    label: "Open folder",
    tip:
      "Works on a folder on your disk instead of browser storage: a CLI session folder (with .eyespy/) or an empty " +
      "folder for a new session. The browser asks for permission to read and write it.",
  },
  sessionSettings: {
    label: "Session settings",
    tip:
      "Stored with this session (session.json) and shared with the CLI's eyespy config. Most only affect what is " +
      "added or searched after the change.",
  },
  storageUsed: {
    label: "Used by this site",
    tip:
      "The browser's estimate of everything this site stores (models, sessions, caches) and how much it lets this " +
      "site use. It all stays on this machine.",
  },
  models: {
    label: "Models and runtime",
    tip:
      `SAM 3 (vision encoder, text encoder, detector), DINOv2 and ONNX Runtime: about ${DOWNLOAD_GB} GB, downloaded ` +
      "once and shared by every session. Downloaded again if the browser clears them.",
  },
  features: {
    label: "Image features",
    tip:
      `SAM 3 image embeddings, ${FEATURE_MB} MB per keyframe, kept up to the disk budget per session. Safe to drop: ` +
      `they are re-encoded when a search needs them (${ENCODE}).`,
  },
  otherData: {
    label: "Everything else",
    tip:
      "Keyframe images, detections, objects, labels and heatmaps: your work. Dropping features never touches it; " +
      "removing a video or the session does.",
  },
  dropFeatures: {
    label: "Drop features",
    tip:
      "Deletes the stored image features to free their space; detections, objects and labels stay. Searching those " +
      `keyframes again encodes them first (${ENCODE}). With "keep features on disk" on, they are saved again as ` +
      "they are re-encoded.",
  },
  dropAllFeatures: {
    label: "Drop features of every session",
    tip:
      "Deletes the stored image features of every browser session; detections, objects and labels stay. Keyframes " +
      `are re-encoded when a search needs them (${ENCODE}).`,
  },
  persisted: {
    label: "Protected from eviction",
    tip:
      "Unprotected browser storage may be cleared by the browser when the disk runs low, sessions and labels " +
      "included. Protected storage is removed only by you.",
    more:
      "The app asks for protection (navigator.storage.persist()) when it starts, and the browser decides whether to " +
      "grant it. Models and features can be fetched or recomputed, labels can't: export the manifest of work you " +
      "care about, or use Open folder to keep a session on disk.",
  },
} as const satisfies Readonly<Record<string, Help>>;

/** The can't-decode dialog. */
export const UNSUPPORTED_VIDEO = {
  title: "Can't decode this video in this browser",
  /** What happened, in one sentence. `codecName` is "unknown" when the container itself isn't readable. */
  why: (file: string, codecName: string) =>
    `${file} is ${codecName === "unknown" ? "in a format" : `${codecName} video,`} which this browser can't decode, so it ` +
    "can't be added here.",
} as const;

/** The SAM License dialog and the banner after Cancel. `links` is the sentence around the two licence-file links. */
export const SAM_LICENCE_TEXT = {
  title: "SAM 3 model licence",
  intro:
    `eyespy is open source (Apache-2.0). To find objects it downloads Meta's SAM 3 models (about ${DOWNLOAD_GB} GB with the ` +
    "other models), which are licensed under the SAM License, not an open-source licence.",
  links: {
    before: "Full text: ",
    sam: "SAM License",
    between: ". Other licences (DINOv2, also downloaded, is Apache-2.0): ",
    notices: "third-party notices",
    after: ".",
  },
  agree: "I agree",
  cancel: "Cancel",
  banner:
    "SAM 3 models are off: the SAM License was not accepted. You can browse sessions and add videos; encoding " +
    "keyframes and searching need the models.",
  review: "Review licence",
} as const;
