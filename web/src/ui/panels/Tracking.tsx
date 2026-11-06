/**
 * Video tracking in plain words: what the queue is doing, pause and stop, the tracks, and the slider over the frames
 * between keyframes. Only with `?models=<base>&tracker`. A track is the tracker's guess, and the text says so.
 */
import type { ReactNode } from "react";
import type { Clip, TrackRow } from "../../state/index.ts";
import { nextInLine, objColor, trackingPhase, trackOfDet } from "../../state/index.ts";
import { Crop, fmtBytes, Panel, useNativeInput, VideoInput } from "../common.tsx";
import { useActions, useApp, useDerived, useSlice } from "../context.tsx";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** What the queue is doing, as one sentence for the panel and a short one for the status bar. */
function useSummary() {
  const status = useSlice("tracking", (s) => s.status);
  const grids = useSlice("tracking", (s) => s.grids);
  const phase = trackingPhase(status, grids);
  const tracks = status?.tracks ?? [];
  const done = tracks.reduce((a, t) => a + t.done, 0);
  const total = tracks.reduce((a, t) => a + t.total, 0);
  const waiting = status?.waiting ?? 0;
  const live = tracks.filter((t) => t.state === "active" && !t.finished).length;
  return { phase, tracks, done, total, waiting, live, next: nextInLine(tracks) };
}

function PauseStop() {
  const a = useActions();
  const paused = useSlice("tracking", (s) => s.status?.paused ?? false);
  return (
    <span className="track-buttons">
      {paused ? (
        <button type="button" data-track-resume onClick={() => void a.resumeTracking()}>
          Resume
        </button>
      ) : (
        <button
          type="button"
          data-track-pause
          title="Stops using the GPU after the frame in progress"
          onClick={() => void a.pauseTracking()}
        >
          Pause
        </button>
      )}
      <button
        type="button"
        className="danger"
        data-track-cancel
        title="Stops all tracks. What is finished stays, and you can start them again."
        onClick={() => void a.cancelTracks()}
      >
        Stop
      </button>
    </span>
  );
}

/** The status bar's line: always in view, with the same buttons. */
export function TrackingStat() {
  const { phase, done, total } = useSummary();
  if (phase.kind === "off" || phase.kind === "finished" || phase.kind === "stopped") return null;
  const words =
    phase.kind === "paused"
      ? `Tracking paused at ${done}/${total} frames`
      : phase.kind === "preparing"
        ? `Tracking: preparing frames ${phase.read}/${phase.frames}`
        : `Tracking ${done}/${total} frames`;
  return (
    <span className="stat" data-tracking-stat>
      {words} <progress max={Math.max(1, total)} value={done} aria-label="Tracking progress" /> <PauseStop />
    </span>
  );
}

const rowState = (t: TrackRow, first: boolean): string => {
  if (t.state === "failed") return `Failed: ${t.failure ?? "unknown error"}. Its finished frames are kept.`;
  if (t.state === "cancelled") return "Stopped. Its finished frames are kept.";
  if (t.finished) return t.seen ? `Finished: seen on ${t.seen.count} of ${t.total} frames` : "Finished";
  if (!t.seen) return first ? "Goes first, starting" : "Waiting";
  if (t.parked) return "Out of view: looking again every so often";
  return first ? "Goes first" : "Waiting its turn";
};

function TrackRowView({ t, first }: { readonly t: TrackRow; readonly first: boolean }) {
  const a = useActions();
  const det = useDerived((s) => s.detById().get(t.det));
  const obj = useDerived((s) => (t.object ? s.objById().get(t.object) : undefined));
  const name = obj?.label || t.object || det?.prompt || "tracked";
  const queued = t.state === "active" && !t.finished;
  return (
    <li className="track-row" data-track={t.id} data-first={first || undefined}>
      <button
        type="button"
        className="track-pick"
        title="Select what this track started from; it goes first"
        onClick={() => a.select([t.det])}
      >
        {det ? <Crop det={det} size={32} label={`${name} where tracking started`} /> : <span className="crop ph" />}
        <i className="sw" style={{ background: objColor(t.object ?? t.id) }} />
        <span className="track-name">
          {name} <span className="muted">· {t.id}</span>
          <br />
          <span className="muted small">{rowState(t, first)}</span>
        </span>
        <span
          className="muted small track-count"
          title={t.skipped ? `${t.skipped} skipped while out of view` : undefined}
        >
          {t.done}/{t.total}
        </span>
      </button>
      {queued && (
        <button
          type="button"
          aria-label={`Stop tracking ${name} ${t.id}`}
          title="Stop this track"
          onClick={() => void a.cancelTracks([t.id])}
        >
          ×
        </button>
      )}
    </li>
  );
}

