/** Every store key of the session folder, as paths relative to `.eyespy/`. */
import type { DetId, HeatmapRef } from "../../detections/pure.ts";
import { isHeatmapRef } from "../../detections/pure.ts";
import { invariant } from "../../invariant/index.ts";
import { sha1Hex } from "../../railway/index.ts";
import type { TrackPlace } from "../../tracking/ports.ts";
import type { TrackDirection } from "../../tracking/pure.ts";
import type { ClipKey, FrameNo, FrameRef } from "../../video/pure.ts";

export const KEYS = {
  session: "session.json",
  dets: "dets.json",
  runs: "runs.json",
  objects: "objects.json",
  ops: "ops.jsonl",
  tracks: "tracks.json",
  assoc: "assoc.json",
} as const;

const pad3 = (j: number): string => String(j).padStart(3, "0");

export const clipDir = (key: ClipKey): string => `clips/${key}`;
export const frameKey = (r: FrameRef): string => `${clipDir(r.clipKey)}/frames/${pad3(r.index)}.jpg`;
/** A clip's feature folder. Everything in it can be encoded again, so clearing features removes it whole. */
export const featDir = (key: ClipKey): string => `${clipDir(key)}/feat`;
export const featKey = (r: FrameRef): string => `${featDir(r.clipKey)}/${pad3(r.index)}.f16`;
/** The frame index of a file name in a feature folder ("007.f16" gives 7), or null for anything else. */
export const featIndex = (name: string): number | null => {
  const digits = /^(\d{3,})\.f16$/.exec(name)?.[1];
  if (digits === undefined) return null;
  return pad3(Number(digits)) === digits ? Number(digits) : null; // only the exact name featKey gives
};
/** A clip's trunk folder, apart from `feat/`, whose clearing removes that folder whole. */
const trunkDir = (key: ClipKey): string => `${clipDir(key)}/trunk`;
export const trunkKey = (r: FrameRef): string => `${trunkDir(r.clipKey)}/${pad3(r.index)}.f16`;
export { trunkDir };
/** A tracking frame's JPEG. Keyframes on the tracking grid keep theirs under frames/. */
export const trackFrameDir = (key: ClipKey): string => `${clipDir(key)}/trackframes`;
export const trackFrameKey = (r: FrameRef): string => `${trackFrameDir(r.clipKey)}/${pad3(r.index)}.jpg`;
export const trackDir = (at: TrackPlace): string => `${clipDir(at.clip)}/tracks/${at.track}`;
export const seedKey = (at: TrackPlace): string => `${trackDir(at)}/seed.npz`;
export const trackMaskKey = (at: TrackPlace, frame: number): string => `${trackDir(at)}/mask-${pad3(frame)}.npz`;
export const trackMemoryKey = (at: TrackPlace, direction: TrackDirection, frame: number): string =>
  `${trackDir(at)}/mem-${direction}-${pad3(frame)}.npz`;
export const detKey = (id: DetId): string => `dets/${id}.npz`;
export const maskKey = (id: DetId): string => `out/masks/${id}.png`;
export const semKey = (ref: HeatmapRef): string => `sem/${ref}`;
export const outKey = (name: string): string => `out/${name}.jpg`;

/** The heatmap file name of a find run, `<frame:04d>-<sha1(prompt)[:10]>.png`. */
export const heatmapName = async (frame: FrameNo, prompt: string): Promise<HeatmapRef> => {
  const hex = await sha1Hex(new TextEncoder().encode(prompt));
  const name = `${String(frame).padStart(4, "0")}-${hex.slice(0, 10)}.png`;
  invariant(isHeatmapRef(name), () => `heatmap name ${name} is not a file name`);
  return name;
};

/** A heatmap name read from runs.json, or null if it isn't a HeatmapRef. */
export const asHeatmapRef = (name: string): HeatmapRef | null => (isHeatmapRef(name) ? name : null);
