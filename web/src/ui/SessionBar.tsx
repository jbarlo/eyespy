import { useRef, useState } from "react";
import { useActions, useSlice } from "./context.tsx";
import { VideoInput } from "./common.tsx";
import { HELP } from "./help.ts";

export function SessionBar() {
  const a = useActions();
  const [sessions, setSessions] = useState<readonly string[]>([]);
  const menu = useRef<HTMLDetailsElement>(null);
  const label = useSlice("engine", (s) => s.label);
  const kind = useSlice("engine", (s) => s.kind);
  const ready = useSlice("engine", (s) => s.phase === "ready");
  const clipCount = useSlice("frames", (s) => s.clips?.length ?? null);
  const hasObjects = useSlice("objects", (s) => s.objects.length > 0);
  const close = () => menu.current?.removeAttribute("open");
  return (
    <header className="topbar">
      <strong className="brand">eyespy</strong>
      <details
        className="menu"
        ref={menu}
        onToggle={(e) => {
          if (e.currentTarget.open) void a.listSessions().then(setSessions);
        }}
      >
        <summary aria-label="Session menu">
          Session: <span className="session-name">{label || "…"}</span>
          {kind === "folder" && <span className="muted"> (folder)</span>} ▾
        </summary>
        <div className="menu-body" role="menu">
          <label className="menu-item file" role="menuitem">
            New session from video…
            <VideoInput
              label="New session from video"
              onFile={(f) => {
                close();
                void a.newSessionFromVideo(f);
              }}
            />
          </label>
          <label className="menu-item file" role="menuitem" title={HELP.addVideo.tip}>
            Add video to this session…
            <VideoInput
              label="Add video to this session"
              onFile={(f) => {
                close();
                void a.addVideo(f);
              }}
            />
          </label>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!ready}
            onClick={() => {
              close();
              const p = document.getElementById("panel-videos");
              if (p) {
                p.setAttribute("open", "");
                p.scrollIntoView({ block: "start" });
              }
            }}
          >
            Videos in this session{clipCount !== null ? ` (${clipCount})` : ""}…
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!a.canPickFolder}
            title={a.canPickFolder ? HELP.openFolder.tip : "This browser has no folder picker"}
            onClick={() => {
              close();
              void a.openFolder();
            }}
          >
            Open folder…
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!hasObjects}
            title={HELP.export.tip}
            onClick={() => {
              close();
              void a.exportManifest();
            }}
          >
            Export manifest (JSON)
          </button>
          <div className="menu-sep" title="Kept in this browser's storage (OPFS); Settings shows what each takes">
            Browser sessions
          </div>
          {sessions.map((n) => (
            <button
              type="button"
              role="menuitem"
              className={`menu-item${n === label && kind === "opfs" ? " on" : ""}`}
              key={n}
              data-session={n}
              onClick={() => {
                close();
                void a.openSession({ opfs: n });
              }}
            >
              {n}
            </button>
          ))}
          {!sessions.length && <span className="muted menu-item">none yet</span>}
        </div>
      </details>
      <span className="grow" />
      <button
        type="button"
        id="export-manifest"
        className="ghost"
        disabled={!hasObjects}
        title={HELP.export.tip}
        onClick={() => void a.exportManifest()}
      >
        Export manifest
      </button>
      <button type="button" className="ghost" aria-label="Settings" onClick={() => a.openSettings(true)}>
        Settings
      </button>
      <a className="ghost" href="?debug" title="The bare engine debug page">
        Debug
      </a>
    </header>
  );
}