/** Picks the clip's video again to store the frames between its keyframes. */
function PrepareClip({ c }: { readonly c: Clip }) {
  const a = useActions();
  return (
    <span className="opt">
      <label className="button" data-prepare-clip={c.key}>
        Pick the video to prepare it…
        <VideoInput label={`Pick ${c.name} again to prepare its frames`} onFile={(f) => void a.prepareClip(c, f)} />
      </label>
    </span>
  );
}

export function TrackingPanel() {
  const a = useActions();
  const { phase, tracks, done, total, waiting, live, next } = useSummary();
  const leftOut = useSlice("tracking", (s) => s.proposals?.left_out.length ?? 0);
  const limit = useSlice("engine", (s) => s.config.auto_tracks);
  const show = useSlice("tracking", (s) => s.show);
  const clips = useSlice("frames", (s) => s.clips);
  const place = useDerived((s) => s.trackPlace());
  const cuts = useSlice("tracking", (s) => (place ? (s.grids.get(place.clip)?.cuts.length ?? 0) : 0));
  const flagged = (clips ?? []).filter((c) => c.tracking?.keyframes_only);
  const canTrack = (clips ?? []).some((c) => c.detections > 0 && !c.tracking?.keyframes_only);
  const bytes = (clips ?? []).reduce(
    (n, c) => n + (c.tracking ? c.tracking.trunk_bytes + c.tracking.frame_bytes + c.tracking.track_bytes : 0),
    0,
  );
  return (
    <Panel id="tracking" title="Tracking" badge={tracks.length || undefined}>
      <div className="track-summary" data-track-phase={phase.kind} role="status">
        {phase.kind === "off" && (
          <p className="muted">
            After a search, everything it finds is followed through the video here, so you can see it between keyframes.
          </p>
        )}
        {phase.kind === "paused" && (
          <p>
            <strong>Paused.</strong> Tracking is not using the GPU. {done} of {total} frames are done and saved.
          </p>
        )}
        {phase.kind === "preparing" && (
          <p>
            <strong>
              Preparing the video: frame {phase.read} of {phase.frames}.
            </strong>{" "}
            The first pass is the slow part, about a minute for a 20-second video on a mid-range GPU. Each frame is
            analysed once and saved, so the next objects go much faster.
          </p>
        )}
        {phase.kind === "running" && (
          <p>
            <strong>
              Following {plural(live, "track")}: {done} of {total} frames done.
            </strong>{" "}
            This can take several minutes and keeps the GPU busy. You can keep working: searching goes ahead of it.
          </p>
        )}
        {phase.kind === "stopped" && (
          <p>
            <strong>Stopped.</strong> {done} of {total} frames are done and saved.
          </p>
        )}
        {phase.kind === "finished" && (
          <p>
            <strong>Finished.</strong> Move the “Tracked frames” slider under the picture to see the tracks.
          </p>
        )}
        {waiting > 0 && (
          <p className="muted small">
            {plural(waiting, "keyframe")} still to check for new things to follow, once the tracks get there.
          </p>
        )}
        {next && live > 1 && phase.kind !== "paused" && (
          <p className="muted small">Select something, here or on the picture, to make it go first.</p>
        )}
      </div>
      {tracks.length > 0 && phase.kind !== "stopped" && phase.kind !== "finished" && <PauseStop />}
      {(phase.kind === "stopped" || (phase.kind === "off" && canTrack)) && (
        <span className="track-buttons">
          <button type="button" data-track-again onClick={() => void a.trackAgain()}>
            {phase.kind === "stopped" ? "Start tracking again" : "Track what was found"}
          </button>
        </span>
      )}
      {flagged.map((c) => (
        <div className="track-flag" key={c.key} data-keyframes-only={c.key}>
          <p>
            <strong>{c.name}</strong>{" "}
            {c.tracking?.can_prepare
              ? "has only its keyframes stored, so nothing can be followed between them. To track it, its other frames have to be read from the file."
              : "is a set of photos, which can't be tracked."}
          </p>
          {c.tracking?.can_prepare && <PrepareClip c={c} />}
        </div>
      ))}
      {leftOut > 0 && (
        <p className="small" data-left-out={leftOut}>
          {plural(leftOut, "detection")} {leftOut === 1 ? "has" : "have"} no track: a video gets at most{" "}
          {limit ?? "a fixed number of"} automatic tracks, to keep the GPU from being busy for hours. Select one to
          track it yourself.
        </p>
      )}
      {tracks.length > 0 && (
        <>
          <p className="muted small">
            A track is the tracker’s best guess. It can jump onto a different object without warning, so check it before
            relying on it. An outline with “?” means less sure.
          </p>
          {cuts > 0 && <p className="muted small">This video has {plural(cuts, "cut")}. A track stops at a cut.</p>}
          <label className="row">
            <input
              type="checkbox"
              checked={show}
              data-track-show
              onChange={(e) => a.setTracksShown(e.currentTarget.checked)}
            />
            Show tracked masks on the picture
          </label>
          <ul className="list tracks" aria-label="Tracks">
            {tracks.map((t) => (
              <TrackRowView key={t.id} t={t} first={next?.id === t.id} />
            ))}
          </ul>
        </>
      )}
      {bytes > 0 && (
        <p className="muted small" data-track-bytes>
          Tracking stores {fmtBytes(bytes)} on this computer for this session. The Videos panel shows it per video.
        </p>
      )}
    </Panel>
  );
}

