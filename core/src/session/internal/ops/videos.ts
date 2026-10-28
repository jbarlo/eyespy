/** The video ops: status, clips (add, list, remove), settings and vision-feature storage. */
import type { Result, ResultAsync } from "neverthrow";
import { errAsync, ok, okAsync } from "neverthrow";
import { REJECT } from "../../../labelling/pure.ts";
import type { Clip, FrameNo } from "../../../video/pure.ts";
import { CONFIG_KEYS, DEFAULT_CONFIG, coerce, isConfigKey } from "../../pure.ts";
import type { ClipInfo, Session, SessionError } from "../../types.ts";
import { addClip, removeClip } from "../clips.ts";
import type { Kit } from "../context.ts";
import { labelCtx, parallel, sequence } from "../context.ts";
import { writeMeta } from "../persist.ts";

/** A clip's row in clips.list, with its keyframe range, what was found on it, and bytes on disk (frames, features). */
const clipInfo = (k: Kit, c: Clip): ResultAsync<ClipInfo, SessionError> => {
  const { video, detections, labelling, perception } = k.modules;
  const fr = video.clipFrames(c.key);
  const own = labelling.owners();
  const dets = detections.inFrames(new Set(fr));
  const objs = new Set(
    dets.flatMap((d) => {
      const o = own.get(d.id);
      return o && o !== REJECT ? [o] : [];
    }),
  );
  const bytes = c.removed
    ? okAsync([])
    : parallel(fr, (i) =>
        video
          .ref(i)
          .asyncAndThen((ref) =>
            k.stores.frameFiles
              .size(ref)
              .andThen((frame) => k.stores.featureBytes(ref).map((feature) => ({ frame, feature }))),
          ),
      );
  return bytes.map((sizes) => ({
    key: c.key,
    path: c.path,
    name: c.path.split("/").at(-1) ?? c.path,
    captured: c.captured,
    keyframes: c.times.length,
    frames: [fr[0] ?? null, fr.at(-1) ?? null] as const,
    encoded: c.removed ? 0 : fr.filter((i) => perception.encoded(i)).length,
    detections: dets.length,
    objects: objs.size,
    frame_bytes: sizes.reduce((a, s) => a + (s.frame ?? 0), 0),
    feature_bytes: sizes.reduce((a, s) => a + (s.feature ?? 0), 0),
    ...(c.removed ? { removed: c.removed.at } : {}),
  }));
};

export const videos = (k: Kit): Session["videos"] => ({
  status: (ctx) => {
    const { video, detections, labelling, perception } = k.modules;
    const live = video.liveFrames();
    return okAsync({
      root: k.host.root,
      clips: video.liveClips().map((c) => ({ path: c.path, key: c.key, keyframes: c.times.length })),
      keyframes: live.length,
      encoded: live.filter((i) => perception.encoded(i)).length,
      prompts: detections.prompts(),
      detections: detections.size(),
      objects: labelling.objectIds().length,
      rejected: labelling.rejected().length,
      todo: labelling.unassigned({ threshold: ctx.cfg.threshold }, labelCtx(ctx)).length,
      assigned: labelling.owners().size,
    });
  },

  add: (ctx, req) => addClip(k, ctx, req.video, req.fps ?? null),

  list: (_ctx, req) =>
    sequence(
      k.modules.video.clips().filter((c) => !c.removed || req.all),
      (c) => clipInfo(k, c),
    ).map((clips) => ({ clips })),

  remove: (_ctx, req) => removeClip(k, req.clip),

  config: (_ctx, req) => {
    const reply = () => ({ config: k.state.config(), defaults: DEFAULT_CONFIG });
    if (!req.key) return okAsync(reply());
    const key = req.key;
    if (!isConfigKey(key)) return errAsync({ kind: "unknown-setting", key, known: CONFIG_KEYS });
    if (req.value === undefined || req.value === null) return okAsync(reply());
    const v = Number(req.value);
    if (String(req.value).trim() === "" || Number.isNaN(v))
      return errAsync({ kind: "bad-setting-value", value: String(req.value) });
    return writeMeta(k, { config: k.state.withSetting(key, coerce(key, v)) }).map(reply);
  },

  features: (_ctx, req) => {
    const p = k.modules.perception;
    if (req.persist !== undefined && req.persist !== null) p.setPersist(req.persist);
    const { video } = k.modules;
    const scope: Result<readonly FrameNo[] | undefined, SessionError> = req.clip
      ? video.findClip(req.clip).map((c) => video.clipFrames(c.key))
      : ok(undefined);
    const budget = req.diskMB;
    const evicted: ResultAsync<number, SessionError> =
      budget === undefined || budget === null ? okAsync(0) : p.setDiskBudget(budget === "unlimited" ? null : budget);
    const cleared = (): ResultAsync<number, SessionError> =>
      scope.asyncAndThen((frames) => (req.clear ? p.clearStored(frames) : okAsync(0)));
    return evicted.andThen((e) =>
      cleared().andThen((n) =>
        p.stats().map((s) => ({
          persist: s.persist,
          stored: s.stored,
          cleared: n,
          evicted: e,
          keyframes: s.keyframes,
          inMemory: s.inMemory,
          bytesPerFrame: s.bytesPerFrame,
          storedBytes: s.storedBytes,
          diskMB: s.diskMB,
        })),
      ),
    );
  },
});
