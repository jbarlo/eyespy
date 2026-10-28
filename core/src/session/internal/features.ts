/**
 * Keyframe features with the format stamp, and the background unit. Perception decides where features come from:
 * RAM, a trusted store, or an encode. The first time this code encodes features, it stamps `features` in
 * session.json, so the next open trusts the store's files.
 */
import type { ResultAsync } from "neverthrow";
import { okAsync } from "neverthrow";
import type { Features } from "../../perception/index.ts";
import type { FrameNo } from "../../video/pure.ts";
import type { SessionError } from "../types.ts";
import type { Kit } from "./context.ts";
import { writeMeta } from "./persist.ts";

const stampFeatures = (k: Kit): ResultAsync<void, SessionError> => {
  const f = k.state.formats();
  const want = k.modules.perception.formats.features;
  return f.features === want ? okAsync(undefined) : writeMeta(k, { formats: { ...f, features: want } });
};

/** A keyframe's features, then the format stamp. */
export const features = (k: Kit, i: FrameNo): ResultAsync<Features, SessionError> =>
  k.modules.perception.features(i).andThen((f) => stampFeatures(k).map(() => f));

/** One unit of background work, perception.encodeNext and then the format stamp. False when idle. */
export const background = (k: Kit): ResultAsync<boolean, SessionError> =>
  k.modules.perception.encodeNext().andThen((more) => (more ? stampFeatures(k).map(() => true) : okAsync(false)));
