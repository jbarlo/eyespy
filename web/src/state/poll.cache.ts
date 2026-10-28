/**
 * A repeating poll that owns its cancel handle. At most one runs. start() replaces the running one and stop() cancels
 * it. The handle is this file's mutable state, so the stores hold data only.
 */
import type { Clock } from "./ports.ts";

export type Poller = { readonly start: (fn: () => void) => void; readonly stop: () => void };

export function createPoller(clock: Clock, ms: number): Poller {
  let cancel: (() => void) | null = null;
  const stop = () => {
    cancel?.();
    cancel = null;
  };
  return {
    start: (fn) => {
      stop();
      cancel = clock.every(ms, fn);
    },
    stop,
  };
}
