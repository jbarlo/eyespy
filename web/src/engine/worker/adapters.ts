/** The browser's session adapters for EngineHost.init (tests pass fakes). */
import type { SessionAdapters, OpenAdapters } from "./host.ts";
import { DownloadCache } from "./cache.ts";
import { guardSamModels } from "./licence.ts";
import { CanvasCodec } from "./codec.ts";
import { WebModelRuntime } from "./models.ts";
import { DirStore } from "./store.ts";
import { WebVideo } from "./video.ts";

export const openBrowserAdapters: OpenAdapters = async (o, { emit }): Promise<SessionAdapters> => {
  let dir: FileSystemDirectoryHandle, root: string;
  if ("opfs" in o.session) {
    const sessions = await (await navigator.storage.getDirectory()).getDirectoryHandle("sessions", { create: true });
    dir = await sessions.getDirectoryHandle(o.session.opfs, { create: true });
    root = `opfs:sessions/${o.session.opfs}`;
  } else {
    dir = o.session.dir;
    root = dir.name;
  }
  const cache = new DownloadCache(emit);
  const web = new WebModelRuntime(o.models, o.runtime.ortWasm, cache);
  const runtime = guardSamModels(web, Object.keys(o.models), o.samLicenseAgreed === true);
  const device = await web.probeAdapter();
  const store = await DirStore.openOrInit(dir, root);
  const video = new WebVideo({ emit });
  return {
    root,
    device,
    ports: { runtime, store, video, codec: new CanvasCodec() },
    register: (file) => video.register(file),
    prepare: (names) => runtime.prepare(names),
  };
};
