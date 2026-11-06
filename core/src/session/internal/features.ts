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
import { trackUnit } from "./tracks.ts";

const stampFeatures = (k: Kit): ResultAsync<void, SessionError> => {
  const f = k.state.formats();
  const { features: want, trunks } = k.modules.perception.formats;
  // With tracking on, an encode stores a trunk too.
  const wantTrunks = k.modules.tracking ? trunks : f.trunks;
  return f.features === want && f.trunks === wantTrunks
    ? okAsync(undefined)
    : writeMeta(k, { formats: { ...f, features: want, ...(wantTrunks ? { trunks: wantTrunks } : {}) } });
};

/** A keyframe's features, then the format stamp. */
export const features = (k: Kit, i: FrameNo): ResultAsync<Features, SessionError> =>
  k.modules.perception.features(i).andThen((f) => stampFeatures(k).map(() => f));

/**
 * One unit of background work: perception.encodeNext and then the format stamp, or once keyframes are done, a tracking
 * unit. False when idle.
 */
export const background = (k: Kit): ResultAsync<boolean, SessionError> =>
  k.modules.perception.encodeNext().andThen((more) => (more ? stampFeatures(k).map(() => true) : trackUnit(k)));
