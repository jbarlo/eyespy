/** What the canvas area shows before there are keyframes. */
import { useState } from "react";
import { VideoInput } from "./common.tsx";
import { DOWNLOAD_GB } from "./help.ts";
import { useActions, useSlice } from "./context.tsx";

export function Empty() {
  const a = useActions();
  const [over, setOver] = useState(false);
  const phase = useSlice("engine", (s) => s.phase);
  const error = useSlice("engine", (s) => s.error);
  if (phase === "failed")
    return (
      <div className="empty-state" role="alert">
        <h2>The engine could not start</h2>
        <p>{error}</p>
        <p className="muted">eyespy needs a browser with WebGPU turned on.</p>
      </div>
    );
  if (phase === "starting")
    return (
      <div className="empty-state">
        <p>Starting the engine…</p>
      </div>
    );
  return (
    <div
      className={`empty-state drop${over ? " over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) void a.addVideo(f);
      }}
    >
      <h2>Add a video to start</h2>
      <p className="muted">
        Drop a video here, or pick one. Everything runs in this tab: the video never leaves your machine.
      </p>
      <label className="button primary">
        Choose video…
        <VideoInput label="Choose video" id="empty-video" onFile={(f) => void a.addVideo(f)} />
      </label>
      <p className="muted small">
        The first search downloads the models (about {DOWNLOAD_GB} GB, once; cached in the browser). The SAM 3 models
        are under Meta&apos;s <a href="models/LICENSE-SAM.txt">SAM License</a>; other licences:{" "}
        <a href="THIRD_PARTY_NOTICES.txt">third-party notices</a>.
      </p>
    </div>
  );
}
