/** The web composition root. ?debug loads the bare engine page instead. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createEventLog, installAutomation } from "./automation/index.ts";
import { browserClock, browserHost, browserStorage } from "./browser.ts";
import { createEngine } from "./engine/client.ts";
import type { EyespyApi } from "./engine/port.ts";
import { pageParams } from "./engine/params.ts";
import { browserImaging, createAssetCaches, createStores } from "./state/index.ts";
import { App } from "./ui/App.tsx";
import { StoresProvider } from "./ui/context.tsx";

declare const __EYESPY_REV__: string;
declare const __EYESPY_SAM_LICENSE_SHA256__: string;

function start() {
  const q = new URLSearchParams(location.search);
  const { models, runtime } = pageParams(location.search);
  const events = createEventLog();
  const engine = createEngine({
    models,
    runtime,
    host: { eyespy: __EYESPY_REV__ },
    tap: (e) => events.push(e),
  });
  const assets = createAssetCaches({
    imaging: browserImaging,
    onError: (what, key, e) => {
      if (e.kind !== "disposed") console.warn(`eyespy: ${what} ${key}:`, e.message);
    },
  });
  const app = createStores({
    engine,
    assets,
    storage: browserStorage,
    query: { get: (k) => q.get(k) },
    clock: browserClock,
    host: browserHost,
    samLicense: __EYESPY_SAM_LICENSE_SHA256__,
  });
  installAutomation(window, app, events.events);
  const el = document.getElementById("app");
  if (!el) throw new Error("no #app element");
  createRoot(el).render(
    <StrictMode>
      <StoresProvider app={app}>
        <App />
      </StoresProvider>
    </StrictMode>,
  );
  window.eyespyReady = app.actions.openSession({ opfs: app.actions.initialSession() }).then((api): EyespyApi => {
    if (!api) throw new Error(app.stores.engine.getState().error ?? "engine failed to start");
    return api;
  });
}

if (new URLSearchParams(location.search).has("debug")) void import("./debug/index.ts");
else start();