/** Its own component, so its native input listener attaches when the slider first exists. */
function TrackSlider({
  at,
  n,
  t,
  children,
}: {
  readonly at: number;
  readonly n: number;
  readonly t: number;
  readonly children: ReactNode;
}) {
  const a = useActions();
  const go = (v: string) => a.setTrackAt(Number(v));
  const slider = useNativeInput(go);
  return (
    <div className="slider">
      <input
        ref={slider}
        type="range"
        min={0}
        max={n - 1}
        step={1}
        value={at}
        data-track-slider
        aria-label="Tracked frames"
        aria-valuetext={`Frame ${at + 1} of ${n}, ${t.toFixed(1)} seconds`}
        onChange={(e) => go(e.currentTarget.value)}
      />
      {children}
    </div>
  );
}

/** Under the keyframes: the slider over every frame tracking uses, or the flag of a clip that has only keyframes. */
export function TrackScrub() {
  const place = useDerived((s) => s.trackPlace());
  const draws = useDerived((s) => s.trackDraws().length);
  const clipKey = useDerived((s) => s.currentFrame()?.clipKey);
  const clip = useSlice("frames", (s) => s.clips?.find((c) => c.key === clipKey));
  const cuts = useSlice("tracking", (s) => (clipKey ? (s.grids.get(clipKey)?.cuts ?? null) : null));
  const times = useSlice("tracking", (s) => (clipKey ? (s.grids.get(clipKey)?.frames ?? null) : null));
  const reached = useSlice("tracking", (s) =>
    place
      ? (s.status?.tracks ?? []).some(
          (t) => t.clip === place.clip && t.seen && t.reverse <= place.at && place.at <= t.forward,
        )
      : false,
  );
  const moving = useSlice(
    "tracking",
    (s) => nextInLine(s.status?.tracks ?? []) !== null || (s.status?.waiting ?? 0) > 0,
  );
  if (clip?.tracking?.keyframes_only)
    return clip.tracking.can_prepare ? (
      <div className="scrub track-scrub" data-keyframes-only>
        <span className="muted small">
          This video has only keyframes, so tracking can’t follow things between them.
        </span>
        <PrepareClip c={clip} />
      </div>
    ) : null;
  if (!place || !times) return null;
  const n = place.count;
  return (
    <div className="scrub track-scrub">
      <span className="muted small track-scrub-label">Tracked frames</span>
      <TrackSlider at={place.at} n={n} t={place.slot.t}>
        <div className="ticks" aria-hidden="true">
          {(cuts ?? []).flatMap((c) => {
            const k = times.findIndex((s) => s.t >= c);
            return k < 0
              ? []
              : [<i key={c} title="cut" style={{ left: `calc(${n > 1 ? k / (n - 1) : 0} * (100% - 14px) + 7px)` }} />];
          })}
        </div>
      </TrackSlider>
      <span className="frame-no" aria-live="polite" data-track-place>
        {place.at + 1}/{n} · {place.slot.t.toFixed(1)} s ·{" "}
        {reached
          ? draws
            ? plural(draws, "mask")
            : "nothing seen here"
          : moving
            ? "not tracked yet"
            : "no tracks here"}
      </span>
    </div>
  );
}

/** In the Properties panel: what tracking is doing with the selected detections or object. */
export function TrackNote({ dets }: { readonly dets: readonly string[] }) {
  const app = useApp();
  const a = useActions();
  const tracks = useSlice("tracking", (s) => s.status?.tracks ?? null);
  const proposals = useSlice("tracking", (s) => s.proposals);
  if (!app.tracking || !tracks) return null;
  const links = trackOfDet(proposals);
  const mine = tracks.filter((t) => dets.includes(t.det) || dets.some((d) => links.get(d) === t.id));
  if (!mine.length) return null;
  const queued = mine.filter((t) => t.state === "active" && !t.finished);
  const stopped = mine.filter((t) => t.state === "cancelled");
  const done = mine.reduce((n, t) => n + t.done, 0);
  const total = mine.reduce((n, t) => n + t.total, 0);
  return (
    <p className="small track-note" data-track-note>
      {queued.length
        ? `Tracking this first: ${done} of ${total} frames.`
        : stopped.length
          ? `Tracking stopped at ${done} of ${total} frames.`
          : `Tracked: ${done} of ${total} frames.`}{" "}
      {stopped.length > 0 && (
        <button type="button" className="link" onClick={() => void a.trackFirst(stopped.map((t) => t.det))}>
          Track again
        </button>
      )}
    </p>
  );
}
