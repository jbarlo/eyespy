/**
 * createSession builds the op table over the modules and opens the session. Opening first finishes clip removals
 * that were cut short. It then counts trusted stored features as encoded (perception.scanStore) and logs.
 */
import type { ResultAsync } from "neverthrow";
import { okAsync } from "neverthrow";
import type { CreateSession, Session, SessionError } from "../types.ts";
import { recoverRemovals } from "./clips.ts";
import type { Kit } from "./context.ts";
import { background } from "./features.ts";
import { data } from "./ops/data.ts";
import { exportOps } from "./ops/export.ts";
import { find } from "./ops/find.ts";
import { label } from "./ops/label.ts";
import { look } from "./ops/look.ts";
import { videos } from "./ops/videos.ts";
import { SessionState } from "./state.ts";

const open = (k: Kit): ResultAsync<void, SessionError> => {
  const { detections, perception, video, labelling } = k.modules;
  return recoverRemovals(k)
    .andThen(() => perception.scanStore())
    .map(() => {
      k.host.logger.log(
        `loaded ${video.liveFrames().length} keyframes, ${detections.size()} detections, ${labelling.objectIds().length} objects`,
      );
    });
};

export const createSession: CreateSession = (deps, meta, opts) => {
  const k: Kit = { ...deps, state: new SessionState(meta), opts };
  const session: Session = {
    videos: videos(k),
    find: find(k),
    look: look(k),
    label: label(k),
    data: data(k),
    export: exportOps(k),
    config: () => k.state.config(),
    meta: () => k.state.meta(k.modules.video.clips()),
    background: () => background(k),
    pending: () => k.modules.perception.pending(),
  };
  return open(k).andThen(() => okAsync(session));
};
