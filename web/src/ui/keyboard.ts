import type { App } from "../state/index.ts";
import { TOOLS } from "./stage/tools.ts";

/** A form field other than a slider or checkbox, or editable content, has focus. */
function typing(t: EventTarget | null): boolean {
  if (t instanceof HTMLInputElement) return t.type !== "range" && t.type !== "checkbox";
  return (
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

export function keyHandler(app: App) {
  const { actions: a, stores } = app;
  const hasSelection = () => stores.selection.getState().ids.length > 0;
  return (e: KeyboardEvent) => {
    if (document.querySelector("dialog[open]")) return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (k === "z" || k === "Z")) {
      if (typing(e.target)) return;
      e.preventDefault();
      void (e.shiftKey ? a.redo() : a.undo());
      return;
    }
    if (mod && k === "y") {
      e.preventDefault();
      void a.redo();
      return;
    }
    if (k === "Escape") {
      if (typing(e.target) && e.target instanceof HTMLElement) e.target.blur();
      else a.clearSelection();
      return;
    }
    if (typing(e.target) || mod || e.altKey) return;
    const stage = () => stores.stage.getState().handle;
    const keys: Readonly<Record<string, () => void>> = {
      ...Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), () => a.setTool(t.id)])),
      ArrowLeft: () => a.stepFrame(-1),
      ArrowRight: () => a.stepFrame(1),
      Home: () => a.stepFrame(-Infinity),
      End: () => a.stepFrame(Infinity),
      "/": () => document.getElementById("prompt-input")?.focus(),
      a: () => {
        const top = stores.selection.getState().matches?.list[0];
        if (top && hasSelection()) void a.assign(top.obj);
      },
      n: () => {
        if (hasSelection()) void a.newObject(stores.triage.getState().newLabel);
      },
      x: () => {
        if (hasSelection()) void a.reject();
      },
      Delete: () => {
        if (hasSelection()) void a.reject();
      },
      s: () => void a.skipGroup(1),
      S: () => void a.skipGroup(-1),
      "+": () => stage()?.zoom(1.25),
      "=": () => stage()?.zoom(1.25),
      "-": () => stage()?.zoom(0.8),
      "0": () => stage()?.fit(),
    };
    const f = keys[k];
    if (f) {
      e.preventDefault();
      f();
    }
  };
}
