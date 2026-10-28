import { useEffect } from "react";
import { useApp, useSlice } from "./context.tsx";
import { ConfirmDialog, UnsupportedVideoDialog } from "./dialogs/Questions.tsx";
import { LicenceBanner, LicenceDialog } from "./dialogs/Licence.tsx";
import { SettingsDialog } from "./dialogs/Settings.tsx";
import { Empty } from "./Empty.tsx";
import { Filmstrip } from "./Filmstrip.tsx";
import { keyHandler } from "./keyboard.ts";
import { ObjectsDatalist, PANELS } from "./panels/index.ts";
import { PromptBar } from "./PromptBar.tsx";
import { SessionBar } from "./SessionBar.tsx";
import { Stage } from "./stage/Stage.tsx";
import { StatusBar, Toasts } from "./StatusBar.tsx";
import { Toolbar } from "./Toolbar.tsx";
import "./app.css";

export function App() {
  const app = useApp();
  useEffect(() => {
    const onKey = keyHandler(app);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [app]);
  const hasFrames = useSlice("frames", (s) => s.frames.length > 0);
  const triageOn = useSlice("triage", (s) => s.page !== null);
  // triage moves to the top while it runs (keyed by id, so panels keep their state when reordered)
  const panels = triageOn
    ? [...PANELS.filter((p) => p.id === "triage"), ...PANELS.filter((p) => p.id !== "triage")]
    : PANELS;
  return (
    <div className="app">
      <SessionBar />
      <Toolbar />
      <main className="main">
        <LicenceBanner />
        <PromptBar />
        {hasFrames ? <Stage /> : <Empty />}
        <Filmstrip />
      </main>
      <aside className="side" aria-label="Panels">
        {panels.map(({ id, Panel }) => (
          <Panel key={id} />
        ))}
      </aside>
      <StatusBar />
      <Toasts />
      <ObjectsDatalist />
      <UnsupportedVideoDialog />
      <ConfirmDialog />
      <SettingsDialog />
      <LicenceDialog />
    </div>
  );
}
