/** The engine worker entry: one EngineHost over the browser adapters. Models, video and the session store live here. */
import type { FromWorker } from "../../protocol.ts";
import { openBrowserAdapters } from "./adapters.ts";
import { EngineHost } from "./host.ts";

// typed as a worker scope without pulling lib.webworker (which clashes with lib.dom in one program)
const scope = self as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

const host = new EngineHost((m: FromWorker, transfer) => scope.postMessage(m, transfer ?? []), openBrowserAdapters);
scope.onmessage = (e: MessageEvent) => void host.handle(e.data);
