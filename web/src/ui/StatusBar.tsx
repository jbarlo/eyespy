import { currentTask } from "../state/index.ts";
import { fmtBytes } from "./common.tsx";
import { useActions, useSlice } from "./context.tsx";
import { HELP } from "./help.ts";

export function StatusBar() {
  const a = useActions();
  const st = useSlice("engine", (s) => s.status);
  const phase = useSlice("engine", (s) => s.phase);
  const device = useSlice("engine", (s) => s.session?.info.device);
  const shown = device?.replace(/^webgpu /, "WebGPU ");
  const downloads = useSlice("engine", (s) => s.downloads);
  const cv = useSlice("engine", (s) => s.progress);
  const b = useSlice("notices", currentTask);
  const active = Object.entries(downloads).filter(([, d]) => !d.done);
  const loaded = active.reduce((n, [, d]) => n + d.loaded, 0),
    total = active.reduce((n, [, d]) => n + d.total, 0);
  const enc = st && st.keyframes ? st.encoded / st.keyframes : 1;
  return (
    <footer className="statusbar" aria-label="Status">
      <span className={`dot ${phase}`} aria-hidden="true" />
      <span title={`${shown ?? ""}\nThe models run here, in this tab, on your GPU (WebGPU); nothing is uploaded.`}>
        {phase === "ready" ? shown : phase === "failed" ? "engine failed" : "starting engine…"}
      </span>
      {st && st.keyframes > 0 && (
        <span className="stat" title={`${HELP.encoding.tip}\n\n${HELP.keyframes.tip}`}>
          {enc < 1 ? (
            <>
              Encoding {st.encoded}/{st.keyframes}{" "}
              <progress max={st.keyframes} value={st.encoded} aria-label="Encoding keyframes" />
            </>
          ) : (
            `${st.keyframes} keyframe${st.keyframes === 1 ? "" : "s"} encoded`
          )}
        </span>
      )}
      {active.length > 0 && (
        <span
          className="stat"
          title={active.map(([n, d]) => `${n}: ${fmtBytes(d.loaded)} / ${fmtBytes(d.total)}`).join("\n")}
        >
          Downloading {active.map(([n]) => n.replace(/\.onnx$/, "")).join(", ")} {fmtBytes(loaded)} / {fmtBytes(total)}{" "}
          <progress max={total} value={loaded} aria-label="Model download" />
        </span>
      )}
      {cv && (
        <span className="stat">
          {cv.stage} {cv.file} <progress max={1} value={cv.fraction} aria-label="Video processing" />{" "}
          {Math.round(cv.fraction * 100)}%
        </span>
      )}
      {b && (
        <span className="stat busy" role="status">
          <span className="spin" aria-hidden="true" />
          {b.label}
          {b.total ? ` ${b.done ?? 0}/${b.total}` : "…"}
          {b.total ? <progress max={b.total} value={b.done ?? 0} aria-label={b.label} /> : null}
          {b.cancellable && (
            <button type="button" className="link" onClick={() => a.cancelTask(b.id)}>
              Cancel
            </button>
          )}
        </span>
      )}
      <span className="grow" />
      {st && (
        <span className="muted">
          {st.detections} detections · {st.objects} objects · {st.todo} todo
        </span>
      )}
      <span className="muted legal">
        By using this app you accept the <a href="models/LICENSE-SAM.txt">SAM License</a> and{" "}
        <a href="THIRD_PARTY_NOTICES.txt">third-party licences</a>.
      </span>
    </footer>
  );
}

export function Toasts() {
  const a = useActions();
  const notices = useSlice("notices", (s) => s.notices);
  return (
    <div className="toasts" role="alert" aria-live="assertive">
      {notices.map((e) => (
        <div className={`toast${e.info ? " info" : ""}`} key={e.id} role={e.info ? "status" : undefined}>
          <span>{e.text}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => a.dismiss(e.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
