/**
 * Page globals for agents and automation scripts, built from the stores: window.eyespyUI (a plain state snapshot and
 * the UI's actions), window.eyespyStage (the mounted canvas), window.eyespy (the open session's router ops) and
 * window.eyespyEvents (engine events). Scripts depend on these names and shapes.
 */
import type { EngineEvent } from "../engine/port.ts";
import type { App, LayerId, StageHandle, ToolId } from "../state/index.ts";
import { currentTask } from "../state/index.ts";

function createEyespyUI(app: App) {
  const { stores: s, select, actions: a } = app;
  return {
    /** A plain snapshot of what the UI shows. */
    state: () => {
      const e = s.engine.getState(),
        f = s.frames.getState(),
        sel = s.selection.getState(),
        l = s.layers.getState(),
        t = s.triage.getState().page,
        n = s.notices.getState();
      return {
        session: e.label,
        engine: e.phase,
        frame: f.current,
        frames: f.frames.length,
        selection: [...sel.ids],
        selectedObj: sel.obj,
        tool: l.tool,
        layers: { ...l.layers },
        threshold: l.threshold,
        visible: select.visible().map((v) => ({ id: v.det.id, kind: v.kind })),
        triage: t && { offset: t.offset, groups: t.groupsTotal, ids: [...(t.group?.ids ?? [])] },
        matches: sel.matches?.list.map((m) => m.obj) ?? [],
        busy: currentTask(n)?.label ?? null,
        downloads: Object.entries(e.downloads)
          .filter(([, d]) => !d.done)
          .map(([name]) => name),
        errors: n.notices.filter((x) => !x.info).map((x) => x.text),
        notes: n.notices.filter((x) => x.info).map((x) => x.text),
        frameNumbers: f.frames.map((x) => x.frame),
        clips:
          f.clips?.map((c) => ({
            key: c.key,
            name: c.name,
            frames: c.frames,
            keyframes: c.keyframes,
            detections: c.detections,
            objects: c.objects,
          })) ?? null,
      };
    },
    setFrame: a.setFrame,
    stepFrame: a.stepFrame,
    select: (ids: string[], add?: boolean) => a.select(ids, add),
    setTool: (t: ToolId) => a.setTool(t),
    setLayer: (id: LayerId, on: boolean) => a.setLayer(id, on),
    setThreshold: (v: number) => a.setThreshold(v),
    find: a.find,
    openSession: a.openSession,
    refresh: a.refresh,
    /** Resolves when no engine action is running. */
    idle: () =>
      new Promise<void>((resolve) => {
        if (!s.notices.getState().busy.length) return resolve();
        const off = s.notices.subscribe((n) => {
          if (n.busy.length) return;
          off();
          resolve();
        });
      }),
  };
}

type EyespyUI = ReturnType<typeof createEyespyUI>;

declare global {
  interface Window {
    /** UI state snapshot and actions. */
    eyespyUI: EyespyUI;
    /** The mounted Stage, or undefined when none is mounted. */
    eyespyStage?: StageHandle;
  }
}

const MAX_EVENTS = 10_000;

/**
 * window.eyespyEvents, bounded. It keeps only the first and last download progress event per file, and drops the
 * oldest entries past MAX_EVENTS. A session switch never resets it, because scripts slice from an index taken before
 * reopening.
 */
export function createEventLog() {
  const events: EngineEvent[] = [];
  const seen = new Set<string>();
  return {
    events,
    push(e: EngineEvent) {
      if (e.kind === "download" && !e.done && seen.has(e.name)) return;
      if (e.kind === "download") seen.add(e.name);
      if (e.kind === "download" && e.done) seen.delete(e.name);
      events.push(e);
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    },
  };
}

/** Installs the globals on `win` and returns a function that removes them. window.eyespy follows the open session. */
export function installAutomation(win: Window, app: App, events: EngineEvent[]): () => void {
  win.eyespyUI = createEyespyUI(app);
  win.eyespyEvents = events;
  Object.defineProperty(win, "eyespyStage", {
    configurable: true,
    get: () => app.stores.stage.getState().handle ?? undefined,
  });
  return app.stores.engine.subscribe((e, prev) => {
    if (e.session && e.session !== prev.session) win.eyespy = e.session.api;
  });
}
