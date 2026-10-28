/** Writes session.json through MetaStore and the detection index (dets.json and runs.json) through DetectionStore. */
import type { ResultAsync } from "neverthrow";
import type { Config } from "../pure.ts";
import type { SessionError } from "../types.ts";
import type { Kit } from "./context.ts";
import type { Formats } from "./state.ts";

/** Writes session.json with the clips as video has them now plus `change`, then adopts the change. */
export const writeMeta = (
  k: Kit,
  change: { readonly config?: Config; readonly formats?: Formats } = {},
): ResultAsync<void, SessionError> =>
  k.stores.meta.write(k.state.meta(k.modules.video.clips(), change)).map(() => k.state.saved(change));

/** Writes dets.json and runs.json from the detections' current state. */
export const writeIndex = (k: Kit): ResultAsync<void, SessionError> =>
  k.stores.detections.writeIndex(k.modules.detections.all(), k.modules.detections.recorded());
