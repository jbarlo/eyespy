/**
 * The session module wires the other modules into the eyespy session the api serves. It owns Config, the
 * per-request Ctx, the use cases that span modules, and the actor.
 */
export type { Ctx } from "./pure.ts";
export type * from "./types.ts";
export { createSession } from "./internal/session.ts";
export { createEngine } from "./actor.ts";
/** Labelling shapes that appear in replies, re-exported so api, which imports only session, can type them. */
export type { HistoryView, ObjectSummary, ReplayFailure } from "../labelling/index.ts";
