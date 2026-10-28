import { clipsStorage } from "../../state/index.ts";
import type { Clip } from "../../state/index.ts";
import { fmtBytes, VideoInput } from "../common.tsx";
import { useActions, useSlice } from "../context.tsx";
import { HELP, PANEL_HELP, PREFERENCE_HELP, budgetLabel, reencodeTime } from "../help.ts";
import { Info } from "../Info.tsx";

const fmtDate = (s: string | null) => {
  if (!s) return "date unknown";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export function VideosPanel() {
  const a = useActions();
  const cs = useSlice("frames", (s) => s.clips);
  const busy = useSlice("notices", (s) => s.busy.length > 0);
  const persistOn = useSlice("settings", (s) => s.persistFeatures);
  const budgetMB = useSlice("settings", (s) => s.featureDiskMB);
  const total = clipsStorage(cs ?? []);
  const dropClip = async (c: Clip) => {
    const { keyframes } = clipsStorage([c]);
    const ok = await a.ask(
      `Drop the stored image features of ${c.name} (${fmtBytes(c.feature_bytes)})? Its detections, objects and ` +
        `labels stay. Searching ${keyframes === 1 ? "its keyframe again encodes it" : "its keyframes again encodes them"} ` +
        `first: ${reencodeTime(keyframes)} on a mid-range ` +
        `GPU.${persistOn ? " Keep image features on disk is on, so they are saved again as they are re-encoded." : ""}`,
      "Drop features",
    );
    if (ok) await a.dropClipFeatures(c);
  };
  return (
    <details
      className="panel"
      id="panel-videos"
      onToggle={(e) => {
        const open = e.currentTarget.open;
        a.watchClips(open);
        if (open) void a.loadClips();
      }}
    >
      <summary>
        <span title={PANEL_HELP.videos.tip}>Videos</span>
        <Info help={PANEL_HELP.videos} />
        {cs && <span className="badge">{cs.length}</span>}
      </summary>
      <div className="panel-body">
        {!cs ? (
          <p className="muted">Loading…</p>
        ) : (
          !cs.length && <p className="muted">No videos in this session yet.</p>
        )}
        <ul className="list videos" aria-label="Videos in this session">
          {(cs ?? []).map((c) => (
            <li key={c.key} className="video" data-clip={c.key}>
              <button
                type="button"
                className="video-row"
                title={`${c.path}\nkey ${c.key}`}
                aria-label={`Go to ${c.name}, keyframes ${c.frames[0]} to ${c.frames[1]}`}
                onClick={() => {
                  const first = c.frames[0];
                  if (first !== null) a.setFrame(first);
                }}
              >
                <strong className="vname">{c.name}</strong>
                <span className="muted">
                  #{c.frames[0]}–#{c.frames[1]} · {c.keyframes} keyframe{c.keyframes === 1 ? "" : "s"} ·{" "}
                  {fmtDate(c.captured)}
                </span>
                <span className="muted">
                  {c.detections} detections · {c.objects} object{c.objects === 1 ? "" : "s"}
                </span>
                <span className="muted" data-clip-bytes>
                  {fmtBytes(c.frame_bytes)} keyframe images · {c.feature_bytes ? fmtBytes(c.feature_bytes) : "no"}{" "}
                  features stored
                </span>
              </button>
              <span className="video-actions">
                {c.feature_bytes > 0 && (
                  <button
                    type="button"
                    aria-label={`Drop features of ${c.name}`}
                    title={HELP.dropFeatures.tip}
                    disabled={busy}
                    onClick={() => void dropClip(c)}
                  >
                    Drop features
                  </button>
                )}
                <button
                  type="button"
                  className="danger"
                  aria-label={`Remove ${c.name}`}
                  title={HELP.removeVideo.tip}
                  disabled={busy}
                  onClick={() => void a.removeClip(c)}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
        {cs && cs.length > 0 && (
          <p className="small" data-session-bytes>
            This session: {fmtBytes(total.frames)} keyframe images · {fmtBytes(total.features)} image features
            {persistOn && (
              <span className="muted" data-disk-budget>
                {" "}
                of {budgetLabel(budgetMB)} disk budget
              </span>
            )}{" "}
            <Info help={PREFERENCE_HELP.featureDiskMB} />
          </p>
        )}
        <span className="opt">
          <label className="button" title={HELP.addVideo.tip}>
            Add video…
            <VideoInput label="Add a video (Videos panel)" id="videos-add" onFile={(f) => void a.addVideo(f)} />
          </label>
        </span>
        <p className="muted small">
          Clips of the same moment share one keyframe numbering. Removing a video keeps the others' numbers; adding it
          again puts it back where it was.
        </p>
      </div>
    </details>
  );
}
