/**
 * Main-thread browser adapters for the state ports, including the OPFS outside the open session. They turn host
 * exceptions into `{kind: "host"}` Errs.
 */
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import { isFeatureDir } from "eyespy-core/storage/pure";
import type { WebGpu } from "./state/ports.ts";

type HostError = { readonly kind: "host"; readonly message: string };
export type Dir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

const hostError = (e: unknown): HostError => ({ kind: "host", message: e instanceof Error ? e.message : String(e) });

const PREFIX = "eyespy.";
const browserPrefs = {
  get(k: string) {
    try {
      return localStorage.getItem(PREFIX + k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(PREFIX + k, v);
    } catch {}
  },
};

const root = async () => (await navigator.storage.getDirectory()) as Dir;
const sub = async (name: string) => (await (await root()).getDirectoryHandle(name, { create: true })) as Dir;

type Sizes = { readonly total: number; readonly features: number };

/**
 * Bytes under a folder, and how many of them are in clips' feature folders.
 * `at` is the folder's path below its session root, or null outside a session.
 */
async function sizes(d: Dir, at: readonly string[] | null, inFeat: boolean): Promise<Sizes> {
  let total = 0,
    features = 0;
  for await (const [name, h] of d.entries()) {
    if (h.kind === "file") {
      const n = (await (h as FileSystemFileHandle).getFile()).size;
      total += n;
      if (inFeat) features += n;
    } else {
      const path = at && [...at, name];
      const s = await sizes(h as Dir, path, inFeat || (path !== null && isFeatureDir(path)));
      total += s.total;
      features += s.features;
    }
  }
  return { total, features };
}

type SessionSizes = Sizes & { readonly name: string };

/**
 * Each OPFS session's size, and how much of it is re-encodable features, by session name. Loose files beside the
 * session folders are not sessions, so the result leaves them out.
 * @internal
 */
export async function sessionsUsage(sessions: Dir): Promise<readonly SessionSizes[]> {
  const out: SessionSizes[] = [];
  for await (const [name, h] of sessions.entries())
    if (h.kind === "directory") out.push({ name, ...(await sizes(h as Dir, [], false)) });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Removes every feature folder below a session folder (`at`, its path below the root) and returns the count. */
async function removeFeatureDirs(d: Dir, at: readonly string[]): Promise<number> {
  let removed = 0;
  for await (const [name, h] of d.entries()) {
    if (h.kind !== "directory") continue;
    const path = [...at, name];
    if (!isFeatureDir(path)) removed += await removeFeatureDirs(h as Dir, path);
    else
      try {
        await d.removeEntry(name, { recursive: true });
        removed++;
      } catch {} // another tab's engine is using it, so skip it
  }
  return removed;
}

/**
 * Deletes the stored features of the sessions in `sessions` that `which` picks, and returns how many feature folders it
 * removed. Callers leave out the open session, whose engine deletes its own.
 * @internal
 */
export async function clearFeaturesIn(sessions: Dir, which: (name: string) => boolean): Promise<number> {
  let removed = 0;
  for await (const [name, s] of sessions.entries())
    if (s.kind === "directory" && which(name)) removed += await removeFeatureDirs(s as Dir, []);
  return removed;
}

async function listSessions(): Promise<readonly string[]> {
  const out: string[] = [];
  for await (const [name, h] of (await sub("sessions")).entries()) if (h.kind === "directory") out.push(name);
  return out.sort();
}

/** Removes a session folder, with retries, since a just-terminated engine worker may still hold its files open. */
async function deleteSession(name: string): Promise<void> {
  const sessions = await sub("sessions");
  for (let attempt = 0; ; attempt++)
    try {
      return await sessions.removeEntry(name, { recursive: true });
    } catch (e) {
      if ((e as Error).name === "NotFoundError") return;
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
}

async function usage() {
  const est = await navigator.storage.estimate();
  const [models, sessions] = await Promise.all([sizes(await sub("models"), null, false), sub("sessions")]);
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return {
    usage: est.usage ?? 0,
    quota: est.quota ?? 0,
    models: models.total,
    sessions: await sessionsUsage(sessions),
    persisted,
  };
}

const clearIn = (which: (name: string) => boolean) =>
  ResultAsync.fromPromise(
    sub("sessions").then((s) => clearFeaturesIn(s, which)),
    hostError,
  );

export const browserStorage = {
  prefs: browserPrefs,
  listSessions: () => ResultAsync.fromPromise(listSessions(), hostError),
  usage: () => ResultAsync.fromPromise(usage(), hostError),
  clearFeatures: (keep: string | null) => clearIn((name) => name !== keep),
  clearSessionFeatures: (name: string) => clearIn((n) => n === name),
  deleteSession: (name: string) => ResultAsync.fromPromise(deleteSession(name), hostError),
  persist: () => ResultAsync.fromPromise(navigator.storage.persist?.() ?? Promise.resolve(false), hostError),
};

/** The part of navigator.gpu the check uses. */
type Gpu = { readonly requestAdapter: (o: { powerPreference: "high-performance" }) => Promise<unknown> };

/**
 * What `gpu` (navigator.gpu) offers: no API, an API that gives no adapter (null, or a throw), or an adapter. It asks
 * the way the engine does, so the answer matches what the engine gets.
 * @internal
 */
export async function webgpuIn(gpu: Gpu | undefined): Promise<WebGpu> {
  if (!gpu) return "no-webgpu";
  try {
    return (await gpu.requestAdapter({ powerPreference: "high-performance" })) ? "available" : "no-adapter";
  } catch {
    return "no-adapter";
  }
}

type Picker = (o: object) => Promise<FileSystemDirectoryHandle>;
const picker = (globalThis as { showDirectoryPicker?: Picker }).showDirectoryPicker;

export const browserHost = {
  /** The native folder picker; resolves null when the user cancels. */
  pickDirectory: picker
    ? () =>
        ResultAsync.fromPromise(picker({ mode: "readwrite" }), (e) => e).orElse((e) =>
          e instanceof DOMException && e.name === "AbortError"
            ? okAsync<FileSystemDirectoryHandle | null, HostError>(null)
            : errAsync<FileSystemDirectoryHandle | null, HostError>(hostError(e)),
        )
    : null,
  webgpu: () => webgpuIn((navigator as { gpu?: Gpu }).gpu),
  download(name: string, text: string, type: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  },
};

export const browserClock = {
  every: (ms: number, fn: () => void) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
  after: (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
