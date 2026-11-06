/**
 * Tracked masks by place on a tracking grid. A frame's masks don't change once written, so a place is read again only
 * when more tracks have reached it. At most one read runs: while it does, only the latest place asked for waits, so
 * dragging the slider doesn't pile reads up on the engine.
 */
import type { TrackMasks } from "./tracking.ts";

const MAX_PLACES = 400;

export type MaskReads = {
  /** Shows this place's masks, from memory if they are complete for `tracks` tracks, else once read. */
  readonly want: (clip: string, at: number, tracks: number) => void;
  readonly reset: () => void;
};

const key = (clip: string, at: number) => `${clip}:${at}`;

export function createMaskReads(
  read: (clip: string, at: number) => Promise<TrackMasks | null>,
  show: (m: TrackMasks) => void,
): MaskReads {
  const known = new Map<string, TrackMasks>();
  let wanted: { clip: string; at: number; tracks: number } | null = null;
  let busy = false;
  let generation = 0;
  const pump = async (): Promise<void> => {
    const w = wanted;
    if (busy || !w) return;
    busy = true;
    wanted = null;
    const g = generation;
    const m = await read(w.clip, w.at);
    if (g !== generation) return;
    busy = false;
    if (m) {
      known.delete(key(w.clip, w.at));
      known.set(key(w.clip, w.at), m);
      for (const k of known.keys()) {
        if (known.size <= MAX_PLACES) break;
        known.delete(k);
      }
      if (!wanted) show(m);
    }
    return pump();
  };
  return {
    want: (clip, at, tracks) => {
      const have = known.get(key(clip, at));
      if (have && have.masks.length + have.parked.length >= tracks) {
        wanted = null;
        show(have);
        return;
      }
      wanted = { clip, at, tracks };
      void pump();
    },
    reset: () => {
      generation++;
      known.clear();
      wanted = null;
      busy = false;
    },
  };
}
