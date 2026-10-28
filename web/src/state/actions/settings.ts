/** Settings and browser storage. */
import type { ConfigKey } from "eyespy-core/session/pure";
import { PREF, asFeatureCacheMB, asFeatureDiskMB, featureDiskPref } from "../settings.ts";
import { summarizeStorage } from "../storage.ts";
import type { StorageSummary } from "../storage.ts";
import type { Clip, Detector } from "../types.ts";
import type { Ctx } from "./context.ts";
import type { Runner } from "./run.ts";

export function createSettingsActions(ctx: Ctx, r: Runner, loadClips: () => Promise<void>) {
  const { settings, engine } = ctx.stores;
  const { storage, host } = ctx.deps;

  /** The OPFS session open in this tab (null for a folder session). */
  const openOpfs = () => {
    const { kind, label, session } = engine.getState();
    return session && kind === "opfs" ? label : null;
  };

  async function setPersistFeatures(on: boolean) {
    settings.setState({ persistFeatures: on });
    storage.prefs.set(PREF.persistFeatures, on ? "1" : "0");
    await r.run("Feature storage", (s) => s.ops.features({ persist: on }), { refresh: false });
  }

  /**
   * The disk budget for stored features per session, in MB (null means unlimited). It applies to the open session at
   * once, where a lower budget can evict features, and to other sessions when they open. Resolves
   * to how many feature files the open session evicted.
   */
  async function setFeatureDiskMB(mb: number | null): Promise<number> {
    const featureDiskMB = asFeatureDiskMB(mb === null ? featureDiskPref(null) : mb);
    settings.setState({ featureDiskMB });
    storage.prefs.set(PREF.featureDiskMB, featureDiskPref(featureDiskMB));
    const res = await r.run("Feature disk budget", (s) => s.ops.features({ diskMB: featureDiskMB ?? "unlimited" }), {
      refresh: false,
    });
    if (res?.evicted) await loadClips();
    return res?.evicted ?? 0;
  }

  /** Measures on demand, because it reads every file's size. */
  async function storageSummary(): Promise<StorageSummary | null> {
    const res = await storage.usage();
    if (res.isErr()) r.report(res.error);
    return res.map((u) => summarizeStorage(u, openOpfs())).unwrapOr(null);
  }

  /** Deletes stored image features: the open session's through the engine, and every other OPFS session's from here. */
  async function clearFeatures(): Promise<number> {
    const mine = await r.run("Dropping features", (s) => s.ops.features({ clear: true }), { refresh: false });
    const others = await storage.clearFeatures(openOpfs());
    if (others.isErr()) r.report(others.error);
    await loadClips();
    return (mine?.cleared ?? 0) + others.unwrapOr(0);
  }

  /**
   * Deletes one browser session's stored features, keeping detections and labels. The open one goes through its engine.
   */
  async function dropSessionFeatures(name: string): Promise<number> {
    if (name === openOpfs()) {
      const res = await r.run("Dropping features", (s) => s.ops.features({ clear: true }), { refresh: false });
      await loadClips();
      return res?.cleared ?? 0;
    }
    const res = await storage.clearSessionFeatures(name);
    if (res.isErr()) r.report(res.error);
    return res.unwrapOr(0);
  }

  /** Deletes one clip's stored features in the open session, keeping detections and labels. */
  async function dropClipFeatures(c: Pick<Clip, "key" | "name">): Promise<number> {
    const res = await r.run(`Dropping features of ${c.name}`, (s) => s.ops.features({ clear: true, clip: c.key }), {
      refresh: false,
    });
    await loadClips();
    return res?.cleared ?? 0;
  }

  /** A session setting (session.json "config"); the engine checks the key and value. */
  async function setSetting(key: ConfigKey, value: number) {
    const res = await r.run(`Setting ${key}`, (s) => s.ops.config({ key, value }));
    if (res) engine.setState({ config: res.config });
    if (res && key === "threshold") ctx.stores.layers.setState({ threshold: res.config.threshold });
    return res;
  }

  async function exportManifest() {
    const res = await r.run("Export manifest", (s) => s.ops.manifest({}), { refresh: false });
    if (!res) return undefined;
    const { image: _image, ...m } = res;
    const name = `eyespy-${engine.getState().label || "session"}-manifest.json`;
    host.download(name, JSON.stringify(m, null, 1) + "\n", "application/json");
    return m;
  }

  return {
    setPersistFeatures,
    setFeatureDiskMB,
    /** Applies when a session opens or reopens. */
    setFeatureCacheMB: (mb: number) => {
      const featureCacheMB = asFeatureCacheMB(mb);
      settings.setState({ featureCacheMB });
      storage.prefs.set(PREF.featureCacheMB, String(featureCacheMB));
    },
    setDetector: (detector: Detector) => {
      settings.setState({ detector });
      storage.prefs.set(PREF.detector, detector);
    },
    openSettings: (open: boolean) => settings.setState({ open }),
    storageSummary,
    clearFeatures,
    dropSessionFeatures,
    dropClipFeatures,
    setSetting,
    exportManifest,
  };
}
