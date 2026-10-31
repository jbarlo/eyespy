/**
 * Sessions, their data and videos. Each open starts a fresh engine. The generation check disposes a start that finishes
 * after the session closed or another open began, before anyone sees it.
 */
import { ResultAsync, ok } from "neverthrow";
import type { Result } from "neverthrow";
import { SAM_LICENSE_REFUSED } from "../../protocol.ts";
import { applyEvent, isFailureLog } from "../engine.ts";
import { nearestFrame } from "../frames.ts";
import type { EngineError, EngineEvent, EyespyApi, WebGpu } from "../ports.ts";
import { once } from "../once.cache.ts";
import { createPoller } from "../poll.cache.ts";
import { refKey } from "../selectors.ts";
import { PREF } from "../settings.ts";
import { keep, keepRows } from "../share.ts";
import { SESSION_SCOPED } from "../stores.ts";
import type { AddResult, Clip, SessionLocation } from "../types.ts";
import { sessionOf } from "./context.ts";
import type { Ctx, Failure } from "./context.ts";
import type { LicenceActions } from "./licence.ts";
import type { Runner } from "./run.ts";
import type { TriageActions } from "./triage.ts";

const POLL_MS = 2500;
/** The engine error for automation (window.eyespyReady rejects with it); the page explains it in full. */
const NO_WEBGPU_ERROR = {
  "no-webgpu": "This browser has no WebGPU, which the models need",
  "no-adapter": "This browser has WebGPU but gave the page no GPU adapter",
} as const satisfies Record<Exclude<WebGpu, "available">, string>;
const labelOf = (loc: SessionLocation) => ("opfs" in loc ? loc.opfs : loc.dir.name);

