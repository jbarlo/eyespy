/**
 * Video tracking from the UI: Find queues it, the selection goes first, and pause, resume and cancel. All of it only with
 * `deps.tracking`. Status comes from a poll, since units finish in the worker's background with no event.
 */
import { ResultAsync } from "neverthrow";
import { createMaskReads } from "../track-masks.cache.ts";
import { createPoller } from "../poll.cache.ts";
import { keep } from "../share.ts";
import { coveringCount, trackOfDet } from "../tracking.ts";
import type { TrackGrid, TrackRow, TrackSlot, TrackStatus } from "../tracking.ts";
import { REJECTED } from "../objects.ts";
import type { Clip } from "../types.ts";
import { sessionOf } from "./context.ts";
import type { Ctx } from "./context.ts";
import type { Runner } from "./run.ts";

const POLL_MS = 2000;
/** How many polls apart the Videos panel's sizes are read again while tracks are moving. */
const SIZES_EVERY = 15;
const inQueue = (t: TrackRow) => t.state === "active" && !t.finished;

export function createTrackingActions(ctx: Ctx, r: Runner, loadClips: () => Promise<void>) {
  const { tracking, frames, selection, layers, triage } = ctx.stores;
  const { select: sel } = ctx;
  const on = ctx.deps.tracking;
  const poll = createPoller(ctx.deps.clock, POLL_MS);

  const reads = createMaskReads(
    async (clip, at) => {
      const s = sessionOf(ctx);
      if (!s) return null;
      const res = await s.ops.track.masks({ clip, at });
      if (res.isErr()) {
        r.report(res.error);
        return null;
      }
      return res.value;
    },
    (masks) => tracking.setState((t) => ({ masks: keep(t.masks, masks) })),
  );

  /** Reads what the shown place needs: the clip's grid, then the masks of any track that has reached it. */
  const sync = () => {
    if (!on) return;
    const clip = sel.currentFrame()?.clipKey;
    if (!clip) return;
    const { grids, status } = tracking.getState();
    if (!grids.has(clip)) {
      void loadGrid(clip);
      return;
    }
    const place = sel.trackPlace();
    if (!place) return;
    reads.want(clip, place.at, coveringCount(status?.tracks ?? [], clip, place.at));
  };

  async function loadGrid(clip: string) {
    const s = sessionOf(ctx);
    if (!s) return;
    const res = await s.ops.track.frames({ clip });
    if (sessionOf(ctx) !== s || res.isErr()) return;
    const grid: TrackGrid = res.value;
    tracking.setState((t) => ({ grids: new Map([...t.grids, [clip, grid]]) }));
    sync();
  }

  const apply = (status: TrackStatus | null) => {
    if (status) tracking.setState((t) => ({ status: keep(t.status, status) }));
    sync();
  };

  async function refreshTracking() {
    const s = sessionOf(ctx);
    if (!s) return;
    const res = await ResultAsync.combine([s.ops.track.status(), s.ops.track.proposals()] as const);
    if (sessionOf(ctx) !== s || res.isErr()) return; // the next tick retries a missed one
    const [status, proposals] = res.value;
    tracking.setState((t) => ({ status: keep(t.status, status), proposals: keep(t.proposals, proposals) }));
    sync();
  }

  /** Polls while the session is open, and reads the clips' sizes now and then while tracks move. */
  function startTracking() {
    if (!on) return;
    void refreshTracking();
    poll.start((tick) => {
      void refreshTracking();
      const moving = tracking.getState().status?.tracks.some(inQueue);
      if (moving && !tracking.getState().status?.paused && tick % SIZES_EVERY === SIZES_EVERY - 1) void loadClips();
    });
  }

  function stopTracking() {
    poll.stop();
    reads.reset();
  }

  /** The clip's row, known once the list has loaded. */
  const clipOf = (frame: number): Clip | undefined => {
    const key = sel.frameByNo().get(frame)?.clipKey;
    return frames.getState().clips?.find((c) => c.key === key);
  };

  /** After a Find: its keyframes' detections go on the queue, on clips that have frames to track on. */
  async function afterFind(found: readonly number[]) {
    const s = sessionOf(ctx);
    if (!on || !s) return;
    if (!frames.getState().clips) await loadClips();
    const fit = found.filter((f) => !clipOf(f)?.tracking?.keyframes_only);
    if (!fit.length) return;
    const res = await s.ops.track.auto({ frames: fit.join(","), threshold: layers.getState().threshold });
    if (res.isErr()) return r.report(res.error);
    apply(res.value);
    await refreshTracking();
  }

  const pause = async () => {
    const st = await r.run("Pausing tracking", (s) => s.ops.track.pause(), { refresh: false });
    apply(st ?? null);
  };
  const resume = async () => {
    const st = await r.run("Resuming tracking", (s) => s.ops.track.resume(), { refresh: false });
    apply(st ?? null);
  };
  /** Stops every track, or just these. Finished frames stay. */
  const cancelTracks = async (ids?: readonly string[]) => {
    const st = await r.run("Stopping tracking", (s) => s.ops.track.cancel(ids ? { ids: [...ids] } : {}), {
      refresh: false,
    });
    apply(st ?? null);
    await refreshTracking();
  };
  /** Starts tracks again where they stopped, and queues what was found and has no track yet. */
  const trackAgain = async () => {
    const stopped = (tracking.getState().status?.tracks ?? []).filter((t) => t.state === "cancelled");
    const s = sessionOf(ctx);
    if (!s) return;
    if (stopped.length) {
      const res = await s.ops.track.start({ ids: stopped.map((t) => t.det) });
      if (res.isErr()) return r.report(res.error);
    }
    const fit = frames
      .getState()
      .frames.map((f) => f.frame)
      .filter((f) => !clipOf(f)?.tracking?.keyframes_only);
    if (fit.length) {
      const res = await s.ops.track.auto({ frames: fit.join(","), threshold: layers.getState().threshold });
      if (res.isErr()) return r.report(res.error);
    }
    await refreshTracking();
  };
  /** Tracks these detections, restarting any track they have, ahead of the rest. */
  const trackFirst = async (ids: readonly string[]) => {
    const st = await r.run("Tracking", (s) => s.ops.track.start({ ids: [...ids], first: true }), { refresh: false });
    apply(st ?? null);
    await refreshTracking();
  };

  /**
   * The selection goes first. Detections on a track raise it. One selected detection with no track starts one, unless
   * every track was stopped, which says the user wants the GPU back. A stopped track stays stopped: the panel offers to
   * start it again.
   */
  async function followSelection() {
    const s = sessionOf(ctx);
    if (!on || !s) return;
    const { ids, obj } = selection.getState();
    const members = obj ? (sel.objById().get(obj)?.members ?? []) : [];
    const dets: readonly string[] = ids.length ? ids : members;
    if (!dets.length) return;
    const { status, proposals } = tracking.getState();
    const tracks = status?.tracks ?? [];
    const links = trackOfDet(proposals);
    const named = new Set(
      dets.flatMap((d) => [...tracks.filter((t) => t.det === d).map((t) => t.id), ...(links.get(d) ?? [])]),
    );
    const queued = tracks.filter((t) => named.has(t.id) && inQueue(t));
    if (queued.length) {
      const top = Math.max(...tracks.map((t) => t.priority));
      if (queued.every((t) => t.priority === top) && !tracks.some((t) => t.priority === top && !named.has(t.id)))
        return;
      const res = await s.ops.track.prioritise({ ids: queued.map((t) => t.id) });
      if (res.isOk()) apply(res.value);
      return;
    }
    if (named.size) return;
    if (triage.getState().page) return;
    if (tracks.length && tracks.every((t) => t.state === "cancelled")) return;
    const best = obj ? sel.objById().get(obj)?.best : null;
    const one = ids.length === 1 ? ids[0] : ids.length ? undefined : (best ?? undefined);
    if (!one) return;
    const d = sel.detById().get(one);
    if (!d || d.object === REJECTED || clipOf(d.frame)?.tracking?.keyframes_only) return;
    const res = await s.ops.track.start({ ids: [one], first: true });
    if (res.isOk()) apply(res.value);
    await refreshTracking();
  }

  /** Shows a place on the shown clip's grid. A keyframe's place shows that keyframe. */
  function setTrackAt(at: number) {
    const clip = sel.currentFrame()?.clipKey;
    const grid = clip ? tracking.getState().grids.get(clip) : undefined;
    const slot = grid?.frames[at];
    if (!slot || !grid) return;
    const floor = (s: TrackSlot) => s.keyframe !== null && s.at <= at;
    const keyframe =
      slot.keyframe ?? grid.frames.findLast(floor)?.keyframe ?? grid.frames.find((s) => s.keyframe !== null)?.keyframe;
    if (keyframe === null || keyframe === undefined) return;
    frames.setState({ current: keyframe });
    tracking.setState({ at: slot.keyframe === null ? at : null });
    sync();
  }

  /** Gives a keyframes-only clip its frames from its video file, picked again, and queues what was found on it. */
  async function prepareClip(c: Clip, file: File) {
    const done = await r.run(`Preparing the frames of ${c.name}`, (s) => s.prepareFile(file, c.key), {
      refresh: false,
    });
    await loadClips();
    if (!done) return;
    tracking.setState((t) => ({ grids: new Map([...t.grids].filter(([k]) => k !== c.key)) }));
    r.notify(`${c.name} is ready: ${done.frames} frames to track on.`, true);
    const [first, last] = c.frames;
    const s = sessionOf(ctx);
    if (s && first !== null && last !== null) {
      const res = await s.ops.track.auto({ frames: `${first}-${last}`, threshold: layers.getState().threshold });
      if (res.isErr()) r.report(res.error);
    }
    await refreshTracking();
  }

  return {
    startTracking,
    stopTracking,
    afterFind,
    followSelection,
    syncTracking: sync,
    setTrackAt,
    setTracksShown: (show: boolean) => tracking.setState({ show }),
    pauseTracking: pause,
    resumeTracking: resume,
    cancelTracks,
    trackAgain,
    trackFirst,
    prepareClip,
  };
}

export type TrackingActions = ReturnType<typeof createTrackingActions>;
