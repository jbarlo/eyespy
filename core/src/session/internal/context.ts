/** What every op and use case works with: `Kit` (deps, state, options), railway's list helpers and shared lookups. */
import { Result } from "neverthrow";
import type { Detection } from "../../detections/pure.ts";
import type { FrameNo } from "../../video/pure.ts";
import type { SessionDeps } from "../ports.ts";
import type { Ctx } from "../pure.ts";
import type { SessionError, SessionOptions } from "../types.ts";
import type { SessionState } from "./state.ts";

export { parallel, sequence } from "../../railway/index.ts";

export type Kit = SessionDeps & { readonly state: SessionState; readonly opts: SessionOptions };

/** Labelling's per-query settings from the effective config. */
export const labelCtx = (ctx: Ctx) => ({ aliasIou: ctx.cfg.alias_iou });

/** Detections by id. The session holds these ids, so a miss gives `no-detection`. */
export const detectionsOf = (k: Kit, ids: readonly string[]): Result<readonly Detection[], SessionError> =>
  Result.combine(ids.map((id) => k.modules.detections.get(id)));

/** Distinct frames of some detections, ascending. */
export const framesOf = (ds: readonly Detection[]): readonly FrameNo[] =>
  [...new Set(ds.map((d) => d.frame))].sort((a, b) => a - b);
