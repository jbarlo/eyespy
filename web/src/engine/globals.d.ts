/** The engine-level page globals, shared by the app and the ?debug page. */
import type { EngineEvent, EyespyApi } from "./port.ts";

declare global {
  interface Window {
    /** The open session's router ops as JSON. */
    eyespy?: EyespyApi;
    /** Resolves with window.eyespy once the first session is open. */
    eyespyReady?: Promise<EyespyApi>;
    /** Engine events, oldest first. */
    eyespyEvents: EngineEvent[];
  }
}

export {};
