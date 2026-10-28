/**
 * Turns detector output into Detected, the one path find and region search share. It keeps scores above the floor
 * and sorts them stably. It upsamples each mask to the target at 0.5, matching torch bilinear, and drops empty
 * masks. It runs NMS against the hits kept so far, where IoU > nmsIou means the same hit. It shifts boxes by the
 * target's offset, a region crop's place in the frame. Masks stay relative to their box.
 */
import { maskIou } from "../../../pixels/index.ts";
import type { Detected, Instance } from "../../pure.ts";
import { MASK_SIZE } from "../../pure.ts";
import type { DetectOptions, DetectTarget } from "../../types.ts";
import { linearTables, upsampleMask } from "../resample.kernel.ts";
import { heatmapGray, keepInstances, sigmoid, type DetectorOutput } from "./pixels.kernel.ts";

/** Mask probability threshold of the HF post-processing. */
const MASK_THRESHOLD = 0.5;

export function postprocess(out: DetectorOutput, target: DetectTarget, opts: DetectOptions): Detected {
  const kept = keepInstances(out, opts.scoreFloor).toSorted((a, b) => b.score - a.score);
  const tables = linearTables(MASK_SIZE, MASK_SIZE, target.w, target.h);
  const dx = target.offset?.x ?? 0;
  const dy = target.offset?.y ?? 0;
  const hits = kept.reduce<readonly Instance[]>((acc, k) => {
    const m = upsampleMask(k.probs, MASK_SIZE, MASK_SIZE, target.w, target.h, MASK_THRESHOLD, tables);
    if (!m) return acc;
    const [x0, y0, x1, y1] = m.box;
    const hit: Instance = { score: k.score, box: [x0 + dx, y0 + dy, x1 + dx, y1 + dy], mask: m.mask, area: m.area };
    return acc.some((o) => maskIou(hit, o) > opts.nmsIou) ? acc : [...acc, hit];
  }, []);
  return {
    instances: hits,
    presence: sigmoid(out.presence),
    heatmap: out.semantic ? heatmapGray(out.semantic) : null,
  };
}