export function createSessionActions(ctx: Ctx, r: Runner, triageActions: TriageActions, licence: LicenceActions) {
  const { engine, frames, detections, objects, selection, notices, settings, layers, triage } = ctx.stores;
  const { deps, assets } = ctx;

  const current = (g: number) => engine.getState().generation === g;
  /** The open session's status poll (the handle lives here, not in a store). */
  const poll = createPoller(deps.clock, POLL_MS);
  /** Whether this browser can run the models, asked of the browser on the first open only. */
  const webgpu = once(deps.host.webgpu);

  function onEvent(g: number, ev: EngineEvent) {
    if (!current(g)) return;
    engine.setState((s) => applyEvent(s, ev));
    // a refused SAM 3 file (licence not agreed) is what the licence banner already says, not a failure to toast
    if (ev.kind === "log" && isFailureLog(ev.text) && !ev.text.includes(SAM_LICENSE_REFUSED))
      r.notify(ev.text.split("\n")[0] ?? ev.text);
    if (ev.kind === "unsupported") {
      const { kind: _, ...video } = ev;
      notices.setState({ unsupported: video });
    }
  }

  function closeUnsupported() {
    notices.setState({ unsupported: null });
  }

  /**
   * Dispose the open engine and reset everything that belonged to its session. The generation goes up and never back,
   * so a start still in flight fails its check.
   */
  function closeSession() {
    poll.stop();
    engine.getState().session?.dispose();
    assets.reset();
    const { clipsWatched } = frames.getState(); // the Videos panel stays open across sessions
    const { generation } = engine.getState();
    for (const k of SESSION_SCOPED) ctx.stores[k].reset();
    frames.setState({ clipsWatched });
    engine.setState({ generation: generation + 1 });
  }

  async function refresh(): Promise<void> {
    const s = sessionOf(ctx);
    if (!s) return;
    const res = await ResultAsync.combine([
      s.ops.status(),
      s.ops.data.dets({ mask: "none" }),
      s.ops.data.objects(),
      s.ops.data.runs(),
      s.ops.data.history(),
    ] as const);
    if (sessionOf(ctx) !== s) return;
    if (res.isErr()) return r.report(res.error);
    const [status, d, o, runs, history] = res.value;
    // replies equal to what the stores hold keep the old references (no redraw, no panel re-render)
    engine.setState((e) => ({ status: keep(e.status, status) }));
    detections.setState((x) => ({
      dets: keepRows(x.dets, d.dets, (r) => r.id),
      runs: keepRows(x.runs, runs.runs, (r) => `${r.frame}|${r.prompt}`),
    }));
    objects.setState((x) => ({
      objects: keepRows(x.objects, o.objects, (r) => r.id),
      history: keep(x.history, history),
    }));
    // the Videos panel's counts follow edits while it's open; sizes read every file, so other refreshes skip them
    if (frames.getState().clipsWatched) void loadClips();
  }

  async function loadSession(): Promise<Result<void, EngineError>> {
    const s = sessionOf(ctx);
    if (!s) return ok(undefined);
    const res = await ResultAsync.combine([s.ops.data.frames(), s.ops.config()] as const);
    if (sessionOf(ctx) !== s) return ok(undefined);
    if (res.isErr()) return res.map(() => undefined);
    const [fr, cfg] = res.value;
    frames.setState((f) => ({
      frames: keepRows(f.frames, fr.frames, (x) => x.frame),
      current: fr.frames.some((x) => x.frame === f.current) ? f.current : nearestFrame(fr.frames, f.current),
    }));
    engine.setState({ config: cfg.config });
    layers.setState({ threshold: cfg.config.threshold ?? 0.5 });
    await refresh();
    return ok(undefined);
  }

  /** While keyframes are still encoding, poll status (encode progress) and the frames' encoded flags. */
  function startPolling() {
    const tick = async () => {
      const { session: s, status: st } = engine.getState();
      if (!s || !st || st.encoded >= st.keyframes || notices.getState().busy.length) return;
      const res = await ResultAsync.combine([s.ops.status(), s.ops.data.frames()] as const);
      if (sessionOf(ctx) !== s || res.isErr()) return; // the next tick retries a missed one
      const [status, fr] = res.value;
      engine.setState((e) => ({ status: keep(e.status, status) }));
      // only frames whose encoded flag flipped are new rows; unchanged ticks keep `frames` (no refit, no redraw)
      frames.setState((f) => ({ frames: keepRows(f.frames, fr.frames, (x) => x.frame) }));
    };
    poll.start(() => void tick());
  }

  async function loadClips(): Promise<void> {
    const s = sessionOf(ctx);
    if (!s) return;
    const res = await s.ops.clips.list({});
    if (sessionOf(ctx) !== s) return;
    if (res.isErr()) return r.report(res.error);
    frames.setState({ clips: res.value.clips });
  }

  /**
   * Starts (or switches to) a session on a fresh engine worker. Resolves to window.eyespy's API, null on failure.
   * Without WebGPU nothing starts and nobody is asked about the licence: the phase says why, and the page explains it.
   */
  async function openSession(loc: SessionLocation, label?: string): Promise<EyespyApi | null> {
    const knownGpu = webgpu();
    const gpu = typeof knownGpu === "string" ? knownGpu : await knownGpu;
    if (gpu !== "available") {
      closeSession();
      engine.setState({ phase: gpu, error: NO_WEBGPU_ERROR[gpu] });
      return null;
    }
    // ask about the SAM License next, so no engine starts (and no model downloads or loads from cache) before the
    // answer. When both answers are known this is synchronous, so a switch resets the old session at once
    const known = licence.ensureLicence();
    const samLicenseAgreed = typeof known === "boolean" ? known : await known;
    closeSession();
    const g = engine.getState().generation;
    engine.setState({
      phase: "starting",
      label: label ?? labelOf(loc),
      kind: "opfs" in loc ? "opfs" : "folder",
      location: loc,
    });
    const { detector, persistFeatures, featureDiskMB, featureCacheMB } = settings.getState();
    const opened = await deps.engine.open({
      session: loc,
      samLicenseAgreed,
      detector,
      persistFeatures,
      featureDiskMB,
      featureCacheMB,
      onEvent: (ev) => onEvent(g, ev),
    });
    if (!current(g)) {
      if (opened.isOk()) opened.value.dispose();
      return null;
    }
    const failed = (e: Failure) => {
      engine.setState({ phase: "failed", error: e.message });
      r.notify(e.message);
      return null;
    };
    if (opened.isErr()) return failed(opened.error);
    const s = opened.value;
    engine.setState({ session: s });
    assets.attach(s.file);
    if ("opfs" in loc) deps.storage.prefs.set(PREF.session, loc.opfs);
    const loaded = await loadSession();
    if (!current(g)) return null;
    if (loaded.isErr()) return failed(loaded.error);
    engine.setState({ phase: "ready" });
    void loadClips();
    startPolling();
    if (settings.getState().persisted === null) void requestPersist();
    return s.api;
  }

  /**
   * Asks the browser to protect the site's storage from eviction, once per page load on the first open and again from
   * the settings dialog. Labels and detections exist only in this storage, while the app can fetch models again and
   * re-encode features.
   */
  async function requestPersist(): Promise<boolean> {
    const res = await deps.storage.persist();
    const persisted = res.unwrapOr(false);
    settings.setState({ persisted });
    return persisted;
  }

  /**
   * The licence banner's "Review" button. Shows the dialog again; "I agree" restarts the open session with the models.
   */
  async function reviewLicence(): Promise<void> {
    if (!(await licence.askLicence())) return;
    const { location, label } = engine.getState();
    if (location) await openSession(location, label);
  }

  async function listSessions(): Promise<readonly string[]> {
    const res = await deps.storage.listSessions();
    return res.unwrapOr([]);
  }

  /**
   * Adds a video to the open session. For a video the browser can't decode, only the can't-decode dialog shows, with no
   * notice, because the worker's "unsupported" event arrives before the add fails.
   */
  async function addVideo(file: File): Promise<"added" | "unsupported" | "failed"> {
    const before = notices.getState().unsupported;
    const unsupported = () => notices.getState().unsupported !== before && !!notices.getState().unsupported;
    const added = await r.run(
      `Adding ${file.name}`,
      async (s): Promise<Result<AddResult, Failure>> => {
        const a = await s.addFile(file);
        if (a.isErr()) return a;
        const loaded = await loadSession();
        return loaded.map(() => a.value);
      },
      { quiet: unsupported },
    );
    if (added?.revived)
      r.notify(
        `${file.name} was removed earlier: it is back at keyframes #${added.first}–#${added.first + added.keyframes - 1}, without its old detections.`,
        true,
      );
    await loadClips();
    return added ? "added" : unsupported() ? "unsupported" : "failed";
  }

  /**
   * Creates an OPFS session named after the video, then adds the video. When the browser can't decode the video, this
   * deletes the new empty session and reopens the previous one, leaving only the can't-decode dialog.
   */
  async function newSessionFromVideo(file: File) {
    const { location: prev, label: prevLabel } = engine.getState();
    const stem =
      file.name
        .replace(/\.[^.]*$/, "")
        .replace(/[^\w.-]+/g, "_")
        .slice(0, 40) || "video";
    const existing = new Set(await listSessions());
    const free = (n: number): string => {
      const name = n === 1 ? stem : `${stem}-${n}`;
      return existing.has(name) ? free(n + 1) : name;
    };
    const name = free(1);
    const api = await openSession({ opfs: name });
    if (!api || (await addVideo(file)) !== "unsupported") return;
    // its engine must release the folder first, so go back to the previous session (or none), then delete the new one
    if (prev) await openSession(prev, prevLabel);
    else closeSession();
    const now = engine.getState().location;
    if (now && "opfs" in now && now.opfs === name) return; // the user opened it again in the meantime
    const res = await deps.storage.deleteSession(name);
    if (res.isErr()) r.report(res.error);
  }

  /** Removes a video after an in-page confirmation. No undo, but adding the same file again restores its keyframes. */
  async function removeClip(c: Clip) {
    const what = [
      c.detections ? `${c.detections} detections` : "",
      c.objects ? `its sightings in ${c.objects} object${c.objects === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    const msg =
      `Remove ${c.name} (keyframes #${c.frames[0]}–#${c.frames[1]}) from this session?` +
      (what ? ` This deletes ${what}; objects seen only in this video are deleted.` : "") +
      " It can't be undone; adding the same video again brings its keyframes back (same numbers), without the detections.";
    if (!(await r.ask(msg, "Remove video"))) return undefined;
    const removed = await r.run(`Removing ${c.name}`, async (s) => {
      const res = await s.ops.clips.remove({ clip: c.key });
      if (res.isErr()) return res;
      const loaded = await loadSession();
      return loaded.map(() => res.value);
    });
    if (removed) {
      const [lo, hi] = removed.frames;
      const gone = (f: number) => f >= lo && f <= hi;
      const dets = ctx.select.detById();
      detections.setState((d) => ({
        masks: new Map([...d.masks].filter(([id]) => dets.has(id))),
        maskFrames: new Set([...d.maskFrames].filter((f) => !gone(f))),
      }));
      selection.setState((s) => ({
        ids: s.ids.filter((id) => dets.has(id)),
        obj: s.obj && ctx.select.objById().has(s.obj) ? s.obj : null,
        searchResult: null,
        searchRect: null,
        matches: null,
        similar: null,
      }));
      const images = new Set(frames.getState().frames.flatMap((f) => ctx.select.frameKey(f.frame) ?? []));
      const heat = new Set(detections.getState().runs.flatMap((x) => refKey(x.semantic) ?? []));
      assets.prune(images, new Set(dets.keys()), heat);
      const page = triage.getState().page;
      if (page) void triageActions.loadGroup(page.offset);
    }
    await loadClips();
    return removed;
  }

  async function openFolder() {
    const pick = deps.host.pickDirectory;
    if (!pick) return;
    const res = await pick();
    if (res.isErr()) return r.report(res.error);
    if (res.value) await openSession({ dir: res.value });
  }

  return {
    openSession,
    closeSession,
    refresh,
    loadSession,
    loadClips,
    listSessions,
    addVideo,
    closeUnsupported,
    newSessionFromVideo,
    removeClip,
    openFolder,
    requestPersist,
    reviewLicence,
    canPickFolder: deps.host.pickDirectory !== null,
    initialSession: () => deps.query.get("session") ?? deps.storage.prefs.get(PREF.session) ?? "default",
  };
}
